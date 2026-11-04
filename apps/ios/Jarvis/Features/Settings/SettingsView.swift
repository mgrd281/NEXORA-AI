import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var model = SettingsModel()
    @State private var confirmingSignOut = false
    @State private var isSigningOut = false

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section {
                        InlineErrorView(message: error)
                            .listRowInsets(EdgeInsets())
                    }
                }
                accountSection
                languageSection
                appearanceSection
                voiceSection
                autonomySection
                assistantSection
                privacySection
                connectionsSection
                securitySection
                aboutSection
            }
            .scrollContentBackground(.hidden)
            .background(MeridianColor.canvas)
            .navigationTitle(Text("Settings"))
            .jarvisDestinations()
            .task { await load() }
            .refreshable { await refresh() }
            .onChange(of: app.me) { _, me in model.sync(from: me) }
            .onChange(of: model.theme) { _, _ in save() }
            .onChange(of: model.speakResponses) { _, _ in save() }
            .onChange(of: model.recognitionLocale) { _, _ in save() }
            .onChange(of: model.autoApproveEmailToSelf) { _, _ in save() }
            .onChange(of: model.allowExternalModels) { _, _ in save() }
            .onChange(of: model.timeZone) { _, _ in save() }
            .onChange(of: model.memoryRetention) { _, _ in save() }
            .onChange(of: model.taskRetention) { _, _ in save() }
            .confirmationDialog(Text("Sign out of JARVIS on this iPhone?"), isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { signOut() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your session on this iPhone ends and its token is removed from the Keychain.")
            }
        }
    }

    // MARK: Sections

    private var accountSection: some View {
        Section {
            if let me = app.me {
                LabeledContent {
                    Text(me.displayName)
                } label: {
                    Text("Name")
                }
                LabeledContent {
                    Text(me.email)
                        .textSelection(.enabled)
                } label: {
                    Text("Email")
                }
                NavigationLink {
                    TimeZonePickerView(selection: $model.timeZone)
                } label: {
                    LabeledContent {
                        Text(RecurrenceText.zoneName(model.timeZone))
                    } label: {
                        Text("Time zone")
                    }
                }
            }
        } header: {
            Text("Account")
        } footer: {
            Text("Your time zone is used for dates and times, for new schedules, and for when your monthly budget resets. The list shows the zones the server accepts.")
        }
    }

    private var assistantSection: some View {
        Section {
            NavigationLink {
                SkillsView()
            } label: {
                Label("Skills", systemImage: MeridianIcon.skills)
            }
            NavigationLink(value: SchedulesRoute()) {
                Label("Schedules", systemImage: MeridianIcon.schedules)
            }
        } header: {
            Text("What JARVIS can do")
        }
    }

    private var privacySection: some View {
        Section {
            Picker(selection: $model.memoryRetention) {
                ForEach(RetentionSetting.memoryChoices, id: \.self) { choice in
                    Text(choice.label).tag(choice)
                }
            } label: {
                Text("Keep memories")
            }
            Picker(selection: $model.taskRetention) {
                ForEach(RetentionSetting.taskHistoryChoices, id: \.self) { choice in
                    Text(choice.label).tag(choice)
                }
            } label: {
                Text("Keep task history")
            }
        } header: {
            Text("Automatic deletion")
        } footer: {
            Text("JARVIS checks once a day. Memories that haven't changed for the chosen period are deleted, and so are finished tasks older than it, with their conversations, results, approvals and attached files. Deleted data can't be recovered. Files you attach but never send are deleted after 24 hours.")
        }
    }

    private var languageSection: some View {
        Section {
            Button {
                openAppSettings()
            } label: {
                LabeledContent {
                    Text(currentLanguageName)
                } label: {
                    Text("App language")
                }
            }
            .foregroundStyle(MeridianColor.textPrimary)
        } header: {
            Text("Language")
        } footer: {
            Text("JARVIS uses the language you choose for it in iOS Settings, so it can differ from your iPhone's language. Tap to change it there.")
        }
    }

    private var appearanceSection: some View {
        Section {
            Picker(selection: $model.theme) {
                Text("System").tag(ThemePreference.system)
                Text("Light").tag(ThemePreference.light)
                Text("Dark").tag(ThemePreference.dark)
            } label: {
                Text("Theme")
            }
        } header: {
            Text("Appearance")
        } footer: {
            Text("Saved to your account, so the web app uses it too.")
        }
    }

    private var voiceSection: some View {
        Section {
            Toggle(isOn: $model.speakResponses) {
                Text("Speak responses")
            }
            Picker(selection: $model.recognitionLocale) {
                ForEach(RecognitionLocale.selectable, id: \.self) { locale in
                    Text(recognitionLabel(locale)).tag(locale)
                }
            } label: {
                Text("Recognition language")
            }
        } header: {
            Text("Voice")
        } footer: {
            Text("After a voice request, JARVIS reads the result aloud. Speech is recognised on this iPhone when the language supports it; otherwise by Apple's speech service.")
        }
    }

    private var autonomySection: some View {
        Section {
            Toggle(isOn: $model.autoApproveEmailToSelf) {
                Text("Auto-approve emails to myself")
            }
            Toggle(isOn: $model.allowExternalModels) {
                Text("Use external AI models")
            }
        } header: {
            Text("Autonomy and AI")
        } footer: {
            Text("Emails addressed only to your own address can run without asking. When external AI models are off, nothing you ask is sent to an AI provider; JARVIS uses its offline rules engine instead.")
        }
    }

    private var connectionsSection: some View {
        Section {
            if let error = model.connectionsError {
                Text(error)
                    .foregroundStyle(MeridianColor.danger)
            } else if model.connectionsLoaded, model.connections.isEmpty {
                Text("No services connected.")
                    .foregroundStyle(MeridianColor.textSecondary)
            } else if !model.connectionsLoaded {
                ProgressView()
            }
            ForEach(model.connections) { connection in
                ConnectionRow(connection: connection)
            }
        } header: {
            Text("Connections")
        } footer: {
            Text("Connect or change services in JARVIS on the web. Credentials are never shown here.")
        }
    }

    private var securitySection: some View {
        Section {
            NavigationLink {
                SessionsView()
            } label: {
                Label("Signed-in devices", systemImage: "iphone.and.arrow.forward")
            }
            Button(role: .destructive) {
                confirmingSignOut = true
            } label: {
                if isSigningOut {
                    ProgressView()
                } else {
                    Text("Sign out")
                }
            }
            .disabled(isSigningOut)
        } header: {
            Text("Security")
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent {
                Text(verbatim: appVersion)
            } label: {
                Text("Version")
            }
            LabeledContent {
                Text(verbatim: app.configuration.apiBaseURL.absoluteString)
                    .textSelection(.enabled)
            } label: {
                Text("Server")
            }
        } header: {
            Text("About")
        }
    }

    // MARK: Helpers

    private var currentLanguageName: String {
        let code = AppLocale.current.rawValue
        return Locale.current.localizedString(forLanguageCode: code) ?? code
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }

    private func recognitionLabel(_ locale: RecognitionLocale) -> String {
        switch locale {
        case .auto: String(localized: "Same as app language")
        case .enUS, .deDE, .arSA:
            Locale.current.localizedString(forIdentifier: locale.rawValue) ?? locale.rawValue
        case .unknown: String(localized: "Same as app language")
        }
    }

    private func openAppSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }

    private func save() {
        Task { await model.save(app: app) }
    }

    private func signOut() {
        isSigningOut = true
        Task {
            await app.signOut()
            isSigningOut = false
        }
    }

    private func load() async {
        model.sync(from: app.me)
        await model.loadConnections(api: app.api)
    }

    private func refresh() async {
        await app.refreshMe()
        model.sync(from: app.me)
        await model.loadConnections(api: app.api)
    }
}

private struct ConnectionRow: View {
    let connection: Connection

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: connection.provider.icon)
                .foregroundStyle(MeridianColor.textSecondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                Text(connection.label)
                    .meridianFont(.bodyStrong)
                Text(connection.accountIdentifier ?? connection.provider.label)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                if connection.status == .error, let lastError = connection.lastError {
                    Text(lastError)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.danger)
                }
            }
            Spacer(minLength: MeridianSpace.s2)
            ToneBadge(label: connection.status.label, systemImage: connection.status == .active ? "checkmark" : "exclamationmark", tone: connection.status.tone)
        }
        .accessibilityElement(children: .combine)
    }
}
