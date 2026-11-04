import Foundation
import Observation

/// Editable mirror of the server preferences shown in Settings. Each change is sent with
/// `PATCH /v1/me`; on failure the control returns to the server's value, so the screen
/// never shows a setting that is not actually in effect.
@MainActor
@Observable
final class SettingsModel {
    var theme: ThemePreference = .system
    var speakResponses = false
    var recognitionLocale: RecognitionLocale = .auto
    // Phase D: voice conversation
    var conversationMode = false
    /// 0.5…2 (1 = normal).
    var speakingRate = VoiceLimits.speakingRateDefault
    /// The pause that ends an utterance, in milliseconds (600…4000).
    var endOfSpeechSilenceMs = VoiceLimits.endOfSpeechSilenceMsDefault
    var voiceNames = Preferences.Voice.VoiceNames.defaults
    var autoApproveEmailToSelf = false
    var allowExternalModels = true
    /// An IANA zone from the server's list (`GET /v1/meta/time-zones`).
    var timeZone = ""
    var memoryRetention: RetentionSetting = .forever
    var taskRetention: RetentionSetting = .forever

    private(set) var savingCount = 0
    private(set) var errorMessage: String?
    private(set) var connections: [Connection] = []
    private(set) var connectionsError: String?
    private(set) var connectionsLoaded = false

    /// Copies the server state into the controls.
    func sync(from me: Me?) {
        guard let me else { return }
        theme = me.theme == .unknown ? .system : me.theme
        speakResponses = me.preferences.voice.speakResponses
        recognitionLocale = me.preferences.voice.recognitionLocale == .unknown ? .auto : me.preferences.voice.recognitionLocale
        conversationMode = me.preferences.voice.conversationMode
        speakingRate = VoiceLimits.clampRate(me.preferences.voice.speakingRate)
        endOfSpeechSilenceMs = VoiceLimits.clampSilence(me.preferences.voice.endOfSpeechSilenceMs)
        voiceNames = me.preferences.voice.voiceNames
        autoApproveEmailToSelf = me.preferences.autonomy.autoApproveEmailToSelf
        allowExternalModels = me.preferences.ai.allowExternalModels
        timeZone = me.timeZone
        memoryRetention = RetentionSetting(days: me.preferences.retention.memoryDays)
        taskRetention = RetentionSetting(days: me.preferences.retention.taskHistoryDays)
    }

    /// The patch needed to make the server match the controls, or nil if it already does.
    func pendingPatch(against me: Me?) -> UpdateMeRequest? {
        guard let me else { return nil }
        var patch = UpdateMeRequest()
        var preferences = PreferencesPatch()
        var changed = false
        if theme != me.theme, theme != .unknown {
            patch.theme = theme
            changed = true
        }
        if let voice = Self.voicePatch(
            speakResponses: speakResponses,
            recognitionLocale: recognitionLocale,
            conversationMode: conversationMode,
            speakingRate: speakingRate,
            endOfSpeechSilenceMs: endOfSpeechSilenceMs,
            voiceNames: voiceNames,
            against: me.preferences.voice
        ) {
            preferences.voice = voice
            changed = true
        }
        if autoApproveEmailToSelf != me.preferences.autonomy.autoApproveEmailToSelf {
            preferences.autonomy = PreferencesPatch.Autonomy(autoApproveEmailToSelf: autoApproveEmailToSelf)
            changed = true
        }
        if allowExternalModels != me.preferences.ai.allowExternalModels {
            preferences.ai = PreferencesPatch.AI(allowExternalModels: allowExternalModels)
            changed = true
        }
        if !timeZone.isEmpty, timeZone != me.timeZone {
            patch.timeZone = timeZone
            changed = true
        }
        let retention = me.preferences.retention
        if memoryRetention.days != retention.memoryDays || taskRetention.days != retention.taskHistoryDays {
            preferences.retention = PreferencesPatch.Retention(
                memoryDays: memoryRetention.days != retention.memoryDays ? memoryRetention : nil,
                taskHistoryDays: taskRetention.days != retention.taskHistoryDays ? taskRetention : nil
            )
            changed = true
        }
        guard changed else { return nil }
        if preferences != PreferencesPatch() { patch.preferences = preferences }
        return patch
    }

    /// Only the voice fields that differ from the server's (nil when none does). A voice per
    /// language is set, or reset to the system default with an explicit null.
    nonisolated static func voicePatch(
        speakResponses: Bool,
        recognitionLocale: RecognitionLocale,
        conversationMode: Bool,
        speakingRate: Double,
        endOfSpeechSilenceMs: Int,
        voiceNames: Preferences.Voice.VoiceNames,
        against stored: Preferences.Voice
    ) -> PreferencesPatch.Voice? {
        var patch = PreferencesPatch.Voice()
        if speakResponses != stored.speakResponses { patch.speakResponses = speakResponses }
        if recognitionLocale != stored.recognitionLocale, recognitionLocale != .unknown {
            patch.recognitionLocale = recognitionLocale
        }
        if conversationMode != stored.conversationMode { patch.conversationMode = conversationMode }
        let rate = (VoiceLimits.clampRate(speakingRate) * 10).rounded() / 10
        if abs(rate - stored.speakingRate) > 0.001 { patch.speakingRate = rate }
        let silence = VoiceLimits.clampSilence(endOfSpeechSilenceMs)
        if silence != stored.endOfSpeechSilenceMs { patch.endOfSpeechSilenceMs = silence }
        var names = PreferencesPatch.Voice.VoiceNames()
        names.en = nameChange(voiceNames.en, from: stored.voiceNames.en)
        names.de = nameChange(voiceNames.de, from: stored.voiceNames.de)
        names.ar = nameChange(voiceNames.ar, from: stored.voiceNames.ar)
        if names != PreferencesPatch.Voice.VoiceNames() { patch.voiceNames = names }
        return patch == PreferencesPatch.Voice() ? nil : patch
    }

    private nonisolated static func nameChange(_ new: String?, from old: String?) -> NullablePatch<String>? {
        guard new != old else { return nil }
        if let new, !new.isEmpty { return .set(String(new.prefix(VoiceLimits.maxVoiceNameChars))) }
        return .remove
    }

    func save(app: AppModel) async {
        guard let patch = pendingPatch(against: app.me) else { return }
        savingCount += 1
        defer { savingCount -= 1 }
        errorMessage = nil
        do {
            try await app.updateMe(patch)
        } catch is CancellationError {
            sync(from: app.me)
        } catch {
            errorMessage = ErrorText.message(for: error)
            sync(from: app.me)
        }
    }

    func loadConnections(api: APIClient) async {
        do {
            connections = try await api.connections()
            connectionsError = nil
            connectionsLoaded = true
        } catch is CancellationError {
            return
        } catch {
            connectionsError = ErrorText.message(for: error)
        }
    }
}

@MainActor
@Observable
final class SessionsModel {
    private(set) var sessions: [SessionInfo] = []
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?
    private(set) var revokingIds: Set<String> = []

    func load(api: APIClient) async {
        do {
            sessions = try await api.sessions()
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func revoke(_ session: SessionInfo, api: APIClient) async {
        guard !session.current, !revokingIds.contains(session.id) else { return }
        revokingIds.insert(session.id)
        defer { revokingIds.remove(session.id) }
        do {
            try await api.revokeSession(id: session.id)
            sessions.removeAll { $0.id == session.id }
        } catch let error as ApiError where error.code == .notFound {
            sessions.removeAll { $0.id == session.id }
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}
