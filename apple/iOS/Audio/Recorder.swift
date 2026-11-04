import AVFoundation
import Foundation

/// Records a song or a band (44.1 kHz AAC) for Band Split: a live rehearsal, or a track playing on
/// another speaker. Shows a level meter while recording.
@MainActor
final class Recorder: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var level: Double = 0          // 0...1
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private(set) var url: URL?

    func start() async -> Bool {
        guard await MicrophoneStream.requestPermission() else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch { return false }
        let f = FileManager.default.temporaryDirectory.appendingPathComponent("Recording \(Int(Date().timeIntervalSince1970)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        guard let r = try? AVAudioRecorder(url: f, settings: settings) else { return false }
        r.isMeteringEnabled = true
        guard r.record() else { return false }
        recorder = r
        url = f
        isRecording = true
        elapsed = 0
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        return true
    }

    @discardableResult
    func stop() -> URL? {
        recorder?.stop()
        recorder = nil
        timer?.invalidate()
        timer = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return url
    }

    private func tick() {
        guard let r = recorder else { return }
        r.updateMeters()
        elapsed = r.currentTime
        let db = Double(r.averagePower(forChannel: 0))          // -160...0 dBFS
        level = max(0, min(1, (db + 50) / 50))
    }
}
