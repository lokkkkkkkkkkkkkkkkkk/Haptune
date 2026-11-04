import Foundation

/// Real-time score follower: microphone samples in (mono, 22.05 kHz), Watch feedback events out.
/// Swift port of engine/haptune/follower.py (same thresholds; see that file for the reasoning).
///
///  * follow: the cursor follows the player's own tempo
///  * wait:   the score waits until the correct note is played
///  * tempo:  judged against the (silent, haptic) metronome grid
public final class ScoreFollower {
    public enum Mode: String, Codable, Sendable, CaseIterable { case follow, wait, tempo }
    public enum Level: String, Codable, Sendable, CaseIterable { case beginner, intermediate, advanced }
    public enum NoteResult: String, Codable, Sendable { case correct, wrong, missed }

    public let score: PracticeScore
    public let profile: InstrumentProfile
    public let mode: Mode
    public let events: [PracticeScore.Event]
    public private(set) var cursor = 0
    public private(set) var passes = 0
    public private(set) var results: [String: NoteResult] = [:]
    public private(set) var log: [FeedbackEvent] = []
    public private(set) var buzzed: [FeedbackEvent] = []
    public var qpm: Double
    public var metronomeStart: Double = 0
    public var a4: Double

    private let sr = DSP.sampleRate
    private let hop = DSP.hop
    private let levelTol: Double
    private let loop: ClosedRange<Int>?
    private var gate: HapticGate
    private var passErrors = 0
    private var matched: [(beat: Double, time: Double)] = []
    private var devs: [Int] = []
    private var spbHistory: [Double] = []
    private var recentPlayed: [[Int]] = []
    private var mismatchRun = 0

    // audio
    private var buffer: [Double] = []
    private var consumed = 0           // samples dropped from the left of `buffer`
    private var pos = 0                // absolute sample index of the current hop end
    private let need: Int
    private var rmsPeak = 1e-4

    // mono
    private let yin: DSP.YIN
    private var mono = MonoState()

    // onsets / poly
    private let fft2048 = DSP.FFT(size: 2048)
    private let fft4096 = DSP.FFT(size: 4096)
    private let win2048 = DSP.hann(2048)
    private let win4096 = DSP.hann(4096)
    private let bank2048 = DSP.LogFreqBank(fftSize: 2048, binsPerSemitone: 3, midiLow: 28, midiHigh: 116)
    private lazy var bank4096 = DSP.LogFreqBank(fftSize: 4096)
    private var prevLogSpec: [Double]?
    private var fluxHistory: [Double] = []
    private var lastOnsetTime = -1.0
    private var noiseFloor: Double?
    private var pending: [(due: Int, t0: Double, tries: Int)] = []
    private var spectra: [(pos: Int, spec: [Double])] = []
    private var hopEnergy: [(t: Double, e: Double)] = []
    private var lastEvalOnset = -1.0
    private var templates: [Int: [Double]] = [:]
    private lazy var noiseTemplates: [[Double]] = {
        [40.0, 70.0, 100.0].map { k in
            let row = self.bank4096.centers.map { exp(-0.5 * pow(($0 - k) / 18, 2)) }
            let n = row.reduce(0) { $0 + $1 * $1 }.squareRoot()
            return row.map { $0 / max(n, 1e-12) }
        }
    }()

    struct MonoState {
        var semitone: Int?
        var start = 0.0
        var pendingStart = 0.0
        var midis: [Double] = []
        var peakRMS = 0.0
        var dipped = false
        var pending: Int?
        var pendingCount = 0
        var unvoiced = 0
        var intonationDone = false
        var matchedExpected: Int?
        var noteID: String?
    }

    public init(score: PracticeScore, instrument: InstrumentProfile, mode: Mode = .follow, qpm: Double? = nil,
                a4: Double = 440, sensitivity: HapticGate.Sensitivity = .normal, loop: ClosedRange<Int>? = nil,
                level: Level = .intermediate) {
        self.score = score
        self.profile = instrument
        self.mode = mode
        self.qpm = qpm ?? score.firstTempo
        self.a4 = a4
        self.gate = HapticGate(sensitivity: sensitivity)
        self.levelTol = [Level.beginner: 1.6, .intermediate: 1.0, .advanced: 0.7][level] ?? 1
        self.loop = loop
        var evs = score.events()
        if !instrument.isRhythm {
            evs = evs.compactMap { e in
                var e = e
                e.notes = e.notes.filter { $0.pitch == nil || (instrument.low...instrument.high).contains($0.pitch!) }
                return e.notes.isEmpty ? nil : e
            }
        }
        if let l = loop { evs = evs.filter { l.contains($0.measure) } }
        self.events = evs
        let y = DSP.YIN(fMin: instrument.fMin, fMax: instrument.fMax)
        yin = y
        need = max(y.windowLength, 4096)
    }

