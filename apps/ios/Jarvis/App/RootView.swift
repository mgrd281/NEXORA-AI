import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                LaunchView()
            case .signedOut:
                SignInView()
            case .restoreFailed(let message):
                RestoreFailedView(message: message)
            case .signedIn:
                MainTabView()
            }
        }
        .tint(MeridianColor.accent)
        .preferredColorScheme(colorScheme)
        .task { await bootstrap() }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active: app.scenePhaseChanged(isActive: true)
            case .background: app.scenePhaseChanged(isActive: false)
            default: break
            }
        }
    }

    private var colorScheme: ColorScheme? {
        switch app.me?.theme ?? .system {
        case .light: .light
        case .dark: .dark
        case .system, .unknown: nil
        }
    }

    private func bootstrap() async {
        await app.bootstrap()
    }
}

private struct MainTabView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.selectedTab) {
            HomeView()
                .tabItem { Label("Home", systemImage: MeridianIcon.home) }
                .tag(AppTab.home)
            ConversationListView()
                .tabItem { Label("Conversations", systemImage: MeridianIcon.conversations) }
                .tag(AppTab.conversations)
            TaskListView()
                .tabItem { Label("Tasks", systemImage: MeridianIcon.tasks) }
                .tag(AppTab.tasks)
            MemoryView()
                .tabItem { Label("Memory", systemImage: MeridianIcon.memory) }
                .tag(AppTab.memory)
            SettingsView()
                .tabItem { Label("Settings", systemImage: MeridianIcon.settings) }
                .tag(AppTab.settings)
        }
    }
}

private struct LaunchView: View {
    var body: some View {
        VStack(spacing: MeridianSpace.s4) {
            PresenceView(state: .idle, diameter: 64)
            ProgressView("Connecting to JARVIS…")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MeridianColor.canvas)
    }
}

private struct RestoreFailedView: View {
    @Environment(AppModel.self) private var app
    let message: String
    @State private var isRetrying = false

    var body: some View {
        VStack(spacing: MeridianSpace.s6) {
            Spacer()
            PresenceView(state: .reconnecting, diameter: 64)
            VStack(spacing: MeridianSpace.s2) {
                Text("Can't reach JARVIS")
                    .meridianFont(.title2)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: MeridianSpace.s3) {
                Button {
                    retry()
                } label: {
                    if isRetrying {
                        ProgressView()
                    } else {
                        Text("Try again")
                    }
                }
                .buttonStyle(.meridianPrimary)
                .disabled(isRetrying)

                Button("Sign out") {
                    Task { await app.signOut() }
                }
                .buttonStyle(.meridianSecondary)
                .disabled(isRetrying)
            }
            Spacer()
        }
        .padding(MeridianSpace.s6)
        .frame(maxWidth: MeridianLayout.contentMaxWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MeridianColor.canvas)
    }

    private func retry() {
        isRetrying = true
        Task {
            await app.retryRestore()
            isRetrying = false
        }
    }
}
