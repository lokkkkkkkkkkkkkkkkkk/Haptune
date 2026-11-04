import AVFoundation
import PracticeCore
import SwiftUI

// MARK: - Tools tab (like Health's Browse list)

struct ToolsView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { TunerView() } label: {
                        row("Tuner", "tuningfork", .purple, "Note, cents and your open strings")
                    }
                    NavigationLink { MetronomeView() } label: {
                        row("Metronome", "metronome", .orange, "Clicks on the phone, taps on your wrist")
                    }
                    NavigationLink { ScalesView() } label: {
                        row("Scales & Arpeggios", "stairs", .indigo, "Exam-style exercises for your instrument")
                    }
                }
                Section {
                    NavigationLink { HistoryView(metric: .time) } label: {
                        row("Practice History", "calendar", .pink, "Every take, with charts")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Tools")
        }
    }

    private func row(_ title: LocalizedStringKey, _ symbol: String, _ color: Color, _ detail: LocalizedStringKey) -> some View {
        HStack(spacing: 12) {
            IconBadge(symbol: symbol, color: color, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Tuner

@MainActor
final class TunerModel: ObservableObject {
    @Published var note = "–"
    @Published var cents = 0.0
    @Published var hz = 0.0
    @Published var stringHint = ""
    @Published var running = false
    private let mic = MicrophoneStream()
    private var buffer: [Double] = []
    private var yin: DSP.YIN?

    func start(profile: InstrumentProfile, a4: Double) {
        let y = DSP.YIN(fMin: profile.fMin, fMax: profile.fMax)
        yin = y
        buffer = []
        mic.onSamples = { [weak self] s in
            Task { @MainActor in self?.feed(s, profile: profile, a4: a4) }
        }
        Task {
            guard await MicrophoneStream.requestPermission() else { running = false; return }
            do { try mic.start(); running = true } catch { running = false }
        }
    }

    func stop() { mic.stop(); mic.onSamples = nil; running = false }

    private func feed(_ s: [Float], profile: InstrumentProfile, a4: Double) {
        guard let yin else { return }
        buffer.append(contentsOf: s.map { Double($0) })
        guard buffer.count >= yin.windowLength else { return }
        let r = yin.analyse(Array(buffer.suffix(yin.windowLength)))
        buffer = Array(buffer.suffix(yin.windowLength))
        guard r.cmnd < 0.2, r.rms > 0.003 else { return }
        let m = Pitch.midi(hz: r.hz, a4: a4)
        let n = Int(m.rounded())
        hz = r.hz
        note = NoteName.name(n)
        cents = cents * 0.6 + (m - Double(n)) * 100 * 0.4         // smooth the needle
        if let s = profile.openStrings.min(by: { abs(Double($0) - m) < abs(Double($1) - m) }), abs(Double(s) - m) < 1.5 {
            stringHint = String(localized: "\(NoteName.name(s)) string \(String(format: "%+.0f", (m - Double(s)) * 100))¢")
        } else {
            stringHint = ""
        }
    }
}

struct TunerView: View {
    @EnvironmentObject var settings: AppSettings
    @StateObject private var model = TunerModel()

    private var inTune: Bool { abs(model.cents) <= settings.instrument.centsOK }

    var body: some View {
        VStack(spacing: 28) {
            Spacer(minLength: 0)
            Text(model.note)
                .font(.system(size: 96, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(model.running && inTune ? Color.green : Color.primary)
                .contentTransition(.numericText())
            Gauge(value: max(-50, min(50, model.cents)), in: -50...50) {
                Text("cents")
            } currentValueLabel: {
                Text(verbatim: String(format: "%+.0f¢", model.cents))
            } minimumValueLabel: {
                Text(verbatim: "♭")
            } maximumValueLabel: {
                Text(verbatim: "♯")
            }
            .gaugeStyle(.accessoryLinear)
            .tint(Gradient(colors: [.orange, .green, .orange]))
            .padding(.horizontal, 32)
            Text(model.stringHint.isEmpty ? " " : model.stringHint).font(.title3).foregroundStyle(.secondary)
            Text(verbatim: String(format: "%.1f Hz · A4 = %.0f Hz", model.hz, settings.a4))
                .font(.footnote).foregroundStyle(.tertiary)
            Spacer(minLength: 0)
            Button {
                model.running ? model.stop() : model.start(profile: settings.instrument, a4: settings.a4)
            } label: {
                Group { if model.running { Text("Stop") } else { Text("Start Tuner") } }.frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding()
        .navigationTitle(settings.instrument.name)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { model.stop() }
    }
}

// MARK: - Metronome (phone clicks + Watch taps)

@MainActor
final class ClickMetronome: ObservableObject {
    @Published var bpm = 80.0 { didSet { if running { restart() } } }
    @Published var beatsPerBar = 4 { didSet { if running { restart() } } }
    @Published var silent = false { didSet { player.volume = silent ? 0 : 1 } }
    @Published private(set) var running = false
    @Published private(set) var beat = 0
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var timer: Timer?
    private var startedAt = Date()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!

    init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    /// One bar of audio (accented first click), looped seamlessly by the player.
    private func barBuffer() -> AVAudioPCMBuffer? {
        let sr = format.sampleRate
        let beatFrames = Int(sr * 60 / max(20, bpm))
        let frames = beatFrames * max(1, beatsPerBar)
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let ch = buf.floatChannelData?[0] else { return nil }
        buf.frameLength = AVAudioFrameCount(frames)
        for i in 0..<frames { ch[i] = 0 }
        for b in 0..<max(1, beatsPerBar) {
            let f = b == 0 ? 1760.0 : 1320.0
            let n = min(Int(sr * 0.03), beatFrames)
            for i in 0..<n {
                let t = Double(i) / sr
                ch[b * beatFrames + i] = Float(sin(2 * .pi * f * t) * exp(-t * 120) * (b == 0 ? 0.9 : 0.6))
            }
        }
        return buf
    }

    func start() {
        guard let buf = barBuffer() else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? s.setActive(true)
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch { return }
        }
        player.stop()
        player.scheduleBuffer(buf, at: nil, options: .loops)
        player.volume = silent ? 0 : 1
        player.play()
        startedAt = Date()
        running = true
        beat = 0
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        WatchLink.shared.send(WatchEnvelope(kind: .metronome, metronome: .init(enabled: true, bpm: bpm, beatsPerBar: beatsPerBar,
                                                                              startAt: startedAt, countInBeats: 0)))
    }

    func stop() {
        player.stop()
        timer?.invalidate()
        timer = nil
        running = false
        WatchLink.shared.send(WatchEnvelope(kind: .metronome, metronome: .init(enabled: false, bpm: bpm, beatsPerBar: beatsPerBar,
                                                                              startAt: Date(), countInBeats: 0)))
    }

    private func restart() { stop(); start() }

    private func tick() {
        let beats = Int(Date().timeIntervalSince(startedAt) * bpm / 60)
        if beats != beat { beat = beats }
    }
}

struct MetronomeView: View {
    @StateObject private var metro = ClickMetronome()
    @State private var taps: [Date] = []

    var body: some View {
        VStack(spacing: 26) {
            HStack(spacing: 12) {
                ForEach(0..<metro.beatsPerBar, id: \.self) { i in
                    Circle()
                        .fill(metro.running && metro.beat % metro.beatsPerBar == i ? (i == 0 ? Color.orange : Color.accentColor)
                              : Color(uiColor: .tertiarySystemFill))
                        .frame(width: 22, height: 22)
                }
            }
            .animation(.easeOut(duration: 0.08), value: metro.beat)
            VStack(spacing: 0) {
                Text(verbatim: "\(Int(metro.bpm))")
                    .font(.system(size: 88, weight: .bold, design: .rounded)).monospacedDigit()
                Text("BPM").font(.headline).foregroundStyle(.secondary)
            }
            Slider(value: $metro.bpm, in: 30...240, step: 1).padding(.horizontal, 24)
            HStack(spacing: 16) {
                Stepper("Beats per bar: \(metro.beatsPerBar)", value: $metro.beatsPerBar, in: 1...12)
            }
            .padding(.horizontal, 24)
            Toggle(isOn: $metro.silent) {
                Label("Silent (Apple Watch taps only)", systemImage: "applewatch")
            }
            .padding(.horizontal, 24)
            HStack(spacing: 16) {
                Button("Tap Tempo") { tap() }.buttonStyle(.bordered).controlSize(.large)
                Button { metro.running ? metro.stop() : metro.start() } label: {
                    Group { if metro.running { Text("Stop") } else { Text("Start") } }.frame(minWidth: 120)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 24)
        .navigationTitle("Metronome")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { metro.stop() }
    }

    private func tap() {
        let now = Date()
        taps = (taps + [now]).filter { now.timeIntervalSince($0) < 3 }
        guard taps.count >= 2 else { return }
        let gaps = zip(taps.dropFirst(), taps).map { $0.timeIntervalSince($1) }
        let avg = gaps.reduce(0, +) / Double(gaps.count)
        if avg > 0 { metro.bpm = min(240, max(30, (60 / avg).rounded())) }
    }
}

// MARK: - Scales & arpeggios

struct ScalesView: View {
    var asSheet = false
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var library: Library
    @EnvironmentObject var router: Router
    @Environment(\.dismiss) private var dismiss
    @State private var tonic = "D"
    @State private var kind = "major"
    @State private var octaves = 2
    @State private var qpm = 80.0
    @State private var added: String?

    var body: some View {
        Form {
            Section {
                Picker("Key", selection: $tonic) {
                    ForEach(["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"], id: \.self) { Text(verbatim: $0) }
                }
                Picker("Type", selection: $kind) {
                    ForEach(Exercises.patterns.keys.sorted(), id: \.self) { k in Text(Self.kindName(k)).tag(k) }
                }
                Stepper("Octaves: \(octaves)", value: $octaves, in: 1...4)
                Stepper("Tempo: \(Int(qpm)) BPM", value: $qpm, in: 40...200, step: 4)
            } footer: {
                Text("Two notes per beat, up and back down, in the range of your instrument (\(settings.instrument.name)).")
            }
            Section {
                Button {
                    let s = Exercises.scale(tonic: tonic, kind: kind, octaves: octaves, instrument: settings.instrument, qpm: qpm)
                    if let item = try? library.add(score: s, musicXML: MusicXMLWriter.write(s), instrument: settings.instrumentKey, kind: "exercise") {
                        added = s.title
                        if asSheet {
                            dismiss()
                            router.libraryPath = [item]
                        }
                    }
                } label: {
                    Label("Add to Library", systemImage: "plus.circle.fill")
                }
                if let added {
                    Label("\(added) is in your library.", systemImage: "checkmark.circle").foregroundStyle(.green)
                }
            }
        }
        .navigationTitle("Scales & Arpeggios")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if asSheet { Button("Cancel") { dismiss() } }
            }
        }
    }

    static func kindName(_ k: String) -> LocalizedStringKey {
        switch k {
        case "major": return "Major scale"
        case "natural_minor": return "Natural minor scale"
        case "harmonic_minor": return "Harmonic minor scale"
        case "melodic_minor": return "Melodic minor scale"
        case "major_pentatonic": return "Major pentatonic"
        case "minor_pentatonic": return "Minor pentatonic"
        case "blues": return "Blues scale"
        case "chromatic": return "Chromatic scale"
        case "major_arpeggio": return "Major arpeggio"
        case "minor_arpeggio": return "Minor arpeggio"
        case "dominant7_arpeggio": return "Dominant 7th arpeggio"
        case "diminished7_arpeggio": return "Diminished 7th arpeggio"
        default: return LocalizedStringKey(k)
        }
    }
}
