import AuthenticationServices
import SwiftUI

extension OAuthCallbackResult: Identifiable {
    var id: String { connection.id }
}

/// Google and Microsoft accounts (connect with exactly the permissions chosen, reconnect when
/// expired, allow more, disconnect) and the other connections, which are managed on the web.
struct ConnectionsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var model = ConnectionsModel()
    @State private var connector = OAuthConnector()
    @State private var selections: [OAuthProvider: Set<ConnectionCapability>] = [:]
    @State private var connected: OAuthCallbackResult?
    @State private var confirmingDisconnect: Connection?

    var body: some View {
        List {
            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    model.scheduleRefresh(api: app.api)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if let notice = model.notice {
                NoteView(text: notice, systemImage: "checkmark.circle", tone: .success)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if let error = connector.errorMessage {
                InlineErrorView(message: error)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            if model.hasLoaded {
                if model.providersUnavailable {
                    Section {
                        NoteView(text: String(localized: "This server doesn't offer Google or Microsoft connections yet."))
                            .listRowInsets(EdgeInsets())
                    }
                } else {
                    ForEach(model.cards) { card in
                        providerSection(card)
                    }
                }
                otherSection
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .overlay {
            if !model.hasLoaded, model.isLoading {
                ProgressView()
            }
        }
        .navigationTitle(Text("Connections"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task { await followEvents() }
        .onChange(of: app.live.openCount) { _, _ in
            model.scheduleRefresh(api: app.api)
        }
        .sheet(item: $connected) { result in
            ConnectResultView(result: result)
        }
        .confirmationDialog(
            Text(disconnectTitle),
            isPresented: Binding(
                get: { confirmingDisconnect != nil },
                set: { if !$0 { confirmingDisconnect = nil } }
            ),
            titleVisibility: .visible,
            presenting: confirmingDisconnect
        ) { connection in
            Button("Disconnect and erase tokens", role: .destructive) {
                Task { await model.disconnect(connection, api: app.api) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { connection in
            Text(disconnectMessage(connection))
        }
    }

    // MARK: Provider cards

    @ViewBuilder
    private func providerSection(_ card: ConnectionsModel.ProviderCard) -> some View {
        Section {
            providerHeader(card)
            if !card.configured, card.connection == nil {
                Text("Whoever runs this JARVIS server hasn't set up sign-in with \(card.provider.name.bidiIsolated) yet (it needs a client ID and secret), so it can't be connected here.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            } else if let connection = card.connection {
                connectedRows(card, connection: connection)
            } else {
                chooser(card, connectionId: nil, options: card.offered, title: String(localized: "What JARVIS may do"))
            }
        } footer: {
            if card.configured, card.connection == nil {
                Text("You sign in at \(card.provider.name.bidiIsolated) and confirm there. JARVIS never sees your password, and anything that writes or sends still waits for your approval.")
            }
        }
    }

    private func providerHeader(_ card: ConnectionsModel.ProviderCard) -> some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: card.provider.icon)
                .foregroundStyle(MeridianColor.textSecondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: MeridianSpace.s2) { headerTitle(card) }
                    VStack(alignment: .leading, spacing: MeridianSpace.s1) { headerTitle(card) }
                }
                Text(card.provider.summary)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func headerTitle(_ card: ConnectionsModel.ProviderCard) -> some View {
        Text(card.provider.name)
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.textPrimary)
            .accessibilityAddTraits(.isHeader)
        if let connection = card.connection {
            ToneBadge(label: connection.status.oauthLabel, systemImage: connection.status.oauthIcon, tone: connection.status.tone)
        } else if !card.configured {
            ToneBadge(label: String(localized: "Not configured"), systemImage: "minus.circle", tone: .neutral)
        } else {
            ToneBadge(label: String(localized: "Not connected"), systemImage: "circle", tone: .neutral)
        }
    }

    @ViewBuilder
    private func connectedRows(_ card: ConnectionsModel.ProviderCard, connection: Connection) -> some View {
        if let account = connection.accountIdentifier {
            LabeledContent {
                Text(verbatim: account.bidiIsolated)
                    .textSelection(.enabled)
            } label: {
                Text("Account")
            }
        }
        LabeledContent {
            Text(MeridianFormat.relative(connection.createdAt))
        } label: {
            Text("Connected")
        }

        if connection.needsReconnect {
            VStack(alignment: .leading, spacing: MeridianSpace.s3) {
                Label {
                    Text("Your \(card.provider.name.bidiIsolated) connection has expired")
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.warning)
                Text((connection.statusReason ?? .unknown).explanation(provider: card.provider.name))
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                let asks = ConnectionsModel.reconnectCapabilities(for: connection, offered: card.offered)
                if !asks.isEmpty {
                    Text("Reconnecting asks for the same permissions as before: \(asks.map(\.label).formatted(.list(type: .and))).")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                connectButton(
                    title: String(localized: "Reconnect \(card.provider.name)"),
                    provider: card.provider,
                    capabilities: asks,
                    connectionId: connection.id,
                    enabled: card.configured
                )
            }
            .padding(.vertical, MeridianSpace.s1)
        } else if connection.status == .error {
            NoteView(text: (connection.statusReason ?? .providerError).explanation(provider: card.provider.name), systemImage: "exclamationmark.triangle", tone: .warning)
                .listRowInsets(EdgeInsets())
        } else if connection.statusReason == .scopeMissing {
            NoteView(text: ConnectionStatusReason.scopeMissing.explanation(provider: card.provider.name), systemImage: "exclamationmark.triangle", tone: .warning)
                .listRowInsets(EdgeInsets())
        }

        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text("What JARVIS can do")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            let granted = connection.knownCapabilities
            if granted.isEmpty {
                Text("Nothing yet.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            ForEach(granted, id: \.self) { capability in
                Label {
                    Text(capability.label)
                } icon: {
                    Image(systemName: capability.icon)
                        .accessibilityHidden(true)
                }
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
            }
            if let scopes = connection.scopes, !scopes.isEmpty {
                DisclosureGroup {
                    ScopeList(scopes: scopes)
                } label: {
                    Text("Exact permissions \(card.provider.name.bidiIsolated) granted")
                        .meridianFont(.label)
                }
                .tint(MeridianColor.textSecondary)
            }
        }
        .accessibilityElement(children: .contain)

        if !connection.needsReconnect, card.configured, !card.notYetGranted.isEmpty {
            chooser(card, connectionId: connection.id, options: card.notYetGranted, title: String(localized: "Allow more"))
        }

        Button(role: .destructive) {
            confirmingDisconnect = connection
        } label: {
            if model.disconnectingIds.contains(connection.id) {
                ProgressView()
            } else {
                Text("Disconnect")
            }
        }
        .disabled(model.disconnectingIds.contains(connection.id) || connector.isRunning)
    }

    /// Capability toggles with plain-language consequences and the exact scopes, then the
    /// button that opens the provider's sign-in.
    @ViewBuilder
    private func chooser(
        _ card: ConnectionsModel.ProviderCard,
        connectionId: String?,
        options: [ConnectionCapability],
        title: String
    ) -> some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            Text(title)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityAddTraits(.isHeader)
            Text("Allow only what you need; you can add more later.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
        ForEach(options, id: \.self) { capability in
            Toggle(isOn: binding(card.provider, capability)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(capability.label)
                        .meridianFont(.bodyStrong)
                    Text(capability.hint)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .disabled(connector.isRunning)
        }
        let chosen = options.filter { (selections[card.provider] ?? []).contains($0) }
        if let info = card.info, !chosen.isEmpty {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                    ScopeList(scopes: chosen.flatMap { info.scopes(for: $0) })
                    if connectionId == nil, !info.identityScopes.isEmpty {
                        Text("Always included: your account's ID and address, and staying connected.")
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textSecondary)
                        ScopeList(scopes: info.identityScopes)
                    }
                }
            } label: {
                Text("Exact permissions requested from \(card.provider.name.bidiIsolated)")
                    .meridianFont(.label)
            }
            .tint(MeridianColor.textSecondary)
        }
        connectButton(
            title: connectionId == nil
                ? String(localized: "Continue to \(card.provider.name)")
                : String(localized: "Allow at \(card.provider.name)"),
            provider: card.provider,
            capabilities: chosen,
            connectionId: connectionId,
            enabled: card.configured && !chosen.isEmpty
        )
        if chosen.isEmpty {
            Text("Choose at least one thing JARVIS may do.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
    }

    @ViewBuilder
    private func connectButton(
        title: String,
        provider: OAuthProvider,
        capabilities: [ConnectionCapability],
        connectionId: String?,
        enabled: Bool
    ) -> some View {
        Button {
            Task { await connect(provider, capabilities: capabilities, connectionId: connectionId) }
        } label: {
            if connector.isRunning, connector.provider == provider {
                HStack(spacing: MeridianSpace.s2) {
                    ProgressView().tint(MeridianColor.onInk)
                    Text(connector.phase.label)
                }
            } else {
                Text(title)
            }
        }
        .buttonStyle(.meridianPrimary)
        .disabled(!enabled || !connector.isAvailable || connector.isRunning)
        .listRowInsets(EdgeInsets(top: MeridianSpace.s2, leading: MeridianSpace.s4, bottom: MeridianSpace.s2, trailing: MeridianSpace.s4))
        if !connector.isAvailable {
            Text("Connecting accounts isn't set up in this version of the app. Connect on the web; the connection then works here too.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Other connections

    private var otherSection: some View {
        Section {
            if model.otherConnections.isEmpty {
                Text("No other services connected.")
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            ForEach(model.otherConnections) { connection in
                OtherConnectionRow(connection: connection)
            }
        } header: {
            Text("Email (SMTP) and web access")
        } footer: {
            Text("Set these up or change them in JARVIS on the web. Credentials are never shown here.")
        }
    }

    // MARK: Helpers

    private func binding(_ provider: OAuthProvider, _ capability: ConnectionCapability) -> Binding<Bool> {
        Binding(
            get: { (selections[provider] ?? []).contains(capability) },
            set: { on in
                var set = selections[provider] ?? []
                if on { set.insert(capability) } else { set.remove(capability) }
                selections[provider] = set
            }
        )
    }

    private func connect(_ provider: OAuthProvider, capabilities: [ConnectionCapability], connectionId: String?) async {
        model.clearNotice()
        connector.clearResult()
        if let result = await connector.connect(
            provider: provider,
            capabilities: capabilities,
            connectionId: connectionId,
            session: webAuthenticationSession,
            api: app.api
        ) {
            selections[provider] = []
            await model.apply(result, api: app.api)
            connected = result
        }
    }

    private var disconnectTitle: String {
        guard let connection = confirmingDisconnect else { return "" }
        return String(localized: "Disconnect \(connection.oauthProvider?.name ?? connection.provider.label)?")
    }

    private func disconnectMessage(_ connection: Connection) -> String {
        let account = (connection.accountIdentifier ?? connection.label).bidiIsolated
        let revocation = model.providers.first(where: { $0.oauthProvider == connection.oauthProvider })?.revocation
        var parts = [String(localized: "JARVIS will no longer read or change anything in \(account).")]
        switch revocation {
        case .provider:
            parts.append(String(localized: "JARVIS erases its tokens right away and asks the provider to revoke its access."))
        case .localOnly:
            parts.append(String(localized: "JARVIS erases its tokens right away. Microsoft doesn't let apps revoke their own access, so also remove JARVIS from your account: account.live.com/consent/Manage for personal accounts, myapps.microsoft.com for work or school accounts."))
        case .unknown, .none:
            parts.append(String(localized: "JARVIS erases its tokens right away."))
        }
        parts.append(String(localized: "Threads JARVIS watches for replies in this account are no longer watched."))
        return parts.joined(separator: "\n\n")
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

/// The exact provider scopes, as granted or requested (identifiers are not translated).
private struct ScopeList: View {
    let scopes: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(Set(scopes)).sorted(), id: \.self) { scope in
                Text(verbatim: scope)
                    .meridianFont(.mono)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .environment(\.layoutDirection, .leftToRight)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.top, MeridianSpace.s1)
    }
}

private struct OtherConnectionRow: View {
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

/// What the server connected (never assumed), and the tasks that can be retried now.
struct ConnectResultView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var resumable: ResumableTasksModel
    let result: OAuthCallbackResult

    init(result: OAuthCallbackResult) {
        self.result = result
        _resumable = State(initialValue: ResumableTasksModel(taskIds: result.resumableTaskIds))
    }

    private var providerName: String {
        result.connection.oauthProvider?.name ?? result.connection.provider.label
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: MeridianSpace.s6) {
                    VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                        Label {
                            Text("\(providerName.bidiIsolated) is connected")
                        } icon: {
                            Image(systemName: "checkmark.circle")
                                .accessibilityHidden(true)
                        }
                        .meridianFont(.title2)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                        if let account = result.connection.accountIdentifier {
                            Text("JARVIS can now use \(account.bidiIsolated) to:")
                                .meridianFont(.callout)
                                .foregroundStyle(MeridianColor.textSecondary)
                        }
                        ForEach(result.connection.knownCapabilities, id: \.self) { capability in
                            Label(capability.label, systemImage: capability.icon)
                                .meridianFont(.body)
                                .foregroundStyle(MeridianColor.textPrimary)
                        }
                    }
                    if !resumable.items.isEmpty {
                        resumableSection
                    }
                }
                .padding(MeridianSpace.s4)
                .frame(maxWidth: MeridianLayout.contentMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(MeridianColor.canvas)
            .navigationTitle(Text("Connect an account"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await resumable.loadTitles(api: app.api) }
        }
    }

    private var resumableSection: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: String(localized: "Stopped because the connection had expired"), count: resumable.items.count)
            Text("The connection works again, so you can retry them now.")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
            ForEach(resumable.items) { item in
                Card {
                    Text(item.title ?? String(localized: "Task"))
                        .meridianFont(.bodyStrong)
                        .foregroundStyle(MeridianColor.textPrimary)
                    switch item.state {
                    case .ready, .retrying:
                        Button {
                            Task { await resumable.retry(item.id, api: app.api) }
                        } label: {
                            if item.state == .retrying {
                                ProgressView().tint(MeridianColor.onInk)
                            } else {
                                Label("Retry", systemImage: "arrow.clockwise")
                            }
                        }
                        .buttonStyle(.meridianPrimary)
                        .disabled(item.state == .retrying)
                        .accessibilityLabel(Text("Retry “\(item.title ?? String(localized: "Task"))”"))
                    case .retried:
                        ToneBadge(label: String(localized: "Retry started"), systemImage: "checkmark", tone: .success)
                    case .failed(let message):
                        InlineErrorView(message: message) {
                            Task { await resumable.retry(item.id, api: app.api) }
                        }
                    }
                }
            }
        }
    }
}

/// Reconnects one provider in place (from a failed task or Home), asking for the same
/// permissions as before plus the one a step needed; shows the server's result.
struct ReconnectButton: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var connector = OAuthConnector()
    @State private var connected: OAuthCallbackResult?
    @State private var preparing = false
    let provider: OAuthProvider
    var capability: ConnectionCapability? = nil
    var onConnected: (OAuthCallbackResult) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Button {
                Task { await reconnect() }
            } label: {
                if connector.isRunning || preparing {
                    HStack(spacing: MeridianSpace.s2) {
                        ProgressView().tint(MeridianColor.onInk)
                        Text(connector.isRunning ? connector.phase.label : String(localized: "Preparing…"))
                    }
                } else {
                    Label("Reconnect \(provider.name)", systemImage: "arrow.triangle.2.circlepath")
                }
            }
            .buttonStyle(.meridianPrimary)
            .disabled(!connector.isAvailable || connector.isRunning || preparing)
            if !connector.isAvailable {
                Text("Connecting accounts isn't set up in this version of the app. Connect on the web; the connection then works here too.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = connector.errorMessage {
                Text(error)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sheet(item: $connected) { result in
            ConnectResultView(result: result)
        }
    }

    private func reconnect() async {
        preparing = true
        let connections = (try? await app.api.connections()) ?? []
        let providers = (try? await app.api.connectionProviders()) ?? []
        preparing = false
        let existing = connections.first(where: { $0.oauthProvider == provider && $0.status != .revoked })
        let info = providers.first(where: { $0.oauthProvider == provider })
        let listed = Set(info?.capabilities.map(\.capability) ?? [])
        let offered = ConnectionCapability.selectable.filter { listed.contains($0) }
        let wanted = ConnectionsModel.reconnectCapabilities(for: existing, adding: capability, offered: offered)
        if let result = await connector.connect(
            provider: provider,
            capabilities: wanted,
            connectionId: existing?.id,
            session: webAuthenticationSession,
            api: app.api
        ) {
            onConnected(result)
            connected = result
        }
    }
}

extension OAuthConnector.Phase {
    var label: String {
        switch self {
        case .idle: String(localized: "Ready")
        case .starting: String(localized: "Preparing…")
        case .authorizing: String(localized: "Signing in…")
        case .finishing: String(localized: "Finishing the connection…")
        }
    }
}

extension ConnectionStatus {
    /// For Google / Microsoft cards ("Connected" rather than "Active").
    var oauthLabel: String {
        switch self {
        case .active: String(localized: "Connected")
        case .error: String(localized: "Needs attention")
        case .expired: String(localized: "Expired")
        case .revoked: String(localized: "Disconnected")
        case .unknown: String(localized: "Unknown status")
        }
    }

    var oauthIcon: String {
        switch self {
        case .active: "checkmark"
        case .error, .expired: "exclamationmark.triangle"
        case .revoked: "minus.circle"
        case .unknown: "questionmark.circle"
        }
    }
}
