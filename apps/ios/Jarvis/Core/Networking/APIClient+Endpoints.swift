import Foundation

/// Typed wrappers for the routes this app uses. Paths, methods and bodies follow
/// packages/contracts/src/routes.ts exactly.
extension APIClient {
    private static func id(_ value: String) -> String { pathSegment(value) }

    // MARK: Auth

    /// `POST /v1/auth/login` with `platform: "ios"`. Stores the returned token in the Keychain.
    func login(email: String, password: String, deviceName: String) async throws -> LoginResponse {
        let response: LoginResponse = try await send(
            .post,
            "/v1/auth/login",
            body: LoginRequest(
                email: email,
                password: password,
                deviceName: deviceName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(contractLength: 80),
                platform: .ios
            ),
            authenticated: false
        )
        guard let token = response.token, !token.isEmpty else {
            throw NetworkError.invalidResponse("The sign-in response did not include a session token")
        }
        try store(
            SessionCredential(
                token: token,
                sessionId: response.session.id,
                expiresAt: response.session.expiresAt
            )
        )
        return response
    }

    /// `POST /v1/auth/logout` — revokes this session on the server. The caller clears the
    /// local credential whether or not this succeeds.
    func logout() async throws {
        let _: EmptyResponse = try await send(.post, "/v1/auth/logout", signOutOnUnauthorized: false)
    }

    func sessions() async throws -> [SessionInfo] {
        let list: ItemList<SessionInfo> = try await send(.get, "/v1/auth/sessions")
        return list.items
    }

    func revokeSession(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/auth/sessions/\(Self.id(id))")
    }

    // MARK: Natural voice

    private struct SpeechRequest: Encodable, Sendable {
        let text: String
        let language: String
    }

    /// `POST /v1/voice/speech`: the text read aloud by the natural voice (MP3 bytes).
    func speech(text: String, language: AppLocale) async throws -> Data {
        let lang = language == .unknown ? AppLocale.current : language
        return try await postForData(
            "/v1/voice/speech",
            body: SpeechRequest(text: String(text.prefix(1500)), language: lang.rawValue)
        )
    }

    // MARK: Account

    func me() async throws -> Me {
        try await send(.get, "/v1/me")
    }

    func updateMe(_ patch: UpdateMeRequest) async throws -> Me {
        try await send(.patch, "/v1/me", body: patch)
    }

    // MARK: Home

    func home() async throws -> HomeSnapshot {
        try await send(.get, "/v1/home")
    }

    // MARK: Tasks

