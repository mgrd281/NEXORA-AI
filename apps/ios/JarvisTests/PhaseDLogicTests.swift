import Foundation
import Testing
@testable import Jarvis

/// Phase D client logic: request bodies (phone number, voice preferences, voice-session
/// counters, the verification code), phone-number input, sentence and error copy for calls,
/// times of a call, what a voice conversation says about a task, and Presence while speaking.
@Suite("Phase D requests and client logic")
@MainActor
struct PhaseDLogicTests {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: PATCH /v1/me

    @Test("The phone number is set, removed with an explicit null, or left out")
    func phoneNumberPatch() throws {
        let set = try json(PhoneSettingsModel.patch("+4930123456789"))
        #expect(Set(set.keys) == ["phoneNumber"])
        #expect(set["phoneNumber"] as? String == "+4930123456789")

        let removed = try json(PhoneSettingsModel.patch(nil))
        #expect(Set(removed.keys) == ["phoneNumber"])
        #expect(removed["phoneNumber"] is NSNull)

        let other = try json(UpdateMeRequest(timeZone: "Europe/Berlin"))
        #expect(other["phoneNumber"] == nil)
    }

    @Test("Voice preferences: only what changed; a voice is set or reset per language")
    func voicePatch() throws {
        let stored = Preferences.Voice(
            speakResponses: true,
            recognitionLocale: .deDE,
            conversationMode: false,
            speakingRate: 1,
            endOfSpeechSilenceMs: 1_200,
            voiceNames: Preferences.Voice.VoiceNames(en: "com.apple.voice.en.Samantha", de: nil, ar: nil)
        )
        #expect(SettingsModel.voicePatch(
            speakResponses: true, recognitionLocale: .deDE, conversationMode: false, speakingRate: 1.0001,
            endOfSpeechSilenceMs: 1_200, voiceNames: stored.voiceNames, against: stored
        ) == nil)

        let patch = try #require(SettingsModel.voicePatch(
            speakResponses: true,
            recognitionLocale: .deDE,
            conversationMode: true,
            speakingRate: 1.25,
            endOfSpeechSilenceMs: 9_000,
            voiceNames: Preferences.Voice.VoiceNames(en: nil, de: "com.apple.voice.de.Anna", ar: nil),
            against: stored
        ))
        let body = try json(UpdateMeRequest(preferences: PreferencesPatch(voice: patch)))
        let voice = try #require((body["preferences"] as? [String: Any])?["voice"] as? [String: Any])
        #expect(Set(voice.keys) == ["conversationMode", "speakingRate", "endOfSpeechSilenceMs", "voiceNames"])
        #expect(voice["conversationMode"] as? Bool == true)
        // Rounded to the slider's step and clamped to the contract's bounds.
        #expect(voice["speakingRate"] as? Double == 1.3 || voice["speakingRate"] as? Double == 1.2)
        #expect(voice["endOfSpeechSilenceMs"] as? Int == VoiceLimits.endOfSpeechSilenceMsMax)
        let names = try #require(voice["voiceNames"] as? [String: Any])
        #expect(Set(names.keys) == ["en", "de"])
        #expect(names["en"] is NSNull)
        #expect(names["de"] as? String == "com.apple.voice.de.Anna")
    }

    // MARK: Voice sessions

    @Test("Voice sessions: mode and conversation at the start, counters only at the end")
    func voiceSessionBodies() throws {
        let start = try json(VoiceSessionStartRequest(locale: "de-DE", engine: "ios_speech", mode: .conversation, conversationId: "conv-1"))
        #expect(start["mode"] as? String == "conversation")
        #expect(start["conversationId"] as? String == "conv-1")
        let dictation = try json(VoiceSessionStartRequest(locale: "de-DE", engine: "ios_speech"))
        #expect(Set(dictation.keys) == ["locale", "engine"])

        let end = try json(APIClient.voiceSessionEnd(
            outcome: .ended,
            transcriptChars: 250_000,
            errorCode: nil,
            counters: VoiceSessionCounters(turns: 900, bargeIns: 2, reconnects: 1, chars: 120),
            endReason: .voiceCommand
        ))
        #expect(end["outcome"] as? String == "ended")
        #expect(end["transcriptChars"] as? Int == 100_000)
        #expect(end["turns"] as? Int == 500)
        #expect(end["bargeIns"] as? Int == 2)
        #expect(end["reconnects"] as? Int == 1)
        #expect(end["endReason"] as? String == "voice_command")
        #expect(end["errorCode"] == nil)

        let dictationEnd = try json(APIClient.voiceSessionEnd(outcome: .noSpeech, transcriptChars: 0, errorCode: "x", counters: nil, endReason: nil))
        #expect(Set(dictationEnd.keys) == ["outcome", "transcriptChars", "errorCode"])
    }

    // MARK: Phone number input

    @Test("Phone numbers are read as E.164; the server validates them again")
    func phoneNumberInput() {
        #expect(PhoneNumberInput.normalize("+49 30 1234567") == "+49301234567")
        #expect(PhoneNumberInput.normalize("0049 (30) 123-45-67") == "+49301234567")
        #expect(PhoneNumberInput.normalize("+1 415.555.0100") == "+14155550100")
        #expect(PhoneNumberInput.normalize("+٤٩٣٠١٢٣٤٥٦٧") == "+49301234567")
        #expect(PhoneNumberInput.normalize("030 1234567") == nil)
        #expect(PhoneNumberInput.normalize("+0 30 1234567") == nil)
        #expect(PhoneNumberInput.normalize("+49 30") == nil)
        #expect(PhoneNumberInput.normalize("+49 30 1234567 ext 5") == nil)
        #expect(PhoneNumberInput.normalize("+4930123456789012") == nil)

        #expect(PhoneNumberInput.code(" 123 456 ") == "123456")
        #expect(PhoneNumberInput.code("١٢٣٤٥٦") == "123456")
        #expect(PhoneNumberInput.code("12345") == nil)
        #expect(PhoneNumberInput.code("12a456") == nil)

        let body = try? json(ConfirmPhoneVerificationRequest(code: "123456"))
        #expect(body?["code"] as? String == "123456")
    }

    // MARK: Sentences and errors

    @Test("Phase D server sentences render with their parameters, isolated")
    func serverSentences() throws {
        let call = ServerMessage(key: "approval.call", params: ["who": .text("Dr. Weber"), "number": .text("+4930123456700")])
        let text = try #require(call.rendered)
        #expect(text.contains("Dr. Weber"))
        #expect(text.contains("+4930123456700"))
        #expect(text.contains("\u{2068}"))
        #expect(ServerMessage(key: "result.callCompleted", params: ["who": .text("Anna")]).rendered?.contains("Anna") == true)
        #expect(ServerMessage(key: "plan.call", params: [:]).rendered == nil)
        #expect(ServerMessage(key: "question.phoneNumber").rendered?.contains("+49 30 1234567") == true)
        #expect(ServerMessage(key: "question.callGoal").rendered != nil)
    }

    @Test("Every call failure has its own sentence, with its facts")
    func callErrors() {
        for reason in ["CALL_BUSY", "CALL_NO_ANSWER", "CALL_FAILED", "CALL_VOICEMAIL", "CALL_HUNG_UP", "CALL_DECLINED",
                       "RECORDING_CONSENT_DECLINED", "CALL_STATE_UNKNOWN", "NUMBER_NOT_LITERAL",
                       "CALL_DESTINATION_BLOCKED", "TELEPHONY_NOT_CONFIGURED"] {
            #expect(TaskErrorText.reasonText(reason, params: [:]) != nil, "\(reason)")
        }
        let duration = TaskErrorText.reasonText("CALL_DURATION_LIMIT", params: ["seconds": .number(300)])
        #expect(duration?.contains("5") == true)
        #expect(TaskErrorText.reasonText("CALL_DURATION_LIMIT", params: [:]) == nil)
        let hours = TaskErrorText.reasonText("CALL_OUTSIDE_HOURS", params: [
            "start": .string("08:00"), "end": .string("20:00"), "timeZone": .string("Europe/Berlin"),
        ])
        #expect(hours != nil)
        #expect(hours?.contains("Europe/Berlin") == false)
        let dnc = TaskErrorText.reasonText("DO_NOT_CALL", params: ["number": .string("+49 30 ••• •• 00")])
        #expect(dnc?.contains("+49 30 ••• •• 00") == true)
        #expect(TaskErrorText.reasonText("CALL_LIMIT", params: ["max": .number(10)])?.contains("10") == true)

        let verification = ApiErrorReasonText.describe("PHONE_VERIFICATION_INVALID", details: ["reason": .string("PHONE_VERIFICATION_INVALID"), "attemptsLeft": .number(3)])
        #expect(verification?.contains("3") == true)
        #expect(ApiErrorReasonText.describe("TELEPHONY_NOT_CONFIGURED", details: [:]) != nil)
        #expect(ApiErrorReasonText.describe("WEBHOOK_SIGNATURE_INVALID", details: [:]) == nil)
        for code in ["PHONE_CALL", "CALL_RECORDING", "CALL_PERSONAL_INFO", "DO_NOT_CALL", "CALL_OUTSIDE_HOURS"] {
            #expect(PolicyReasonText.describe(code) != nil, "\(code)")
        }
    }

    @Test("A call's failure uses the call's own facts as parameters")
    func callFailureText() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail-call-busy")
        let busy = try #require(detail.calls?.first)
        #expect(busy.failureText == TaskErrorText.reasonText("CALL_BUSY", params: [:]))
    }

    @Test("Times and dates of a call are wall-clock values, formatted without zone arithmetic")
    func localTimes() {
        #expect(LocalTimeText.format("08:00") != nil)
        #expect(LocalTimeText.format("23:59") != nil)
        #expect(LocalTimeText.format("24:00") == nil)
        #expect(LocalTimeText.format("8:00") == nil)
        #expect(LocalTimeText.format("ab:cd") == nil)
        #expect(LocalTimeText.formatDate("2026-11-10")?.contains("2026") == true)
        #expect(LocalTimeText.formatDate("2026-02-30") == nil)
        #expect(LocalTimeText.window(start: "x", end: "y") == "x–y")
        #expect(PhoneText.duration(300).isEmpty == false)
    }

    // MARK: What the conversation says about a task

    @Test("The spoken line comes from the task: question, result line, error — never a guess")
    func replyLines() throws {
        let busy = try Fixtures.decode(TaskDetail.self, "task-detail-call-busy")
        let failed = try #require(VoiceConversationModel.replyLine(busy, interfaceLanguage: "en-US", requestLanguage: "de-DE"))
        #expect(failed.kind == .error)
        #expect(failed.languageCode == "en-US")
        #expect(failed.text.contains(TaskErrorText.describe(try #require(busy.error))))
        #expect(!failed.text.contains("\u{2068}"))

        let completed = try Fixtures.decode(TaskDetail.self, "task-detail-call")
        let result = try #require(VoiceConversationModel.replyLine(completed, interfaceLanguage: "en-US", requestLanguage: "de-DE"))
        #expect(result.kind == .result)
        #expect(result.text.contains("Praxis Dr. Weber"))

        let question = try Fixtures.decode(TaskDetail.self, "task-detail-question")
        let asked = try #require(VoiceConversationModel.replyLine(question, interfaceLanguage: "en-US", requestLanguage: "en-US"))
        #expect(asked.kind == .question)

        let view = VoiceConversationModel.view(of: busy, requestLanguage: "de-DE")
        #expect(view.status == .failed)
        #expect(view.answer == nil)
        #expect(view.approvalId == nil)
        #expect(view.line?.kind == .error)
    }

    @Test("Status lines say what is happening, including approvals on screen")
    func statusText() {
        let approval = ConversationStatusText.describe(turn: .awaitingApproval, mic: .on, notice: .approvalOnScreen, streamDown: false)
        #expect(approval.help != nil)
        let listening = ConversationStatusText.describe(turn: .ready, mic: .on, notice: nil, streamDown: false)
        let muted = ConversationStatusText.describe(turn: .ready, mic: .muted, notice: nil, streamDown: false)
        #expect(listening != muted)
        let reconnecting = ConversationStatusText.describe(turn: .thinking, mic: .on, notice: nil, streamDown: true)
        let thinking = ConversationStatusText.describe(turn: .thinking, mic: .on, notice: nil, streamDown: false)
        #expect(reconnecting != thinking)
        let denied = ConversationStatusText.describe(turn: .ready, mic: .denied(.microphone), notice: nil, streamDown: false)
        let speechDenied = ConversationStatusText.describe(turn: .ready, mic: .denied(.speech), notice: nil, streamDown: false)
        #expect(denied.title != speechDenied.title)
        let unavailable = ConversationStatusText.describe(turn: .ready, mic: .unavailable("Not here"), notice: nil, streamDown: false)
        #expect(unavailable.title == "Not here")
    }

    @Test("Speaking shows on Presence only while synthesis plays, above listening")
    func presenceSpeaking() {
        var inputs = PresenceInputs()
        inputs.isListening = true
        inputs.audioLevel = 0.4
        inputs.isSpeaking = true
        #expect(PresenceState.derive(from: inputs) == .speaking)
        inputs.isSpeaking = false
        #expect(PresenceState.derive(from: inputs) == .listening(level: 0.4))
        #expect(PresenceState.speaking.isContinuouslyAnimated)
        #expect(!PresenceState.speaking.accessibilityLabel.isEmpty)
        #expect(PresenceState.speaking.caption != PresenceState.listening(level: 0).caption)
    }

    // MARK: Enum presentation

    @Test("Every call state has a label and an icon (never colour alone)")
    func callPresentation() {
        for status in CallStatus.allCases {
            #expect(!status.label.isEmpty)
            #expect(!status.icon.isEmpty)
        }
        for result in CallResult.allCases {
            #expect(!result.label.isEmpty)
            #expect(!result.icon.isEmpty)
        }
        for note in CallNoteCode.allCases {
            #expect(!note.label.isEmpty)
        }
        #expect(CallResult.completed.tookPlace && CallResult.answered.tookPlace)
        #expect(!CallResult.busy.tookPlace && !CallResult.voicemail.tookPlace)
        #expect(CallStatus.ringing.isLive && !CallStatus.ended.isLive && !CallStatus.outcomeUnknown.isLive)
        #expect(ToolId.phoneCall.label != ToolId.unknown.label)
        #expect(MissingInfo.phoneNumber.label != MissingInfo.unknown.label)
        #expect(EvidenceMediaType.mpeg.fileExtension == "mp3")
    }
}