    // MARK: API

    public var now: Double { Double(pos) / sr }
    public var currentEvent: PracticeScore.Event? { cursor < events.count ? events[cursor] : nil }
    public var isFinished: Bool { cursor >= events.count }

    /// Feed microphone samples. Returns the events that should buzz the Watch right now.
    @discardableResult
    public func push(_ samples: [Float]) -> [FeedbackEvent] {
        buffer.append(contentsOf: samples.map { Double($0) })
        var out: [FeedbackEvent] = []
        let endAbs = consumed + buffer.count
        while pos + hop <= endAbs {
            pos += hop
            if pos - consumed >= need { out += frame() }
        }
        let keep = need + hop
        if buffer.count > 4 * keep {
            let drop = buffer.count - keep
            buffer.removeFirst(drop)
            consumed += drop
        }
        return out
    }

    public func summary() -> (correct: Int, wrong: Int, missed: Int, total: Int) {
        let vals = Array(results.values)
        return (vals.filter { $0 == .correct }.count, vals.filter { $0 == .wrong }.count,
                vals.filter { $0 == .missed }.count, events.reduce(0) { $0 + $1.notes.count })
    }

    // MARK: frames

    private func window(_ n: Int) -> ArraySlice<Double> {
        let end = pos - consumed
        return buffer[max(0, end - n)..<end]
    }

    private func frame() -> [FeedbackEvent] {
        if profile.isPoly { return framePoly() }
        if profile.isRhythm { return frameRhythm() }
        return frameMono()
    }

    private func emit(_ ev: FeedbackEvent) -> [FeedbackEvent] {
        var e = ev
        if let m = e.measure { e.measureLabel = score.measureLabel(m) }
        log.append(e)
        if e.kind == .wrongNote || e.kind == .missedNote { passErrors += 1 }
        if gate.allow(e) { buzzed.append(e); return [e] }
        return []
    }

    // MARK: mono

    private func frameMono() -> [FeedbackEvent] {
        let seg = Array(window(yin.windowLength))
        let t = (Double(pos) - Double(yin.tauMax) - Double(yin.W) / 2) / sr
        let r = yin.analyse(seg)
        rmsPeak = max(rmsPeak * 0.9995, r.rms)
        let f0 = r.hz
        let voiced = r.cmnd < 0.35 && r.rms > max(1e-4, 0.03 * rmsPeak) && f0 >= profile.fMin * 0.95 && f0 <= profile.fMax * 1.05
        var out: [FeedbackEvent] = []
        if !voiced {
            mono.unvoiced += 1
            if mono.unvoiced >= 3 && mono.semitone != nil { mono = MonoState() }
            return out
        }
        mono.unvoiced = 0
        let m = Pitch.midi(hz: f0, a4: a4)
        let semi = nearestSemitone(m)
        var settle = profile.vibrato ? 5 : 3
        if !isExpected(semi) {
            settle = max(settle, Int((0.09 * sr / Double(hop)).rounded()))
            if r.cmnd > 0.25 || r.rms < 0.25 * rmsPeak { mono.pending = nil; mono.pendingCount = 0; return out }
        }
        if mono.semitone == nil {
            if mono.pending == semi { mono.pendingCount += 1 } else { mono.pending = semi; mono.pendingCount = 1; mono.start = t }
            if mono.pendingCount >= settle {
                mono.semitone = semi; mono.midis = [m]; mono.peakRMS = r.rms
                out += match([semi], at: mono.start, mono: true)
            }
            return out
        }
        if abs(m - Double(mono.semitone!)) > 0.62 {
            if mono.pending == semi { mono.pendingCount += 1 }
            else { mono.pending = semi; mono.pendingCount = 1; mono.dipped = false; mono.pendingStart = t }
            if mono.pendingCount >= settle {
                let start = mono.pendingStart
                mono = MonoState(semitone: semi, start: start, midis: [m], peakRMS: r.rms)
                out += match([semi], at: start, mono: true)
            }
            return out
        }
        mono.pending = nil; mono.pendingCount = 0
        mono.midis.append(m)
        if r.rms < 0.5 * mono.peakRMS && t - mono.start > profile.minNoteMs / 1000 {
            mono.dipped = true
        } else if mono.dipped && r.rms > 0.75 * mono.peakRMS {
            mono = MonoState(semitone: semi, start: t, midis: [m], peakRMS: r.rms)
            return out + match([semi], at: t, mono: true)
        }
        mono.peakRMS = max(mono.peakRMS, r.rms)
        if profile.intonation, !mono.intonationDone, let exp = mono.matchedExpected, t - mono.start >= 0.16, mono.midis.count >= 8 {
            mono.intonationDone = true
            let skip = Int(0.06 * sr / Double(hop))
            let settled = mono.midis.count > 6 ? Array(mono.midis.dropFirst(min(skip, mono.midis.count - 1))) : mono.midis
            let cents = (median(settled) - Double(exp)) * 100
            if abs(cents) > profile.centsWarn {
                out += emit(FeedbackEvent(cents > 0 ? .sharp : .flat, time: round3(t),
                                          measure: events.isEmpty ? nil : events[max(0, cursor - 1)].measure,
                                          noteID: mono.noteID, expected: exp, played: semi, cents: (cents * 10).rounded() / 10,
                                          text: String(format: "%+.0f¢", cents)))
            }
        }
        return out
    }