    func tasks(filter: TaskListFilter, cursor: String?, limit: Int = 25) async throws -> Page<TaskSummary> {
        var query = [
            URLQueryItem(name: "status", value: filter.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(.get, "/v1/tasks", query: query)
    }

    func task(id: String) async throws -> TaskDetail {
        try await send(.get, "/v1/tasks/\(Self.id(id))")
    }

    /// `POST /v1/tasks` (202). Reuse the same `idempotencyKey` when re-sending the same
    /// submission so a lost response never creates a second task.
    func createTask(_ request: CreateTaskRequest, idempotencyKey: String) async throws -> TaskSummary {
        try await send(.post, "/v1/tasks", body: request, idempotencyKey: idempotencyKey)
    }

    func cancelTask(id: String) async throws -> TaskSummary {
        try await send(.post, "/v1/tasks/\(Self.id(id))/cancel")
    }

    func retryTask(id: String, acknowledgeUnknownOutcome: Bool, idempotencyKey: String) async throws -> TaskSummary {
        try await send(
            .post,
            "/v1/tasks/\(Self.id(id))/retry",
            body: RetryTaskRequest(acknowledgeUnknownOutcome: acknowledgeUnknownOutcome),
            idempotencyKey: idempotencyKey
        )
    }

    // MARK: Approvals

    func approvals() async throws -> [Approval] {
        let list: ItemList<Approval> = try await send(.get, "/v1/approvals")
        return list.items
    }

    /// Approves or rejects exactly the action identified by `actionHash`.
    func decideApproval(
        id: String,
        decision: ApprovalDecision,
        actionHash: String,
        idempotencyKey: String
    ) async throws -> Approval {
        try await send(
            .post,
            "/v1/approvals/\(Self.id(id))/decision",
            body: ApprovalDecisionRequest(decision: decision, actionHash: actionHash, note: nil),
            idempotencyKey: idempotencyKey
        )
    }

    // MARK: Memory

    func memories(search: String?, cursor: String?, limit: Int = 50) async throws -> Page<Memory> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let search, !search.isEmpty { query.append(URLQueryItem(name: "q", value: search)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(.get, "/v1/memories", query: query)
    }

    func createMemory(kind: MemoryKind, content: String) async throws -> Memory {
        try await send(.post, "/v1/memories", body: CreateMemoryRequest(kind: kind, content: content))
    }

    func deleteMemory(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/memories/\(Self.id(id))")
    }

    // MARK: Connections

    func connections() async throws -> [Connection] {
        let list: ItemList<Connection> = try await send(.get, "/v1/connections")
        return list.items
    }

    /// Disconnects a service. For Google the server also queues the revocation of its grant;
    /// Microsoft has no per-app revocation (the app says where to remove it there).
    func deleteConnection(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/connections/\(Self.id(id))")
    }

    // MARK: OAuth connections (Phase C)

    /// Which providers this server can connect (configured or not), with the exact scopes.
    func connectionProviders() async throws -> [ConnectionProviderInfo] {
        let list: ItemList<ConnectionProviderInfo> = try await send(.get, "/v1/connections/providers")
        return list.items
    }

    /// Starts an authorization (code + PKCE run by the server). Not idempotent: each call
    /// creates a new single-use state bound to this session.
    func startOAuth(_ request: OAuthStartRequest) async throws -> OAuthStartResponse {
        try await send(.post, "/v1/connections/oauth/start", body: request)
    }

    /// Forwards the provider's redirect (its query parameters) with this session.
    func completeOAuth(_ request: OAuthCallbackRequest) async throws -> OAuthCallbackResult {
        try await send(.post, "/v1/connections/oauth/callback", body: request)
    }

    // MARK: Calendar (Phase C; live from the provider)

    /// The next events of the connected calendars; nil when no calendar is connected.
    func upcomingEvents() async throws -> UpcomingEvents? {
        let response: UpcomingEventsResponse = try await send(.get, "/v1/calendar/upcoming")
        return response.upcoming
    }

    func calendarEvents(from: Date, to: Date, provider: OAuthProvider? = nil) async throws -> CalendarEventList {
        var query = [
            URLQueryItem(name: "from", value: from.formatted(.iso8601)),
            URLQueryItem(name: "to", value: to.formatted(.iso8601)),
        ]
        if let provider, provider != .unknown {
            query.append(URLQueryItem(name: "provider", value: provider.rawValue))
        }
        return try await send(.get, "/v1/calendar/events", query: query)
    }

    // MARK: Email reply tracking (Phase C)

    func emailWatches() async throws -> [EmailWatch] {
        let list: ItemList<EmailWatch> = try await send(.get, "/v1/email/watches")
        return list.items
    }

    /// Stops watching a thread (the row is kept as `stopped`).
    func stopEmailWatch(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/email/watches/\(Self.id(id))")
    }

    // MARK: Orders and bookings (Phase C; read-only records)

    func orders(status: OrderStatus? = nil, cursor: String?, limit: Int = 25) async throws -> Page<Order> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let status, status != .unrecognized { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(.get, "/v1/orders", query: query)
    }

    func order(id: String) async throws -> Order {
        try await send(.get, "/v1/orders/\(Self.id(id))")
    }

    func bookings(status: BookingStatus? = nil, cursor: String?, limit: Int = 25) async throws -> Page<Booking> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let status, status != .unrecognized { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(.get, "/v1/bookings", query: query)
    }

    func booking(id: String) async throws -> Booking {
        try await send(.get, "/v1/bookings/\(Self.id(id))")
    }

    // MARK: Evidence files (Phase C; owner only)

    func evidence(id: String) async throws -> EvidenceArtifact {
        try await send(.get, "/v1/evidence/\(Self.id(id))")
    }

    /// The file's bytes and the media type the server sent (image/png, application/json,
    /// text/calendar).
    func downloadEvidence(id: String) async throws -> (data: Data, mediaType: EvidenceMediaType) {
        let (data, response) = try await download("/v1/evidence/\(Self.id(id))/content")
        let mime = response.mimeType?.lowercased() ?? ""
        return (data, EvidenceMediaType(rawValue: mime) ?? .unknown)
    }

    // MARK: Conversations (Phase B)

    func conversations(search: String?, cursor: String?, limit: Int = 25) async throws -> Page<ConversationSummary> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let search, !search.isEmpty { query.append(URLQueryItem(name: "q", value: search)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(.get, "/v1/conversations", query: query)
    }

    /// The newest `limit` tasks' turns; pass `before` (an `earlierCursor`) for earlier ones.
    func conversation(id: String, before: String? = nil, limit: Int = 20) async throws -> ConversationDetail {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        return try await send(.get, "/v1/conversations/\(Self.id(id))", query: query)
    }

    /// `POST /v1/conversations/:id/messages` (202): a new task in this conversation.
    /// Reuse `idempotencyKey` when re-sending the same follow-up after a lost response.
    func followUp(conversationId: String, _ request: FollowUpRequest, idempotencyKey: String) async throws -> TaskSummary {
        try await send(
            .post,
            "/v1/conversations/\(Self.id(conversationId))/messages",
            body: request,
            idempotencyKey: idempotencyKey
        )
    }

    func deleteConversation(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/conversations/\(Self.id(id))")
    }

    // MARK: Attachments (Phase B)

    /// `POST /v1/attachments` (multipart, field `file`). Unattached uploads expire after 24 h.
    func uploadAttachment(
        filename: String,
        mediaType: AttachmentMediaType,
        data: Data,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> Attachment {
        try await upload(
            "/v1/attachments",
            filename: filename,
            mediaType: mediaType,
            data: data,
            onProgress: onProgress
        )
    }

    func attachment(id: String) async throws -> Attachment {
        try await send(.get, "/v1/attachments/\(Self.id(id))")
    }

    /// The file's bytes (owner only).
    func downloadAttachment(id: String) async throws -> Data {
        try await download("/v1/attachments/\(Self.id(id))/content").data
    }

    func deleteAttachment(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/attachments/\(Self.id(id))")
    }

    // MARK: Skills (Phase B)

    func skills() async throws -> [Skill] {
        let list: ItemList<Skill> = try await send(.get, "/v1/skills")
        return list.items
    }

    /// Turns a skill on or off. Never grants permissions; the server refuses planned and
    /// core skills.
    func updateSkill(id: SkillId, enabled: Bool) async throws -> Skill {
        try await send(.patch, "/v1/skills/\(Self.id(id.rawValue))", body: UpdateSkillRequest(enabled: enabled))
    }

    // MARK: Schedules (Phase B)

    func schedules() async throws -> [Schedule] {
        let list: ItemList<Schedule> = try await send(.get, "/v1/schedules")
        return list.items
    }

    func schedule(id: String) async throws -> ScheduleDetail {
        try await send(.get, "/v1/schedules/\(Self.id(id))")
    }

    func createSchedule(_ request: CreateScheduleRequest, idempotencyKey: String) async throws -> Schedule {
        try await send(.post, "/v1/schedules", body: request, idempotencyKey: idempotencyKey)
    }

    /// The RRULE and next occurrences of a recurrence; nothing is saved.
    func previewSchedule(_ recurrence: Recurrence, count: Int = 5) async throws -> SchedulePreview {
        try await send(
            .post,
            "/v1/schedules/preview",
            body: SchedulePreviewRequest(recurrence: recurrence, count: min(max(count, 1), 10))
        )
    }

    func updateSchedule(id: String, _ patch: UpdateScheduleRequest) async throws -> Schedule {
        try await send(.patch, "/v1/schedules/\(Self.id(id))", body: patch)
    }

    func deleteSchedule(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/schedules/\(Self.id(id))")
    }

    func pauseSchedule(id: String) async throws -> Schedule {
        try await send(.post, "/v1/schedules/\(Self.id(id))/pause")
    }

    func resumeSchedule(id: String) async throws -> Schedule {
        try await send(.post, "/v1/schedules/\(Self.id(id))/resume")
    }

    // MARK: Meta (Phase B)

    /// Time zones the server accepts, so a picker never offers one it would reject.
    func timeZones() async throws -> [TimeZoneInfo] {
        let list: ItemList<TimeZoneInfo> = try await send(.get, "/v1/meta/time-zones")
        return list.items
    }

    // MARK: Voice sessions (metadata only)

    /// Starts the metadata record of a voice session. A conversation names the conversation
    /// it continues (follow-ups); the server answers 404 for one that isn't the caller's.
    func startVoiceSession(
        locale: String,
        mode: VoiceSessionMode = .dictation,
        conversationId: String? = nil
    ) async throws -> VoiceSession {
        try await send(
            .post,
            "/v1/voice-sessions",
            body: VoiceSessionStartRequest(
                locale: locale.prefix(contractLength: 16),
                engine: "ios_speech",
                mode: mode == .unknown ? nil : mode,
                conversationId: conversationId
            )
        )
    }

    /// Ends the record with counters only (no audio, no transcript).
    func endVoiceSession(
        id: String,
        outcome: VoiceSessionEndRequest.Outcome,
        transcriptChars: Int,
        errorCode: String?,
        counters: VoiceSessionCounters? = nil,
        endReason: VoiceEndReason? = nil
    ) async throws {
        let _: VoiceSession = try await send(
            .post,
            "/v1/voice-sessions/\(Self.id(id))/end",
            body: Self.voiceSessionEnd(
                outcome: outcome,
                transcriptChars: transcriptChars,
                errorCode: errorCode,
                counters: counters,
                endReason: endReason
            )
        )
    }

    /// The end body with every value clamped to the contract's bounds.
    static func voiceSessionEnd(
        outcome: VoiceSessionEndRequest.Outcome,
        transcriptChars: Int,
        errorCode: String?,
        counters: VoiceSessionCounters?,
        endReason: VoiceEndReason?
    ) -> VoiceSessionEndRequest {
        var body = VoiceSessionEndRequest(
            outcome: outcome,
            transcriptChars: min(max(transcriptChars, 0), 100_000),
            errorCode: errorCode.map { $0.prefix(contractLength: 64) }
        )
        if let counters {
            body.turns = min(max(counters.turns, 0), 500)
            body.bargeIns = min(max(counters.bargeIns, 0), 10_000)
            body.reconnects = min(max(counters.reconnects, 0), 1_000)
        }
        if let endReason, endReason != .unknown { body.endReason = endReason }
        return body
    }

    // MARK: Phone calls (Phase D; records of what the agent did — no route places a call)

    func calls(result: CallResult? = nil, cursor: String?, limit: Int = 25) async throws -> Page<CallSummary> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let result, result != .unknown { query.append(URLQueryItem(name: "result", value: result.rawValue)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await send(.get, "/v1/calls", query: query)
    }

    /// A call with its status timeline and every turn.
    func call(id: String) async throws -> CallSession {
        try await send(.get, "/v1/calls/\(Self.id(id))")
    }

    /// Numbers JARVIS won't call for this account (masked).
    func doNotCallEntries() async throws -> [DoNotCallEntry] {
        let list: ItemList<DoNotCallEntry> = try await send(.get, "/v1/do-not-call")
        return list.items
    }

    /// Removes a number from the do-not-call list (audited on the server).
    func deleteDoNotCall(id: String) async throws {
        let _: EmptyResponse = try await send(.delete, "/v1/do-not-call/\(Self.id(id))")
    }

    /// The verification in progress (or that just failed), so the code field can be shown again.
    func currentPhoneVerification() async throws -> PhoneVerification? {
        let state: PhoneVerificationState = try await send(.get, "/v1/me/phone/verification")
        return state.verification
    }

    /// Calls the account's own number and reads out a code (201).
    func startPhoneVerification() async throws -> PhoneVerification {
        try await send(.post, "/v1/me/phone/verification")
    }

    /// Confirms the code from the verification call; the number becomes verified.
    func confirmPhoneVerification(code: String) async throws -> Me {
        try await send(
            .post,
            "/v1/me/phone/verification/confirm",
            body: ConfirmPhoneVerificationRequest(code: code)
        )
    }
}

/// Counters of a voice conversation, sent when it ends (metadata only).
struct VoiceSessionCounters: Sendable, Equatable {
    /// Requests sent.
    var turns = 0
    /// Times the user spoke while JARVIS was speaking.
    var bargeIns = 0
    /// Request retries and recognition restarts after errors.
    var reconnects = 0
    /// Characters of the requests sent.
    var chars = 0
}
