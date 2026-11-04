import Foundation
import Testing
@testable import Jarvis

/// Phase D shapes decoded from fixtures validated against the contracts
/// (scripts/validate-fixtures.ts): the phone-call approval, calls in task details (a completed
/// call and scenario 4's busy line), a call with every turn, the calls page, the do-not-call
/// list, a phone verification, a conversation voice session, the new voice preferences and the
/// phone number, and newer-server values of every call enum.
@Suite("Phase D decoding")
struct PhaseDDecodingTests {
    @Test("Me: voice conversation preferences and the verified phone number")
    func me() throws {
        let me = try Fixtures.decode(Me.self, "me")
        let voice = me.preferences.voice
        #expect(voice.conversationMode)
        #expect(voice.speakingRate == 1.2)
        #expect(voice.endOfSpeechSilenceMs == 1_800)
        #expect(voice.voiceNames.de == "com.apple.voice.premium.de-DE.Anna")
        #expect(voice.voiceNames[.de] == "com.apple.voice.premium.de-DE.Anna")
        #expect(voice.voiceNames.en == nil)
        #expect(me.phoneNumber == "+4930123456789")
        #expect(me.phoneNumberVerifiedAt != nil)

        let login = try Fixtures.decode(LoginResponse.self, "login-response")
        #expect(login.user.phoneNumber == nil)
        #expect(login.user.phoneNumberVerifiedAt == nil)
    }

    @Test("An older server's voice preferences get the contract defaults")
    func olderVoicePreferences() throws {
        let me = try Fixtures.decode(Me.self, "me-before-phase-b")
        let voice = me.preferences.voice
        #expect(!voice.conversationMode)
        #expect(voice.speakingRate == VoiceLimits.speakingRateDefault)
        #expect(voice.endOfSpeechSilenceMs == VoiceLimits.endOfSpeechSilenceMsDefault)
        #expect(voice.voiceNames == .defaults)
        #expect(me.phoneNumber == nil)
    }