    private func isExpected(_ semi: Int) -> Bool {
        guard cursor < events.count else { return true }
        let lo = max(0, cursor - 1), hi = min(events.count, cursor + 3)
        return events[lo..<hi].contains { $0.pitches.contains(semi) }
    }

    private func nearestSemitone(_ m: Double) -> Int {
        if profile.intonation && cursor < events.count {
            for e in events[cursor..<min(events.count, cursor + 2)] {
                for p in e.pitches where abs(m - Double(p)) < 0.75 { return p }
            }
        }
        return Int(m.rounded())
    }

    // MARK: onsets (poly + rhythm)

    private func logSpec(_ frame: ArraySlice<Double>) -> [Double] {
        let mag = fft2048.magnitude(Array(frame), window: win2048)
        let bands = bank2048.apply(mag)
        let ref = rmsPeak * 2048 + 1e-9
        return bands.map { log1p(100 * $0 / ref) }
    }

    private func detectOnset() -> Double? {
        let w = window(2048)
        let tail = w.suffix(512)
        let rms = (tail.reduce(0) { $0 + $1 * $1 } / Double(max(1, tail.count))).squareRoot()
        rmsPeak = max(rmsPeak * 0.9995, rms)
        let ls = logSpec(w)
        var flux = 0.0
        if let prev = prevLogSpec {
            for i in 0..<ls.count {
                let ref = max(prev[max(0, i - 1)], prev[i], prev[min(prev.count - 1, i + 1)])
                flux += max(0, ls[i] - ref)
            }
        }
        prevLogSpec = ls
        fluxHistory.append(flux)
        if fluxHistory.count > 40 { fluxHistory.removeFirst() }
        if var nf = noiseFloor {
            if rms < nf { nf = 0.9 * nf + 0.1 * rms } else { nf *= 1.0008 }
            noiseFloor = max(nf, 1e-6)
        } else { noiseFloor = max(rms, 1e-6) }
        let h = fluxHistory
        guard h.count >= 4 else { return nil }
        let a = h[h.count - 3], b = h[h.count - 2], c = h[h.count - 1]
        let base = h.count > 6 ? h.dropLast(2).reduce(0, +) / Double(h.count - 2) : 0
        let peak = max(h.max() ?? 0, 1e-9)
        let t = (Double(pos) - 1024) / sr - Double(hop) / sr + 0.019
        let loud = rms > 0.08 * rmsPeak && rms > 5 * (noiseFloor ?? 0) && h.count >= 8
        if loud && b > a && b >= c && b > base + 0.12 * peak && b > 1 && t - lastOnsetTime > 0.05 {
            lastOnsetTime = t
            return t
        }
        return nil
    }

    private func frameRhythm() -> [FeedbackEvent] {
        guard let t = detectOnset() else { return [] }
        return match([], at: t, mono: false)
    }

