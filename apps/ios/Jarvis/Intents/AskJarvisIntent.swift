import AppIntents
import Foundation

/// "Ask JARVIS" for Siri and Shortcuts. It creates a task with the signed-in session and
/// reports the task's title and status. It never approves anything: actions that need
/// approval wait for the user in the app.
struct AskJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask JARVIS"

    static let description = IntentDescription(
        "Sends a request to JARVIS. Anything that needs your approval waits for you in the app."
    )

    static let openAppWhenRun = false

    @Parameter(title: "Request", requestValueDialog: IntentDialog("What should JARVIS do?"))
    var request: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask JARVIS \(\.$request)")
    }

    init() {}

    init(request: String) {
        self.request = request
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = request.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return .result(dialog: IntentDialog("Tell JARVIS what to do."))
        }
        guard text.contractLength <= 4000 else {
            return .result(dialog: IntentDialog("That request is too long. Keep it under 4,000 characters."))
        }
        guard case .success(let configuration) = AppConfiguration.load() else {
            return .result(dialog: IntentDialog("JARVIS isn't configured on this iPhone."))
        }

        let client = APIClient(baseURL: configuration.apiBaseURL)
        guard await client.hasCredential() else {
            return .result(dialog: IntentDialog("Sign in to JARVIS in the app first."))
        }

        do {
            let task = try await client.createTask(
                CreateTaskRequest(request: text, source: .text, language: AppLocale.current, voiceSessionId: nil),
                idempotencyKey: UUID().uuidString
            )
            let status = task.status.label
            if task.status == .awaitingApproval || task.pendingApprovalId != nil {
                return .result(dialog: IntentDialog("“\(task.title)” needs your approval. Open JARVIS to review it."))
            }
            return .result(dialog: IntentDialog("Created “\(task.title)”. Status: \(status). Follow it in the JARVIS app."))
        } catch let error as ApiError where error.code == .unauthenticated {
            return .result(dialog: IntentDialog("Your JARVIS session has ended. Sign in again in the app."))
        } catch {
            return .result(dialog: IntentDialog("JARVIS couldn't create the task: \(ErrorText.message(for: error))"))
        }
    }
}

struct JarvisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskJarvisIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) to do something",
                "New request in \(.applicationName)",
            ],
            shortTitle: "Ask JARVIS",
            systemImageName: "mic"
        )
    }
}