    @Test("phone_call approval: number, script, shared details, limits, recording, transfer, cost")
    func phoneCallApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-phone-call")
        #expect(approval.toolId == .phoneCall)
        #expect(approval.isReviewable)
        #expect(approval.reasons.contains("PHONE_CALL"))
        guard case .phoneCall(let call) = approval.details else {
            Issue.record("Expected phone_call details")
            return
        }
        #expect(call.to == "+4930123456700")
        #expect(call.toDisplay == "+49 30 123456700")
        #expect(call.country == "DE")
        #expect(call.calleeName == "Praxis Dr. Weber")
        #expect(call.onBehalfOf == "Ada Lovelace")
        #expect(call.callerId == "+4930555000111")
        #expect(call.language == .de)
        #expect(call.purpose == .availability)
        #expect(call.dialog == .scripted)
        #expect(call.script.opening.contains("KI-Assistent"))
        #expect(call.script.recordingQuestion == nil)
        #expect(call.script.questions.count == 1)
        #expect(call.date == "2026-11-10")
        #expect(call.window == LocalTimeWindow(start: "09:00", end: "12:00"))
        #expect(call.shareInfo == [CallShareItem(label: "Name", value: "Ada Lovelace")])
        #expect(call.maxDurationSeconds == 300)
        #expect(call.allowedHours.timeZone == "Europe/Berlin")
        #expect(call.recording == .off)
        #expect(call.voicemail == .hangUp)
        #expect(call.transfer.allowed)
        #expect(call.transfer.to == "+49 30 ••• •• 89")
        #expect(!call.binding)
        #expect(call.costEstimate == Money(amountMicro: 250_000, currency: "USD"))
        #expect(approval.summaryMessage?.key == "approval.call")
        #expect(approval.displaySummary.contains("+4930123456700"))
    }

    @Test("A phone_call approval with a value this build doesn't know can't be approved")
    func phoneCallNotReviewable() throws {
        var object = try #require(try JSONSerialization.jsonObject(with: Fixtures.data("approval-phone-call")) as? [String: Any])
        var details = try #require(object["details"] as? [String: Any])
        details["recording"] = "always"
        object["details"] = details
        let data = try JSONSerialization.data(withJSONObject: object)
        let approval = try JSONCoding.makeDecoder().decode(Approval.self, from: data)
        guard case .phoneCall(let call) = approval.details else {
            Issue.record("Expected phone_call details")
            return
        }
        #expect(call.recording == .unknown)
        #expect(!approval.isReviewable)
    }

    @Test("Task with a completed call: outcome, collected times, turns, timeline, evidence")
    func completedCall() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail-call")
        #expect(detail.steps[0].toolId == .phoneCall)
        #expect(!detail.hasUnknownCallState)
        let call = try #require(detail.calls?.first)
        #expect(call.status == .ended)
        #expect(call.result == .completed)
        #expect(call.result?.tookPlace == true)
        #expect(call.displayName == "Praxis Dr. Weber")
        #expect(call.answeredBy == .human)
        #expect(call.aiDisclosedAt != nil)
        #expect(call.recording.mode == .off)
        #expect(call.recording.consent == .notAsked)
        #expect(!call.hasConsentedRecording)
        #expect(call.transfer.status == .notRequested)
        #expect(call.transfer.status.label == nil)
        #expect(call.durationSeconds == 32)
        #expect(call.price == Money(amountMicro: 13_000, currency: "USD"))
        #expect(call.failureReason == nil)
        #expect(call.failureText == nil)
        #expect(call.timeline.map(\.status) == [.queued, .dialing, .ringing, .inProgress, .ended])
        #expect(call.timeline[3].providerStatus == "in-progress")

        let outcome = try #require(call.outcome)
        #expect(outcome.goalReached)
        #expect(outcome.details.date == "2026-11-10")
        #expect(outcome.details.times == ["09:30", "11:00"])
        #expect(!outcome.details.isEmpty)
        #expect(outcome.notes == [.injectionFlagged, .lowConfidence])
        #expect(outcome.summaryMessage?.key == "result.callCompleted")

        #expect(call.turns.count == 6)
        #expect(call.turns[0].kind == .disclosure)
        #expect(call.turns[0].speaker == .agent)
        let flagged = call.turns[2]
        #expect(flagged.speaker == .callee)
        #expect(flagged.flagged)
        #expect(!flagged.isUncertain)
        #expect(call.turns[4].isUncertain)
        #expect(!call.turns[0].isUncertain)

        let codes = detail.steps[0].evidence.compactMap(\.code)
        #expect(codes == ["CALL_PLACED", "AI_DISCLOSED", "CALL_TRANSCRIPT", "CALL_ENDED"])
        for evidence in detail.steps[0].evidence {
            #expect(EvidenceText.title(code: evidence.code ?? "") != nil)
        }
    }

    @Test("Scenario 4: a busy line fails the step with its reason; retrying is safe")
    func busyCall() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail-call-busy")
        #expect(detail.status == .failed)
        #expect(detail.canRetry)
        #expect(!detail.hasUnknownOutcome)
        let error = try #require(detail.error)
        #expect(error.code == .toolFailed)
        #expect(error.reason == "CALL_BUSY")
        #expect(error.retryable)
        #expect(TaskErrorText.describe(error) != ErrorText.codeMessage(.toolFailed))
        let call = try #require(detail.calls?.first)
        #expect(call.result == .busy)
        #expect(call.result?.tookPlace == false)
        #expect(call.aiDisclosedAt == nil)
        #expect(call.turns.isEmpty)
        #expect(call.failureReason == "CALL_BUSY")
        #expect(call.failureText == TaskErrorText.reasonText("CALL_BUSY", params: [:]))
    }

    @Test("GET /v1/calls items carry no turns or timeline; an unconfirmed call is not a failure")
    func callsPage() throws {
        let page = try Fixtures.decode(Page<CallSummary>.self, "calls-page")
        #expect(page.items.count == 3)
        #expect(page.nextCursor != nil)
        #expect(page.items.allSatisfy { $0.turns.isEmpty && $0.timeline.isEmpty })
        // List items carry their task's title (older servers: none).
        #expect(page.items[0].displayTaskTitle == "Call the dentist")
        #expect(page.items[2].displayTaskTitle == nil)
        let unknown = page.items[1]
        #expect(unknown.status == .outcomeUnknown)
        #expect(unknown.result == nil)
        #expect(unknown.providerCallSid == nil)
        #expect(unknown.failureReason == "CALL_STATE_UNKNOWN")
        #expect(!unknown.status.isLive)
    }

    @Test("A call with every turn")
    func callSession() throws {
        let call = try Fixtures.decode(CallSession.self, "call-session")
        #expect(call.turns.map(\.sequence) == Array(0..<6))
        #expect(call.provider == "twilio")
        #expect(call.providerCallSid == "CA0123456789abcdef0123456789abcdef")
    }

    @Test("Do-not-call entries are masked, with where they came from")
    func doNotCall() throws {
        let list = try Fixtures.decode(ItemList<DoNotCallEntry>.self, "do-not-call")
        #expect(list.items.count == 2)
        #expect(list.items[0].source == .calleeRequest)
        #expect(list.items[0].callId != nil)
        #expect(list.items[0].taskId == "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6f")
        #expect(list.items[1].taskId == nil)
        #expect(list.items[0].number.contains("•"))
        #expect(list.items[1].source == .user)
        #expect(list.items[1].country == nil)
    }

    @Test("Phone verification and the conversation voice session")
    func verificationAndVoiceSession() throws {
        let verification = try Fixtures.decode(PhoneVerification.self, "phone-verification")
        #expect(verification.status == .calling)
        #expect(verification.attemptsLeft == 5)
        let session = try Fixtures.decode(VoiceSession.self, "voice-session")
        #expect(session.mode == .conversation)
        #expect(session.conversationId != nil)
    }

    @Test("Call stream events carry the task in their data")
    func callEvent() throws {
        let event = try Fixtures.decode(StreamEvent.self, "stream-event-call")
        #expect(event.type == .callStatusChanged)
        #expect(event.taskId == nil)
        #expect(event.data["taskId"]?.stringValue == "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e")
        #expect(event.data["status"]?.stringValue == "ringing")
    }

    @Test("Values from a newer server decode to .unknown / .unrecognized")
    func newerValues() throws {
        let call = try Fixtures.decode(CallSession.self, "unknown-values-phase-d")
        #expect(call.purpose == .unknown)
        #expect(call.status == .unrecognized)
        #expect(call.result == .unknown)
        #expect(call.answeredBy == .unrecognized)
        #expect(call.recording.mode == .unknown)
        #expect(call.recording.consent == .unknown)
        #expect(call.transfer.status == .unknown)
        #expect(call.timeline[1].status == .unrecognized)
        #expect(call.turns[0].speaker == .unknown)
        #expect(call.turns[1].kind == .unknown)
        #expect(call.outcome?.result == .unknown)
        #expect(call.outcome?.notes == [.injectionFlagged, .unknown])
        // The contract's own `unknown` values stay distinct from values this build doesn't know.
        #expect(CallStatus(rawValue: "unknown") == .outcomeUnknown)
        #expect(AnsweredBy(rawValue: "unknown") == .undetermined)
    }

    @Test("Home knows whether phone calls are possible")
    func capability() throws {
        let home = try Fixtures.decode(HomeSnapshot.self, "home-snapshot-upcoming")
        #expect(home.assistant.capabilities.phoneCalls == false)
        let older = try Fixtures.decode(HomeSnapshot.self, "home-snapshot")
        #expect(older.assistant.capabilities.phoneCalls == nil)
    }
}