    private func refineOnset(_ guess: Double) -> Double {
        let hist = hopEnergy.filter { abs($0.t - guess) <= 0.15 }
        guard let level = hist.map({ $0.e }).max(), level > 0 else { return guess }
        if let first = hist.first(where: { $0.e >= 0.5 * level }) { return first.t - Double(hop) / (2 * sr) }
        return guess
    }

    private func spectrumBefore(_ t: Double) -> [Double]? {
        let target = Int((t - 0.03) * sr)
        return spectra.last(where: { $0.pos <= target })?.spec
    }

    private func framePoly() -> [FeedbackEvent] {
        var out: [FeedbackEvent] = []
        let hopSeg = window(hop)
        hopEnergy.append((Double(pos) / sr, (hopSeg.reduce(0) { $0 + $1 * $1 } / Double(max(1, hopSeg.count))).squareRoot()))
        if hopEnergy.count > 64 { hopEnergy.removeFirst() }
        let tOn = detectOnset()
        var spec: [Double]?
        let w4 = window(4096)
        if w4.count == 4096 && (tOn != nil || !pending.isEmpty || pos % (hop * 2) == 0) {
            let s = fft4096.magnitude(Array(w4), window: win4096)
            spec = s
            spectra.append((pos, s))
            if spectra.count > 40 { spectra.removeFirst() }
        }
        if let t0 = tOn { pending.append((pos + 7 * hop, t0, 0)) }
        var still: [(due: Int, t0: Double, tries: Int)] = []
        for item in pending {
            if item.due > pos { still.append(item); continue }
            let tAtt = refineOnset(item.t0)
            if Double(pos) / sr - tAtt < 0.075 && item.tries < 4 { still.append((pos + 2 * hop, item.t0, item.tries + 1)); continue }
            if abs(tAtt - lastEvalOnset) < 0.06 { continue }
            lastEvalOnset = tAtt
            let s = spec ?? fft4096.magnitude(Array(w4), window: win4096)
            let played = polyPitches(s, pre: spectrumBefore(tAtt))
            if !played.isEmpty { out += match(played, at: round4(tAtt), mono: false) }
        }
        pending = still
        return out
    }

    private func template(_ p: Int) -> [Double] {
        if let t = templates[p] { return t }
        let B = profile.family == "keyboard" ? 2.5e-4 : 2e-5
        let t = DSP.harmonicTemplate(pitch: p, centers: bank4096.centers, harmonics: 12, inharmonicity: B, slope: 1.1)
        templates[p] = t
        return t
    }

    /// Score-informed chord check: tiny NMF over {expected pitches +-2 semitones, noise}.
    private func polyPitches(_ spec: [Double], pre: [Double]?) -> Set<Int> {
        let look = events[cursor..<min(events.count, cursor + 2)]
        guard !look.isEmpty else { return [] }
        let expected = Set(look.flatMap { $0.pitches })
        var candSet = Set<Int>()
        for p in expected { for d in -2...2 where (profile.low - 2...profile.high + 2).contains(p + d) { candSet.insert(p + d) } }
        let cands = candSet.sorted()
        let W = cands.map { template($0) } + noiseTemplates
        let v = bank4096.apply(spec).map { pow($0, 0.8) + 1e-9 }
        let vp = (pre.map { bank4096.apply($0) } ?? [Double](repeating: 0, count: v.count)).map { pow($0, 0.8) + 1e-9 }
        let H = DSP.nmfActivations(V: [v, vp], W: W, iterations: 40)
        var act: [Int: Double] = [:], actPre: [Int: Double] = [:]
        for (i, q) in cands.enumerated() { act[q] = H[0][i]; actPre[q] = H[1][i] }
        let top = (act.values.max() ?? 0) + 1e-12
        var played = Set<Int>()
        for p in expected { if let a = act[p], a >= 0.25 * top, a > 1.15 * (actPre[p] ?? 0) { played.insert(p) } }
        for q in cands where !expected.contains(q) {
            let near = expected.filter { abs($0 - q) <= 2 && act[$0] != nil }
            guard let bestExp = near.compactMap({ act[$0] }).max(), let a = act[q] else { continue }
            if a >= 0.5 * top && a > 1.5 * (actPre[q] ?? 0) && a > 2 * bestExp { played.insert(q) }
        }
        return played
    }

    // MARK: matching

