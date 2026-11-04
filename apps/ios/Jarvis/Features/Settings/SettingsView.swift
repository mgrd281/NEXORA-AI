import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var model = SettingsModel()
    @State private var confirmingSignOut = false
    @State private var isSigningOut = false
    /// Sliders and steppers save once they settle, not on every step.
    @State private var pendingSave: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            Form {
                if let error = model.errorMessage {
                    Section {
                        InlineErrorView(message: error)
                            .listRowInsets(EdgeInsets())
                    }
                }
                // Grouped so no builder block has more than ten children.
                Group {
                    accountSection
                    languageSection
                    appearanceSection
                    voiceSection
                    autonomySection
                }
                Group {
                    assistantSection
                    phoneSection
                    connectionsSection
                    spendingSection
                    privacySection
                    securitySection
                    aboutSection
                }
            }
            .scrollContentBackground(.hidden)
            .background(MeridianColor.canvas)
            .navigationTitle(Text("Settings"))
            .jarvisDestinations()
            .task { await load() }
            .task {
                for await event in app.live.updates() where event.type == .connectionChanged {
                    await model.loadConnections(api: app.api)
                }
            }
            .refreshable { await refresh() }
            .onChange(of: app.me) { _, me in model.sync(from: me) }
            .onChange(of: model.theme) { _, _ in save() }
            .onChange(of: model.speakResponses) { _, _ in save() }
            .onChange(of: model.recognitionLocale) { _, _ in save() }
            .onChange(of: model.conversationMode) { _, _ in save() }
            .onChange(of: model.voiceNames) { _, _ in save() }
            .onChange(of: model.speakingRate) { _, _ in saveSoon() }
            .onChange(of: model.endOfSpeechSilenceMs) { _, _ in saveSoon() }
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
            Toggle(isOn: $model.conversationMode) {
                Text("Start voice mode as a conversation")
            }
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
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                LabeledContent {
                    Text(verbatim: VoiceSettingsText.rate(model.speakingRate))
                } label: {
                    Text("Speaking rate")
                }
                Slider(value: $model.speakingRate, in: VoiceLimits.speakingRateMin...VoiceLimits.speakingRateMax, step: 0.1)
                    .accessibilityLabel(Text("Speaking rate"))
                    .accessibilityValue(Text(verbatim: VoiceSettingsText.rate(model.speakingRate)))
            }
            Stepper(
                value: $model.endOfSpeechSilenceMs,
                in: VoiceLimits.endOfSpeechSilenceMsMin...VoiceLimits.endOfSpeechSilenceMsMax,
                step: 200
            ) {
                LabeledContent {
                    Text(verbatim: VoiceSettingsText.pause(model.endOfSpeechSilenceMs))
                } label: {
                    Text("Pause that ends what you say")
                }
            }
            NavigationLink {
                VoicesView(model: model)
            } label: {
                Text("Voices")
            }
        } header: {
            Text("Voice")
        } footer: {
            Text("A conversation listens again after each answer; you can interrupt JARVIS by talking. A longer pause gives you more time before what you said is sent. Speech is recognised on this iPhone when the language supports it; otherwise by Apple's speech service. Approvals are never given by voice.")
        }
    }

    /// Phase D: the account's phone number, the numbers JARVIS won't call, and its calls.
    private var phoneSection: some View {
        Section {
            NavigationLink(value: PhoneSettingsRoute()) {
                LabeledContent {
                    Text(phoneSummary)
                } label: {
                    Label("Your phone number", systemImage: "phone")
                }
            }
            NavigationLink(value: DoNotCallRoute()) {
                Label("Numbers JARVIS won't call", systemImage: "phone.down")
            }
            NavigationLink(value: CallsRoute()) {
                Label("Calls", systemImage: "phone.arrow.up.right")
            }
        } header: {
            Text("Phone")
        } footer: {
            Text("JARVIS calls only numbers you write in a request, says first that it is an AI assistant calling for you, and always asks you before each call.")
        }
    }

    private var phoneSummary: String {
        guard let me = app.me, let number = me.phoneNumber else { return String(localized: "Not set") }
        return me.phoneNumberVerifiedAt != nil
            ? String(localized: "\(number.bidiIsolated) · verified")
            : String(localized: "\(number.bidiIsolated) · not verified")
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
            NavigationLink(value: ConnectionsRoute()) {
                HStack(spacing: MeridianSpace.s2) {
                    Label("Connected services", systemImage: MeridianIcon.connections)
                    Spacer(minLength: MeridianSpace.s2)
                    connectionsSummary
                }
            }
            NavigationLink(value: EmailWatchesRoute()) {
                Label("Reply tracking", systemImage: "eye")
            }
        } header: {
            Text("Connections")
        } footer: {
            Text("Connect Google or Microsoft here. Email over SMTP and web access are set up in JARVIS on the web. Credentials are never shown.")
        }
    }

    @ViewBuilder
    private var connectionsSummary: some View {
        if let error = model.connectionsError {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(MeridianColor.danger)
                .accessibilityLabel(Text(error))
        } else if model.connectionsLoaded {
            let expired = model.connections.filter(\.needsReconnect).count
            if expired > 0 {
                ToneBadge(label: String(localized: "Reconnect needed"), systemImage: "exclamationmark.triangle", tone: .warning)
            } else {
                Text(model.connections.count.formatted())
                    .foregroundStyle(MeridianColor.textSecondary)
                    .accessibilityLabel(Text("Connected: \(model.connections.count.formatted())"))
            }
        }
    }

    private var spendingSection: some View {
        Section {
            NavigationLink(value: SpendingRoute()) {
                LabeledContent {
                    Text(purchaseLimitText)
                } label: {
                    Label("Purchase limit", systemImage: "creditcard")
                }
            }
            NavigationLink(value: OrdersRoute()) {
                Label("Orders", systemImage: "bag")
            }
            NavigationLink(value: BookingsRoute()) {
                Label("Bookings", systemImage: "calendar.badge.checkmark")
            }
        } header: {
            Text("Spending")
        } footer: {
            Text("Purchases are off until you set a monthly limit. Every purchase still asks you first.")
        }
    }

    private var purchaseLimitText: String {
        let limit = app.me?.preferences.spending.monthlyPurchaseLimitUsd ?? 0
        return limit > 0 ? SpendingModel.usd(limit) : String(localized: "Purchases off")
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

    private func saveSoon() {
        pendingSave?.cancel()
        pendingSave = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await model.save(app: app)
        }
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
