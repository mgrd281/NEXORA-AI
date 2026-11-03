import SwiftUI

/// Active sessions on all devices, with revoke. This iPhone's session is ended with
/// Sign out instead, so the local credential is removed too.
struct SessionsView: View {
    @Environment(AppModel.self) private var app
    @State private var model = SessionsModel()
    @State private var pendingRevoke: SessionInfo? = nil
    @State private var confirmingRevoke = false

    var body: some View {
        List {
            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    Task { await model.load(api: app.api) }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            Section {
                ForEach(model.sessions) { session in
                    SessionRow(session: session, isRevoking: model.revokingIds.contains(session.id))
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if !session.current {
                                Button(role: .destructive) {
                                    requestRevoke(session)
                                } label: {
                                    Label("Revoke", systemImage: "xmark.circle")
                                }
                            }
                        }
                        .contextMenu {
                            if !session.current {
                                Button(role: .destructive) {
                                    requestRevoke(session)
                                } label: {
                                    Label("Revoke", systemImage: "xmark.circle")
                                }
                            }
                        }
                }
            } footer: {
                if model.hasLoaded {
                    Text("Revoking signs that device out immediately. To sign out of this iPhone, use Sign out in Settings.")
                }
            }
        }
        .overlay {
            if !model.hasLoaded, model.errorMessage == nil {
                ProgressView()
            }
        }
        .navigationTitle(Text("Signed-in devices"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog(
            Text("Revoke this session?"),
            isPresented: $confirmingRevoke,
            titleVisibility: .visible,
            presenting: pendingRevoke
        ) { session in
            Button("Revoke", role: .destructive) {
                Task { await model.revoke(session, api: app.api) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { session in
            Text("\(session.deviceName ?? session.platform.label) will be signed out.")
        }
    }

    private func requestRevoke(_ session: SessionInfo) {
        pendingRevoke = session
        confirmingRevoke = true
    }

    private func load() async {
        await model.load(api: app.api)
    }
}

private struct SessionRow: View {
    let session: SessionInfo
    let isRevoking: Bool

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: session.platform.icon)
                .foregroundStyle(MeridianColor.textSecondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                HStack(spacing: MeridianSpace.s2) {
                    Text(session.deviceName ?? session.platform.label)
                        .meridianFont(.bodyStrong)
                    if session.current {
                        ToneBadge(label: String(localized: "This iPhone"), systemImage: "checkmark", tone: .accent)
                    }
                }
                Text("Last active \(MeridianFormat.relative(session.lastUsedAt))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                Text("Signed in \(MeridianFormat.dateTime(session.createdAt))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
            Spacer(minLength: 0)
            if isRevoking {
                ProgressView()
            }
        }
        .padding(.vertical, MeridianSpace.s1)
        .accessibilityElement(children: .combine)
    }
}