    private func expectedTime(_ beat: Double) -> (Double?, Double) {
        let spb = 60 / qpm
        if mode == .tempo { return (metronomeStart + beat * spb, spb) }
        if matched.count >= 3 {
            let recent = matched.suffix(5)
            let bs = recent.map { $0.beat }, ts = recent.map { $0.time }
            if let lo = bs.min(), let hi = bs.max(), hi > lo {
                let mb = bs.reduce(0, +) / Double(bs.count), mt = ts.reduce(0, +) / Double(ts.count)
                var num = 0.0, den = 0.0
                for (b, t) in zip(bs, ts) { num += (b - mb) * (t - mt); den += (b - mb) * (b - mb) }
                var slope = num / den
                slope = min(5 * spb, max(0.2 * spb, slope))
                return (mt + slope * (beat - mb), slope)
            }
        }
        return (nil, spb)
    }

    private func timing(_ e: PracticeScore.Event, t: Double) -> [FeedbackEvent] {
        let (exp, spb) = expectedTime(e.onset)
        guard let expected = exp else { return [] }
        let dev = t - expected
        let tol = max(0.06, 0.12 * spb) * levelTol
        var sign = 0
        if mode == .tempo {
            sign = abs(dev) <= tol ? 0 : (dev < 0 ? -1 : 1)
        } else {
            spbHistory.append(spb)
            let ref = spbHistory.count >= 4 ? median(Array(spbHistory.suffix(40))) : 60 / qpm
            let ratio = ref / max(spb, 1e-6)
            let thr = 0.12 * levelTol
            sign = ratio > 1 + thr ? -1 : (ratio < 1 - thr ? 1 : 0)
        }
        devs.append(sign)
        if devs.count > 3 { devs.removeFirst() }
        if sign == -1 && devs.filter({ $0 == -1 }).count >= 2 {
            devs.removeAll()
            return emit(FeedbackEvent(.rushing, time: round3(t), measure: e.measure, noteID: e.notes.first?.id, text: "rushing"))
        }
        if sign == 1 && devs.filter({ $0 == 1 }).count >= 2 {
            devs.removeAll()
            return emit(FeedbackEvent(.dragging, time: round3(t), measure: e.measure, noteID: e.notes.first?.id, text: "dragging"))
        }
        return []
    }

    private func advance(to k: Int, t: Double) -> [FeedbackEvent] {
        var out: [FeedbackEvent] = []
        for skipped in events[cursor..<k] {
            for n in skipped.notes where results[n.id] == nil { results[n.id] = .missed }
            out += emit(FeedbackEvent(.missedNote, time: round3(t), measure: skipped.measure, noteID: skipped.notes.first?.id,
                                      expected: skipped.pitches.first,
                                      text: skipped.pitches.first.map { NoteName.name($0) } ?? "missed"))
        }
        cursor = k
        return out
    }

    private func finishPassIfDone(_ t: Double) -> [FeedbackEvent] {
        guard cursor >= events.count else { return [] }
        var out: [FeedbackEvent] = []
        if passErrors == 0 { out += emit(FeedbackEvent(.sectionClean, time: round3(t), text: "clean!")) }
        passes += 1
        if loop != nil { cursor = 0; passErrors = 0; matched.removeAll() }
        return out
    }

