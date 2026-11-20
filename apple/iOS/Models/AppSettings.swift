import Foundation
import PracticeCore
import SwiftUI

/// Languages the app ships with. "System" follows the iPhone's language.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system, english = "en", simplifiedChinese = "zh-Hans", traditionalChinese = "zh-Hant", malay = "ms"

    var id: String { rawValue }

    /// Shown in each language's own script, like the iOS language list.
    var nativeName: String {
        switch self {
        case .system: return String(localized: "System")
        case .english: return "English"
        case .simplifiedChinese: return "简体中文"
        case .traditionalChinese: return "繁體中文"
        case .malay: return "Bahasa Melayu"
        }
    }

    var locale: Locale { self == .system ? .autoupdatingCurrent : Locale(identifier: rawValue) }
}

/// User settings. @Published + UserDefaults (an @AppStorage inside an ObservableObject would not
/// notify the views that depend on it).
@MainActor
final class AppSettings: ObservableObject {
    private let d = UserDefaults.standard

    @Published var instrumentKey: String { didSet { d.set(instrumentKey, forKey: "instrument") } }
    @Published var a4: Double { didSet { d.set(a4, forKey: "a4") } }
    @Published var sensitivityRaw: String { didSet { d.set(sensitivityRaw, forKey: "sensitivity") } }
    @Published var levelRaw: String { didSet { d.set(levelRaw, forKey: "level") } }
    @Published var serverURL: String { didSet { d.set(serverURL, forKey: "serverURL") } }
    @Published var countInBars: Int { didSet { d.set(countInBars, forKey: "countInBars") } }
    @Published var dailyGoalMinutes: Int { didSet { d.set(dailyGoalMinutes, forKey: "dailyGoal") } }
    @Published var displayName: String { didSet { d.set(displayName, forKey: "displayName") } }
    @Published var iCloudSync: Bool { didSet { d.set(iCloudSync, forKey: "iCloudSync") } }
    @Published var reminderOn: Bool { didSet { d.set(reminderOn, forKey: "reminderOn") } }
    @Published var reminderMinutes: Int { didSet { d.set(reminderMinutes, forKey: "reminderMinutes") } }   // minutes after midnight
    @Published var language: AppLanguage {
        didSet {
            d.set(language.rawValue, forKey: "language")
            // takes full effect (system alerts, number formats) at the next launch; SwiftUI text switches now
            if language == .system { d.removeObject(forKey: "AppleLanguages") } else { d.set([language.rawValue], forKey: "AppleLanguages") }
        }
    }

    init() {
        let d = UserDefaults.standard          // local: `self` is not usable until every property is set
        instrumentKey = d.string(forKey: "instrument") ?? "violin"
        a4 = d.object(forKey: "a4") as? Double ?? 440
        sensitivityRaw = d.string(forKey: "sensitivity") ?? HapticGate.Sensitivity.normal.rawValue
        levelRaw = d.string(forKey: "level") ?? ScoreFollower.Level.intermediate.rawValue
        serverURL = d.string(forKey: "serverURL") ?? ""
        countInBars = d.object(forKey: "countInBars") as? Int ?? 1
        dailyGoalMinutes = d.object(forKey: "dailyGoal") as? Int ?? 20
        displayName = d.string(forKey: "displayName") ?? ""
        iCloudSync = d.object(forKey: "iCloudSync") as? Bool ?? true
        reminderOn = d.bool(forKey: "reminderOn")
        reminderMinutes = d.object(forKey: "reminderMinutes") as? Int ?? 19 * 60
        language = AppLanguage(rawValue: d.string(forKey: "language") ?? "system") ?? .system
    }

    var instrument: InstrumentProfile { InstrumentLibrary.profile(instrumentKey) }
    var sensitivity: HapticGate.Sensitivity { HapticGate.Sensitivity(rawValue: sensitivityRaw) ?? .normal }
    var level: ScoreFollower.Level { ScoreFollower.Level(rawValue: levelRaw) ?? .intermediate }
    /// The Haptune server built into the app (CI sets it from the repository variable HAPTUNE_SERVER_URL),
    /// so nobody has to type a server address. `serverURL` stays as an optional override for developers.
    nonisolated static var bundledServerURL: String {
        let s = (Bundle.main.object(forInfoDictionaryKey: "HaptuneServerURL") as? String ?? "").trimmingCharacters(in: .whitespaces)
        return s.hasPrefix("$(") ? "" : s
    }

    var effectiveServerURL: String {
        let custom = serverURL.trimmingCharacters(in: .whitespaces)
        return custom.isEmpty ? Self.bundledServerURL : custom
    }

    var usesCustomServer: Bool { !serverURL.trimmingCharacters(in: .whitespaces).isEmpty }

    var api: EngineAPI? {
        guard let u = URL(string: effectiveServerURL), u.scheme?.hasPrefix("http") == true else { return nil }
        return EngineAPI(baseURL: u)
    }

    var reminderDate: Date {
        get { Calendar.current.date(bySettingHour: reminderMinutes / 60, minute: reminderMinutes % 60, second: 0, of: Date()) ?? Date() }
        set {
            let c = Calendar.current.dateComponents([.hour, .minute], from: newValue)
            reminderMinutes = (c.hour ?? 19) * 60 + (c.minute ?? 0)
        }
    }

    var initials: String {
        let parts = displayName.split(separator: " ").prefix(2)
        let s = parts.compactMap { $0.first.map(String.init) }.joined()
        return s.isEmpty ? "" : s.uppercased()
    }

    /// Launch arguments used for App Store screenshots and CI (`-HaptuneDemo YES -HaptuneScreen library`).
    nonisolated static var isDemo: Bool { UserDefaults.standard.bool(forKey: "HaptuneDemo") }
    nonisolated static var demoScreen: String { UserDefaults.standard.string(forKey: "HaptuneScreen") ?? "" }
}
