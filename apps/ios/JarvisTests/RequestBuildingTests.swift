import Foundation
import Testing
@testable import Jarvis

@Suite("API requests, configuration and the task state machine")
struct RequestBuildingTests {
    private let base = URL(string: "http://localhost:4000")!

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("URLs join the base path and escape query values")
    func urls() throws {
        let plain = try #require(APIClient.makeURL(baseURL: base, path: "/v1/tasks"))
        #expect(plain.absoluteString == "http://localhost:4000/v1/tasks")

        let prefixed = try #require(APIClient.makeURL(baseURL: URL(string: "https://api.example.com/jarvis/")!, path: "/v1/me"))
        #expect(prefixed.absoluteString == "https://api.example.com/jarvis/v1/me")

        let query = try #require(APIClient.makeURL(
            baseURL: base,
            path: "/v1/memories",
            query: [URLQueryItem(name: "q", value: "c++ & tea"), URLQueryItem(name: "limit", value: "50")]
        ))
        #expect(query.absoluteString == "http://localhost:4000/v1/memories?q=c%2B%2B%20%26%20tea&limit=50")

        #expect(APIClient.pathSegment("7c415ea2-cacf-462b-8a9f-470f9ce34759") == "7c415ea2-cacf-462b-8a9f-470f9ce34759")
        #expect(APIClient.pathSegment("../me") == "..%2Fme")
    }

    @Test("Bearer token, Idempotency-Key and Content-Type only when there is a body")
    func headers() throws {
        let url = try #require(APIClient.makeURL(baseURL: base, path: "/v1/tasks"))
        let body = try JSONCoding.makeEncoder().encode(
            CreateTaskRequest(request: "Hi", source: .text, language: .de, voiceSessionId: nil)
        )
        let create = APIClient.makeRequest(
            url: url, method: .post, body: body, token: "secret-token", idempotencyKey: "key-12345678", language: "de"
        )
        #expect(create.httpMethod == "POST")
        #expect(create.value(forHTTPHeaderField: "Authorization") == "Bearer secret-token")
        #expect(create.value(forHTTPHeaderField: "Idempotency-Key") == "key-12345678")
        #expect(create.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(create.value(forHTTPHeaderField: "Accept-Language") == "de")
        #expect(create.httpBody == body)

        let cancel = APIClient.makeRequest(url: url, method: .post, body: nil, token: "t", idempotencyKey: nil, language: "en")
        #expect(cancel.value(forHTTPHeaderField: "Content-Type") == nil)
        #expect(cancel.value(forHTTPHeaderField: "Idempotency-Key") == nil)
        #expect(cancel.httpBody == nil)

        let login = APIClient.makeRequest(url: url, method: .post, body: body, token: nil, idempotencyKey: nil, language: "en")
        #expect(login.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("Request bodies match the contract shapes and omit unset fields")
    func bodies() throws {
        let create = try json(CreateTaskRequest(request: "Summarize", source: .voice, language: .ar, voiceSessionId: nil))
        #expect(create["request"] as? String == "Summarize")
        #expect(create["source"] as? String == "voice")
        #expect(create["language"] as? String == "ar")
        #expect(Set(create.keys) == ["request", "source", "language"])

        let login = try json(LoginRequest(email: "a@example.com", password: "pw", deviceName: "iPhone", platform: .ios))
        #expect(login["platform"] as? String == "ios")
        #expect(login["deviceName"] as? String == "iPhone")

        let decision = try json(ApprovalDecisionRequest(decision: .approve, actionHash: "abc", note: nil))
        #expect(decision["decision"] as? String == "approve")
        #expect(decision["actionHash"] as? String == "abc")
        #expect(Set(decision.keys) == ["decision", "actionHash"])

        let retry = try json(RetryTaskRequest(acknowledgeUnknownOutcome: true))
        #expect(retry["acknowledgeUnknownOutcome"] as? Bool == true)

        let patch = try json(UpdateMeRequest(
            theme: .dark,
            preferences: PreferencesPatch(voice: .init(speakResponses: true, recognitionLocale: nil))
        ))
        #expect(Set(patch.keys) == ["theme", "preferences"])
        #expect(patch["theme"] as? String == "dark")
        let preferences = try #require(patch["preferences"] as? [String: Any])
        #expect(Set(preferences.keys) == ["voice"])
        let voice = try #require(preferences["voice"] as? [String: Any])
        #expect(Set(voice.keys) == ["speakResponses"])

        let memory = try json(CreateMemoryRequest(kind: .preference, content: "Short answers"))
        #expect(memory["kind"] as? String == "preference")

        let voiceStart = try json(VoiceSessionStartRequest(locale: "de-DE", engine: "ios_speech"))
        #expect(voiceStart["engine"] as? String == "ios_speech")
        let voiceEnd = try json(VoiceSessionEndRequest(outcome: .noSpeech, transcriptChars: 0, errorCode: nil))
        #expect(voiceEnd["outcome"] as? String == "no_speech")
    }

    private func problem(_ raw: String) -> AppConfiguration.Problem? {
        if case .failure(let problem) = AppConfiguration.validate(raw) { return problem }
        return nil
    }

    @Test("API address must be HTTPS, except for localhost")
    func configuration() {
        #expect((try? AppConfiguration.validate("https://api.example.com").get())?.apiBaseURL.host() == "api.example.com")
        #expect(problem("http://localhost:4000") == nil)
        #expect(problem("http://127.0.0.1:4000") == nil)
        #expect(problem("http://192.168.1.20:4000") == AppConfiguration.Problem.insecure("http://192.168.1.20:4000"))
        #expect(problem("http://example.com") == AppConfiguration.Problem.insecure("http://example.com"))
        #expect(problem("") == AppConfiguration.Problem.missing)
        #expect(problem("$(JARVIS_API_BASE_URL)") == AppConfiguration.Problem.missing)
        #expect(problem("ftp://example.com") == AppConfiguration.Problem.invalid("ftp://example.com"))
        #expect(problem("https://example.com/?a=1") == AppConfiguration.Problem.invalid("https://example.com/?a=1"))
    }

    @Test("Task state machine mirrors packages/contracts/src/task-state.ts")
    func taskState() {
        #expect(TaskStatus.queued.canCancel)
        #expect(TaskStatus.planning.canCancel)
        #expect(TaskStatus.awaitingApproval.canCancel)
        #expect(TaskStatus.running.canCancel)
        #expect(!TaskStatus.verifying.canCancel)
        #expect(!TaskStatus.completed.canCancel)
        #expect(TaskStatus.failed.canRetry)
        #expect(TaskStatus.expired.canRetry)
        #expect(!TaskStatus.cancelled.canRetry)
        #expect(!TaskStatus.completed.canRetry)
        #expect(!TaskStatus.unknown.canRetry && !TaskStatus.unknown.canCancel)
        #expect(TaskStatus.terminal == [.completed, .failed, .cancelled, .expired])
        #expect(TaskStatus.active.isDisjoint(with: TaskStatus.terminal))
    }

    @Test("Length limits count UTF-16 code units, like the server's Zod validation")
    func contractLength() {
        let thumbs = "ab\u{1F44D}\u{1F3FD}" // "ab" + 👍🏽 (one character, four UTF-16 units)
        #expect(thumbs.count == 3)
        #expect(thumbs.contractLength == 6)
        #expect(thumbs.prefix(contractLength: 5) == "ab")
        #expect(thumbs.prefix(contractLength: 6) == thumbs)
        #expect("Grüße".prefix(contractLength: 3) == "Grü")
    }

    @Test("Recognition locale follows the app language when set to auto")
    func recognitionLocale() {
        #expect(RecognitionLocale.auto.resolvedIdentifier(appLocale: .de) == "de-DE")
        #expect(RecognitionLocale.auto.resolvedIdentifier(appLocale: .ar) == "ar-SA")
        #expect(RecognitionLocale.auto.resolvedIdentifier(appLocale: .en) == "en-US")
        #expect(RecognitionLocale.arSA.resolvedIdentifier(appLocale: .en) == "ar-SA")
        #expect(AppLocale(recognitionIdentifier: "de-DE") == .de)
        #expect(AppLocale(recognitionIdentifier: "fr-FR") == .en)
    }
}