    private func match(_ played: Set<Int>, at t: Double, mono isMono: Bool) -> [FeedbackEvent] {
        var out: [FeedbackEvent] = []
        guard cursor < events.count else { return out }
        let rhythm = profile.isRhythm, poly = profile.isPoly
        if mode == .tempo && !rhythm {
            let beatNow = (t - metronomeStart) / (60 / qpm)
            let range = cursor..<min(events.count, cursor + 6)
            if let kBest = range.min(by: { abs(events[$0].onset - beatNow) < abs(events[$1].onset - beatNow) }), kBest > cursor {
                out += advance(to: kBest, t: t)
            }
        }
        func hit(_ k: Int) -> Bool {
            let e = events[k]
            if rhythm { return true }
            let need = Set(e.pitches)
            if poly { return need.intersection(played).count >= max(1, Int(ceil(0.6 * Double(need.count)))) }
            return !need.intersection(played).isEmpty
        }
        var kHit = (cursor..<min(events.count, cursor + 3)).first(where: hit)
        if let k = kHit, k > cursor, mode != .wait {
            let (expT, spb) = expectedTime(events[cursor].onset)
            if let e = expT, t < e - 0.5 * spb { kHit = hit(cursor) ? cursor : nil }
            else if expT == nil, let last = matched.last,
                    t - last.time < 0.6 * (events[cursor].onset - last.beat) * 60 / qpm { kHit = nil }
        }
        if let k = kHit {
            if k > cursor { out += advance(to: k, t: t) }
            let e = events[cursor]
            let exp = Set(e.pitches)
            let missing = (rhythm || !poly) ? [] : exp.subtracting(played).sorted()
            let wrong = (rhythm || !poly) ? [] : played.subtracting(exp).sorted()
            for n in e.notes { results[n.id] = (rhythm || (n.pitch.map { played.contains($0) } ?? false)) ? .correct : .missed }
            if let w = wrong.first {
                out += emit(FeedbackEvent(.wrongNote, time: round3(t), measure: e.measure, noteID: e.notes.first?.id,
                                          expected: missing.first, played: w,
                                          text: NoteName.name(missing.first ?? w)))
            } else if let m = missing.first, missing.count >= max(1, e.pitches.count / 2), mode == .wait {
                out += emit(FeedbackEvent(.missedNote, time: round3(t), measure: e.measure, noteID: e.notes.first?.id,
                                          expected: m, text: NoteName.name(m)))
            }
            if isMono {
                mono.matchedExpected = played.intersection(exp).first
                mono.noteID = e.notes.first?.id
            }
            out += timing(e, t: t)
            matched.append((e.onset, t)); if matched.count > 8 { matched.removeFirst() }
            remember(played)
            mismatchRun = 0
            cursor += 1
            out += finishPassIfDone(t)
            return out
        }
        // no match
        let e = events[cursor]
        if cursor > 0, let last = matched.last {
            let prev = events[cursor - 1]
            let (_, spb) = expectedTime(e.onset)
            let prevLen = (e.onset - prev.onset) * spb
            let since = t - last.time
            let same = !played.intersection(prev.pitches).isEmpty
            let octave = played.contains { q in prev.pitches.contains { p in (q - p) % 12 == 0 && q != p } }
            if (same && since < 0.75 * prevLen) || (octave && since < prevLen + 0.3) { return out }
        }
        mismatchRun += 1
        remember(played)
        let expP = e.pitches.first
        let pl = played.min(by: { abs($0 - (expP ?? $0)) < abs($1 - (expP ?? $1)) })
        let close = expP != nil && pl != nil && abs(pl! - expP!) <= 2
        if mode == .wait || close || mismatchRun == 1 {
            for n in e.notes where results[n.id] == nil { results[n.id] = .wrong }
            out += emit(FeedbackEvent(.wrongNote, time: round3(t), measure: e.measure, noteID: e.notes.first?.id,
                                      expected: expP, played: pl, text: expP.map { NoteName.name($0) } ?? "?"))
            if isMono { mono.matchedExpected = nil }
            if mode != .wait && close {
                matched.append((e.onset, t)); if matched.count > 8 { matched.removeFirst() }
                cursor += 1
                out += finishPassIfDone(t)
            }
            return out
        }
        if mismatchRun >= 3 { relocate() }
        return out
    }

    private func remember(_ played: Set<Int>) {
        recentPlayed.append(played.sorted())
        if recentPlayed.count > 6 { recentPlayed.removeFirst() }
    }

    /// The player jumped (restarted a bar, skipped a line): find where the last notes fit best.
    private func relocate() {
        let seq = Array(recentPlayed.filter { !$0.isEmpty }.suffix(4))
        guard seq.count >= 3, events.count >= seq.count else { return }
        var best = 0, bestK: Int?
        for k in 0...(events.count - seq.count) {
            var s = 0
            for (j, ps) in seq.enumerated() where !Set(ps).intersection(events[k + j].pitches).isEmpty { s += 1 }
            if s > best { best = s; bestK = k }
        }
        if let k = bestK, best >= seq.count - 1 {
            cursor = k + seq.count
            matched.removeAll()
            mismatchRun = 0
            log.append(FeedbackEvent(.jump, time: round3(now), measure: events[min(k, events.count - 1)].measure))
        }
    }

    // MARK: helpers

    private func median(_ x: [Double]) -> Double {
        guard !x.isEmpty else { return 0 }
        let s = x.sorted()
        return s.count % 2 == 1 ? s[s.count / 2] : 0.5 * (s[s.count / 2 - 1] + s[s.count / 2])
    }
    private func round3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }
    private func round4(_ x: Double) -> Double { (x * 10000).rounded() / 10000 }
}
