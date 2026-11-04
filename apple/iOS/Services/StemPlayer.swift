import AVFoundation
import Foundation

/// Plays the parts of a band split together, like a small mixer: volume, mute and solo per part,
/// and slow-down without changing pitch (AVAudioUnitTimePitch). Also the "band" you practise with.
@MainActor
final class StemPlayer: ObservableObject {
    struct Track {
        let id: String
        let node: AVAudioPlayerNode
        let file: AVAudioFile
    }

    @Published private(set) var isPlaying = false
    @Published private(set) var position: Double = 0
    @Published private(set) var duration: Double = 0
    @Published var muted: Set<String> = [] { didSet { applyGains() } }
    @Published var solo: String? { didSet { applyGains() } }
    @Published var volumes: [String: Float] = [:] { didSet { applyGains() } }
    @Published var rate: Float = 1.0 { didSet { timePitch.rate = max(0.25, min(2, rate)) } }

    private let engine = AVAudioEngine()
    private let submix = AVAudioMixerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private var tracks: [Track] = []
    private var startPosition: Double = 0
    private var timer: Timer?

    init() {
        engine.attach(submix)
        engine.attach(timePitch)
        engine.connect(submix, to: timePitch, format: nil)
        engine.connect(timePitch, to: engine.mainMixerNode, format: nil)
    }

    var isLoaded: Bool { !tracks.isEmpty }

    func load(_ stems: [(id: String, url: URL)]) {
        stop()
        for t in tracks { engine.detach(t.node) }
        tracks = []
        var longest = 0.0
        for s in stems {
            guard let f = try? AVAudioFile(forReading: s.url) else { continue }
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: submix, format: f.processingFormat)
            tracks.append(Track(id: s.id, node: node, file: f))
            longest = max(longest, Double(f.length) / f.processingFormat.sampleRate)
        }
        duration = longest
        position = 0
        applyGains()
    }

    /// Starts every part at the same host time, `delay` seconds from now.
    func play(from seconds: Double? = nil, delay: Double = 0.05) {
        guard !tracks.isEmpty else { return }
        configureSession()
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch { return }
        }
        let from = max(0, min(seconds ?? position, duration))
        for t in tracks {
            t.node.stop()
            let sr = t.file.processingFormat.sampleRate
            let startFrame = AVAudioFramePosition(from * sr)
            let remaining = t.file.length - startFrame
            guard remaining > 0 else { continue }
            t.node.scheduleSegment(t.file, startingFrame: startFrame, frameCount: AVAudioFrameCount(remaining), at: nil)
        }
        let start = AVAudioTime(hostTime: mach_absolute_time() + AVAudioTime.hostTime(forSeconds: max(0, delay)))
        for t in tracks { t.node.play(at: start) }
        startPosition = from
        isPlaying = true
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func pause() {
        guard isPlaying else { return }
        updatePosition()
        for t in tracks { t.node.stop() }
        isPlaying = false
        timer?.invalidate()
        timer = nil
    }

    func stop() {
        pause()
        position = 0
    }

    func toggle() { isPlaying ? pause() : play() }

    func seek(to seconds: Double) {
        let wasPlaying = isPlaying
        if wasPlaying { pause() }
        position = max(0, min(duration, seconds))
        if wasPlaying { play(from: position) }
    }

    private func updatePosition() {
        guard let t = tracks.first, let nodeTime = t.node.lastRenderTime,
              let pt = t.node.playerTime(forNodeTime: nodeTime) else { return }
        let played = Double(pt.sampleTime) / pt.sampleRate
        position = min(duration, startPosition + max(0, played))
    }

    private func tick() {
        guard isPlaying else { return }
        updatePosition()
        if position >= duration - 0.05 {
            for t in tracks { t.node.stop() }
            isPlaying = false
            timer?.invalidate()
            timer = nil
            position = duration
        }
    }

    private func applyGains() {
        for t in tracks {
            let base = volumes[t.id] ?? 1
            let audible: Bool
            if let solo { audible = solo == t.id } else { audible = !muted.contains(t.id) }
            t.node.volume = audible ? base : 0
        }
    }

    private func configureSession() {
        let s = AVAudioSession.sharedInstance()
        if s.category != .playAndRecord {
            try? s.setCategory(.playback, mode: .default)
        }
        try? s.setActive(true)
    }
}
