import Foundation
#if canImport(WatchConnectivity) && !targetEnvironment(macCatalyst)
import WatchConnectivity
#endif

/// iPhone side of the iPhone <-> Watch link. On iPad and Mac there is no paired Watch, so every
/// call is a harmless no-op there.
@MainActor
final class WatchLink: NSObject, ObservableObject {
    static let shared = WatchLink()

    @Published private(set) var isPaired = false
    @Published private(set) var isWatchAppInstalled = false
    @Published private(set) var isReachable = false
    var onCommand: ((WatchEnvelope.Command) -> Void)?

    /// True on a device that can pair with an Apple Watch (iPhone).
    nonisolated static var isSupported: Bool {
        #if canImport(WatchConnectivity) && !targetEnvironment(macCatalyst)
        return WCSession.isSupported()
        #else
        return false
        #endif
    }

    func activate() {
        #if canImport(WatchConnectivity) && !targetEnvironment(macCatalyst)
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        #endif
    }

    /// Low-latency path when the Watch app is in the foreground; session state also goes into the
    /// application context so the Watch picks it up when it wakes.
    nonisolated func send(_ env: WatchEnvelope) {
        #if canImport(WatchConnectivity) && !targetEnvironment(macCatalyst)
        guard WCSession.isSupported(), let data = env.encoded() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        if s.isReachable {
            s.sendMessageData(data, replyHandler: nil, errorHandler: nil)
        }
        if env.kind == .session || env.kind == .metronome {
            try? s.updateApplicationContext([env.kind.rawValue: data])
        }
        #endif
    }

    #if canImport(WatchConnectivity) && !targetEnvironment(macCatalyst)
    private func refresh(_ s: WCSession) {
        isPaired = s.isPaired
        isWatchAppInstalled = s.isWatchAppInstalled
        isReachable = s.isReachable
    }
    #endif
}

#if canImport(WatchConnectivity) && !targetEnvironment(macCatalyst)
extension WatchLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.refresh(session) }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    nonisolated func sessionWatchStateDidChange(_ session: WCSession) { Task { @MainActor in self.refresh(session) } }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) { Task { @MainActor in self.refresh(session) } }
    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let env = WatchEnvelope.decode(messageData), let c = env.command else { return }
        Task { @MainActor in self.onCommand?(c) }
    }
}
#endif
