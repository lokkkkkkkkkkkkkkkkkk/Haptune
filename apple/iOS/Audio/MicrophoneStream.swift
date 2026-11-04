import AVFoundation
import Foundation

/// Microphone -> 22.05 kHz mono Float32 chunks (the engine's analysis rate).
/// Uses the `.measurement` mode so iOS does not apply automatic gain / noise suppression,
/// which would distort pitch and dynamics. Optionally records the converted take to a file
/// so it can be sent to the server for the full report.
final class MicrophoneStream {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 22050, channels: 1, interleaved: false)!
    private var file: AVAudioFile?
    private(set) var isRunning = false

    /// Called on the audio thread; hop work elsewhere.
    var onSamples: (([Float]) -> Void)?

    static func requestPermission() async -> Bool {
        await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    func start(recordingTo url: URL? = nil) throws {
        guard !isRunning else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try session.setActive(true)
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { throw NSError(domain: "Mic", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input"]) }
        converter = AVAudioConverter(from: inFormat, to: target)
        if let url { file = try AVAudioFile(forWriting: url, settings: target.settings) }
        input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        try engine.start()
        isRunning = true
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        file = nil
        isRunning = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let ch = out.floatChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        try? file?.write(from: out)
        onSamples?(samples)
    }
}
