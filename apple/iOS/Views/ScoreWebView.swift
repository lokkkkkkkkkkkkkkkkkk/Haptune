import SwiftUI
import WebKit

/// Talks to score.html (Verovio engraver) inside a WKWebView.
@MainActor
final class ScoreBridge: NSObject, ObservableObject, WKScriptMessageHandler {
    @Published private(set) var ready = false
    @Published private(set) var loaded = false
    @Published private(set) var pages = 0
    @Published var tappedQuarter: Double?
    weak var webView: WKWebView?
    private var pendingXML: String?

    func load(musicXML: String) {
        pendingXML = musicXML
        if ready { flush() }
    }

    private func flush() {
        guard let xml = pendingXML, let lit = jsString(xml) else { return }
        pendingXML = nil
        webView?.evaluateJavaScript("WM.load(\(lit))")
    }

    func cursor(quarter: Double) { webView?.evaluateJavaScript("WM.cursorAt(\(quarter))") }

    func mark(quarter: Double, midi: Int?, kind: String) {
        let m = midi.map { String($0) } ?? "null"
        webView?.evaluateJavaScript("WM.mark(\(quarter), \(m), '\(kind)')")
    }

    func clearMarks() { webView?.evaluateJavaScript("WM.clearMarks()") }

    private func jsString(_ s: String) -> String? {
        (try? JSONEncoder().encode(s)).map { String(decoding: $0, as: UTF8.self) }
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let pages = body["pages"] as? Int
        let quarter = body["quarter"] as? Double
        Task { @MainActor in
            switch type {
            case "ready": self.ready = true; self.flush()
            case "loaded": self.loaded = true; self.pages = pages ?? 1
            case "tap": self.tappedQuarter = quarter
            default: break
            }
        }
    }
}

struct ScoreWebView: UIViewRepresentable {
    @ObservedObject var bridge: ScoreBridge
    let musicXML: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakHandler(bridge), name: "wm")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .white
        web.scrollView.contentInsetAdjustmentBehavior = .never
        bridge.webView = web
        if let page = Bundle.main.url(forResource: "score", withExtension: "html") {
            web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        }
        bridge.load(musicXML: musicXML)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    /// Avoids the WKUserContentController -> handler retain cycle.
    final class WeakHandler: NSObject, WKScriptMessageHandler {
        weak var target: ScoreBridge?
        init(_ t: ScoreBridge) { target = t }
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            target?.userContentController(c, didReceive: m)
        }
    }
}
