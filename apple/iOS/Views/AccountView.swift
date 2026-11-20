import PracticeCore
import SwiftUI
import UniformTypeIdentifiers

/// A finished backup .zip handed to the system "Save to Files" sheet (Files, Google Drive, Dropbox, OneDrive).
struct BackupFile: FileDocument {
    static var readableContentTypes: [UTType] { [.zip] }
    let url: URL

    init(url: URL) { self.url = url }
    init(configuration: ReadConfiguration) throws { throw CocoaError(.fileReadUnsupportedScheme) }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { try FileWrapper(url: url) }
}

/// Profile, subscription, sync, language and practice settings (opened from the profile button).
struct AccountView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var library: Library
    @EnvironmentObject var store: Store
    @EnvironmentObject var router: Router
    @ObservedObject private var watch = WatchLink.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var backup: BackupFile?
    @State private var exporting = false
    @State private var importingBackup = false
    @State private var message: String?
    @State private var serverOK: Bool?
    @State private var testing = false

    private var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(v) (\(b))"
    }

    var body: some View {
        NavigationStack {
            Form {
                profile
                subscription
                sync
                practice
                reminders
                language
                if WatchLink.isSupported { appleWatch }
                server
                about
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .fileExporter(isPresented: $exporting, document: backup, contentType: .zip,
                          defaultFilename: backup?.url.deletingPathExtension().lastPathComponent ?? "Haptune Backup") { result in
                if case .failure(let e) = result { message = e.localizedDescription }
            }
            .fileImporter(isPresented: $importingBackup, allowedContentTypes: [.zip]) { result in
                guard case .success(let url) = result else { return }
                do {
                    let n = try library.restoreBackup(from: url)
                    message = String(localized: "Restored \(n) pieces from the backup.")
                } catch {
                    message = error.localizedDescription
                }
            }
            .onChange(of: settings.reminderOn) { _, _ in updateReminder() }
            .onChange(of: settings.reminderMinutes) { _, _ in updateReminder() }
            .alert("Haptune", isPresented: Binding(get: { message != nil || store.message != nil },
                                                  set: { if !$0 { message = nil; store.message = nil } })) {
                Button("OK", role: .cancel) { message = nil; store.message = nil }
            } message: {
                Text(message ?? store.message ?? "")
            }
        }
    }

    // MARK: sections

    private var profile: some View {
        Section {
            HStack(spacing: 14) {
                Text(settings.initials.isEmpty ? "♪" : settings.initials)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 60, height: 60)
                    .background(Color.accentColor.gradient, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Your name", text: $settings.displayName)
                        .font(.title3.weight(.semibold))
                        .textContentType(.name)
                    HStack(spacing: 6) {
                        if store.isPlus { PlusBadge() }
                        Text(InstrumentLibrary.profile(settings.instrumentKey).name).foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var subscription: some View {
        Section {
            if Store.isTestBuild {
                LabeledContent("Haptune Plus", value: store.activePlanName)
            } else if store.isPlus {
                LabeledContent("Haptune Plus", value: store.activePlanName)
                if let d = store.renewalDate {
                    LabeledContent("Renews", value: d.formatted(date: .abbreviated, time: .omitted))
                }
                Button("Manage Subscription") {
                    if let u = URL(string: "https://apps.apple.com/account/subscriptions") { openURL(u) }
                }
            } else {
                Button { router.paywall = .bandSplit } label: {
                    HStack(spacing: 12) {
                        IconBadge(symbol: "sparkles", color: .purple, size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Try Haptune Plus Free").font(.body.weight(.semibold)).foregroundStyle(.primary)
                            Text("Band Split, sheet music scanning, full reports").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !Store.isTestBuild {
                Button("Restore Purchases") { Task { await store.restore() } }
            }
        } header: {
            Text("Subscription")
        } footer: {
            if Store.isTestBuild {
                Text("This is a test build: every Plus feature is unlocked and nothing can be bought.")
            }
        }
    }

    private var sync: some View {
        Section {
            Toggle(isOn: Binding(get: { settings.iCloudSync }, set: { on in setCloud(on) })) {
                Label("iCloud Sync", systemImage: "icloud")
            }
            LabeledContent("Library") {
                if library.location == .iCloud { Text("iCloud Drive") } else { Text("On This Device") }
            }
            Button {
                do {
                    backup = BackupFile(url: try library.makeBackup())
                    exporting = true
                } catch { message = error.localizedDescription }
            } label: {
                Label("Back Up to Files or Google Drive…", systemImage: "arrow.up.doc")
            }
            Button { importingBackup = true } label: {
                Label("Restore from a Backup…", systemImage: "arrow.down.doc")
            }
        } header: {
            Text("Sync & Backup")
        } footer: {
            Text("iCloud keeps your pieces and practice history the same on iPhone, iPad and Mac. A backup is one .zip file you can keep in Files, Google Drive, Dropbox or OneDrive.")
        }
    }

    private var practice: some View {
        Section("Practice") {
            Picker("I Play", selection: $settings.instrumentKey) {
                ForEach(InstrumentLibrary.all) { Text($0.name).tag($0.key) }
            }
            Stepper("Daily Goal: \(settings.dailyGoalMinutes) min", value: $settings.dailyGoalMinutes, in: 5...180, step: 5)
            Stepper("Tuning: A4 = \(Int(settings.a4)) Hz", value: $settings.a4, in: 415...446, step: 1)
            Picker("Watch Taps", selection: $settings.sensitivityRaw) {
                Text("Gentle").tag("gentle")
                Text("Normal").tag("normal")
                Text("Strict").tag("strict")
            }
            Picker("Level", selection: $settings.levelRaw) {
                Text("Beginner").tag("beginner")
                Text("Intermediate").tag("intermediate")
                Text("Advanced").tag("advanced")
            }
            Stepper("Count-in: \(settings.countInBars) bars", value: $settings.countInBars, in: 0...2)
        }
    }

    private var reminders: some View {
        Section {
            Toggle(isOn: $settings.reminderOn) { Label("Daily Reminder", systemImage: "bell.badge") }
            if settings.reminderOn {
                DatePicker("Time", selection: $settings.reminderDate, displayedComponents: .hourAndMinute)
            }
        } header: {
            Text("Reminders")
        }
    }

    private var language: some View {
        Section {
            Picker(selection: $settings.language) {
                ForEach(AppLanguage.allCases) { lang in Text(verbatim: lang.nativeName).tag(lang) }
            } label: {
                Label("Language", systemImage: "globe")
            }
        } footer: {
            Text("English, Bahasa Melayu, 简体中文 and 繁體中文. Some system text switches the next time you open Haptune.")
        }
    }

    private var appleWatch: some View {
        Section {
            LabeledContent("Paired") { if watch.isPaired { Text("Yes") } else { Text("No") } }
            LabeledContent("App Installed") { if watch.isWatchAppInstalled { Text("Yes") } else { Text("No") } }
            LabeledContent("Connected Now") { if watch.isReachable { Text("Yes") } else { Text("No") } }
        } header: {
            Text("Apple Watch")
        } footer: {
            Text("Keep Haptune open on your Watch while you practise. Tip: Watch Settings > General > Return to Clock > Haptune > Return to App.")
        }
    }

    private var server: some View {
        Section {
            LabeledContent("Online features") {
                if settings.api == nil {
                    Text("Not available")
                } else if let ok = serverOK {
                    Label(ok ? "Working" : "Offline right now", systemImage: ok ? "checkmark.circle.fill" : "wifi.exclamationmark")
                        .foregroundStyle(ok ? .green : .orange)
                } else if testing {
                    ProgressView()
                } else {
                    Text("Ready")
                }
            }
            .task {
                guard settings.api != nil, serverOK == nil else { return }
                testing = true
                serverOK = await settings.api?.health() ?? false
                testing = false
            }
            DisclosureGroup("Advanced") {
                TextField("Custom server (optional)", text: $settings.serverURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task {
                        testing = true
                        serverOK = await settings.api?.health() ?? false
                        testing = false
                    }
                } label: {
                    HStack {
                        Text("Test Connection")
                        Spacer()
                        if testing { ProgressView() }
                    }
                }
                .disabled(settings.api == nil || testing)
            }
        } header: {
            Text("Online Features")
        } footer: {
            Text("Reading PDFs and photos with AI, finding songs online, recordings to sheet music, Band Split, full reports and Academy classes use the Haptune server. There is nothing to set up. Practice, MusicXML, MIDI and jianpu work offline.")
        }
    }

    private var about: some View {
        Section("About") {
            LabeledContent("Version", value: appVersion)
            Text("Sheet music engraving by Verovio (LGPL). Score import uses music21 (BSD).")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    // MARK: actions

    private func setCloud(_ on: Bool) {
        settings.iCloudSync = on
        Task {
            let ok = await library.useCloud(on)
            if on && !ok {
                settings.iCloudSync = false
                message = String(localized: "iCloud isn't available. Sign in with your Apple Account and turn on iCloud Drive in Settings.")
            }
        }
    }

    private func updateReminder() {
        let streak = PracticeStats(history: library.history).streak
        Task {
            let ok = await Reminders.update(enabled: settings.reminderOn, minutesAfterMidnight: settings.reminderMinutes, streak: streak)
            if !ok {
                settings.reminderOn = false
                message = String(localized: "Allow notifications for Haptune in Settings to get reminders.")
            }
        }
    }
}
