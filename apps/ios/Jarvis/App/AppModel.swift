import Foundation
import Observation
import UIKit

enum AppTab: Hashable, Sendable {
    case home
    case conversations
    case tasks
    case memory
    case settings
}

/// App-wide state: the session, the signed-in user, the realtime connection and
/// cross-screen signals (presence outcome, voice-originated tasks to read aloud).
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case signedOut
        case signedIn
        /// A stored session exists but the server could not be reached to confirm it.
        case restoreFailed(String)
    }

    private(set) var phase: Phase = .launching
    private(set) var me: Me?
    /// Shown on the sign-in screen (e.g. "your session ended").
    var signInNotice: String?
    var selectedTab: AppTab = .home
    /// A task that just completed or failed, for the Presence indicator.
    private(set) var recentOutcome: PresenceOutcome?
    /// Voice capture is active (Presence shows `listening`; nothing is read aloud meanwhile).
    var isCapturingVoice = false
    /// The last assistant status seen (Home loads it), for capability-dependent controls
    /// such as attaching files. Nil until known: controls then stay available and the
    /// server's answer explains any refusal.
    var assistantStatus: AssistantStatus?

    /// Whether file uploads are known to be unavailable on this server.
    var attachmentsUnavailable: Bool {
        assistantStatus?.capabilities.attachments == false
    }

    let api: APIClient
    let live: LiveEvents
    let configuration: AppConfiguration
    let speaker = ResponseSpeaker()

    /// Tasks created by voice on this device in this session, with the recognition
    /// locale, so their results can be read aloud when `speakResponses` is on.
    @ObservationIgnored private var voiceTasks: [String: String] = [:]
    @ObservationIgnored private var outcomeReset: Task<Void, Never>?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        let client = APIClient(baseURL: configuration.apiBaseURL)
        api = client
        live = LiveEvents(
            stream: EventStream(
                baseURL: configuration.apiBaseURL,
                tokenProvider: { await client.bearerToken() }
            )
        )
        live.onEvent = { [weak self] event in self?.observe(event) }
        live.onUnauthorized = { [weak self] in self?.sessionEnded() }
        let onUnauthorized: @Sendable () async -> Void = { [weak self] in
            await self?.sessionEnded()
        }
        Task { await client.setUnauthorizedHandler(onUnauthorized) }
    }

    // MARK: Session

    func bootstrap() async {
        guard phase == .launching else { return }
        guard await api.hasCredential() else {
            phase = .signedOut
            return
        }
        do {
            me = try await api.me()
            phase = .signedIn
            live.start()
        } catch is CancellationError {
            return
        } catch let error as ApiError where error.code == .unauthenticated {
            phase = .signedOut
        } catch NetworkError.notSignedIn {
            phase = .signedOut
        } catch {
            phase = .restoreFailed(ErrorText.message(for: error))
        }
    }

    func retryRestore() async {
        phase = .launching
        await bootstrap()
    }

    func signIn(email: String, password: String) async throws {
        let response = try await api.login(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password,
            deviceName: UIDevice.current.name
        )
        me = response.user
        signInNotice = nil
        selectedTab = .home
        phase = .signedIn
        live.reset()
        live.start()
    }

    /// Revokes the session on the server, then always removes it from this device.
    func signOut() async {
        live.reset()
        speaker.stop()
        var notice: String?
        do {
            try await api.logout()
        } catch {
            notice = String(localized: "Signed out on this iPhone. JARVIS couldn't be reached to end the session on the server; it expires on its own, or you can revoke it from another device.")
        }
        await api.clearCredential()
        finishSignOut(notice: notice)
    }

    /// The server rejected the session (revoked elsewhere or expired).
    func sessionEnded() {
        guard phase == .signedIn || phase == .launching else { return }
        live.reset()
        speaker.stop()
        Task { await api.clearCredential() }
        finishSignOut(notice: String(localized: "Your session has ended. Sign in again."))
    }

    private func finishSignOut(notice: String?) {
        me = nil
        assistantStatus = nil
        // Evidence screenshots shown in this session stay with this account only.
        EvidenceImageCache.shared.removeAll()
        voiceTasks.removeAll()
        recentOutcome = nil
        isCapturingVoice = false
        signInNotice = notice
        selectedTab = .home
        phase = .signedOut
    }

    // MARK: Account

    func updateMe(_ patch: UpdateMeRequest) async throws {
        me = try await api.updateMe(patch)
    }

    func refreshMe() async {
        guard let fresh = try? await api.me() else { return }
        me = fresh
    }

    // MARK: Tasks

    /// Submits a request. `idempotencyKey` must stay the same when re-sending the same
    /// submission after a failure, so a lost response never creates a duplicate task.
    func submitTask(
        _ text: String,
        source: TaskRequestSource,
        language: AppLocale?,
        voiceSessionId: String? = nil,
        recognitionLocale: String? = nil,
        attachmentIds: [String] = [],
        conversationId: String? = nil,
        idempotencyKey: String
    ) async throws -> TaskSummary {
        let request = CreateTaskRequest(
            request: text.trimmingCharacters(in: .whitespacesAndNewlines),
            source: source,
            language: language,
            voiceSessionId: voiceSessionId,
            attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds
        )
        let task: TaskSummary
        if let conversationId {
            // A follow-up: a new task in that conversation, planned with its earlier turns.
            task = try await api.followUp(conversationId: conversationId, request, idempotencyKey: idempotencyKey)
        } else {
            task = try await api.createTask(request, idempotencyKey: idempotencyKey)
        }
        if source == .voice, let recognitionLocale {
            voiceTasks[task.id] = recognitionLocale
        }
        return task
    }

    // MARK: Lifecycle

    func scenePhaseChanged(isActive: Bool) {
        guard phase == .signedIn else { return }
        if isActive {
            live.restart()
            Task { await refreshMe() }
        } else {
            live.stop()
        }
    }

    // MARK: Events

    private func observe(_ event: StreamEvent) {
        guard event.type == .taskStatusChanged,
              let to = event.data["to"]?.stringValue,
              let status = TaskStatus(rawValue: to),
              status == .completed || status == .failed
        else { return }

        // Replayed history (after a reconnect) must not flash as a fresh outcome.
        if abs(event.at.timeIntervalSinceNow) < 60 {
            showOutcome(status)
        }
        guard let taskId = event.taskId, let locale = voiceTasks.removeValue(forKey: taskId) else { return }
        if status == .completed, me?.preferences.voice.speakResponses == true {
            Task { await speakResult(of: taskId, locale: locale) }
        }
    }

    private func showOutcome(_ status: TaskStatus) {
        let outcome = PresenceOutcome(status: status, observedAt: Date())
        recentOutcome = outcome
        outcomeReset?.cancel()
        outcomeReset = Task { [weak self] in
            try? await Task.sleep(for: .seconds(PresenceState.outcomeDisplayDuration))
            guard !Task.isCancelled, let self, self.recentOutcome == outcome else { return }
            self.recentOutcome = nil
        }
    }

    private func speakResult(of taskId: String, locale: String) async {
        guard !isCapturingVoice, let detail = try? await api.task(id: taskId) else { return }
        let text = detail.answer ?? detail.question?.text ?? detail.resultSummary
        guard let text, !text.isEmpty, !isCapturingVoice else { return }
        speaker.speak(text, languageCode: locale)
    }
}
