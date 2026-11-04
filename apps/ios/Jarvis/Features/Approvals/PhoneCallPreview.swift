import SwiftUI

/// `phone_call`: exactly what the call will be — who is called (the number as dialled), from
/// which number, for whom, in which language, for what, the script verbatim, what JARVIS may
/// share, when, for how long, whether it records, what happens at a voicemail or when someone
/// asks for a person, and what it may cost. Every value comes from the approval's details
/// (bound to its action hash). Approved by a tap only — never by voice.
struct PhoneCallPreview: View {
    let action: ApprovalDetails.PhoneCallAction

    var body: some View {
        NoteView(
            text: String(localized: "JARVIS says first that it is an AI assistant calling for \(action.onBehalfOf.bidiIsolated). It approves nothing by voice: only your tap here places the call."),
            systemImage: "phone.badge.waveform"
        )
        PhoneCallWhoCard(action: action)
        PhoneCallScriptCard(script: action.script, language: action.language)
        PhoneCallLimitsCard(action: action)
        if !action.shareInfo.isEmpty {
            PhoneCallShareCard(items: action.shareInfo)
        }
        if action.binding {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Label {
                    Text("This call may book a binding appointment")
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.warning)
                Text("JARVIS agrees only to a time on the date and in the window shown above, and confirms it with the words of the script.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(MeridianSpace.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MeridianColor.warningSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
            .accessibilityElement(children: .combine)
        }
    }
}

/// Who is called, by whom, for what.
private struct PhoneCallWhoCard: View {
    let action: ApprovalDetails.PhoneCallAction

    var body: some View {
        Card {
            who
            Divider().overlay(MeridianColor.border)
            what
        }
    }

    @ViewBuilder
    private var who: some View {
        if let name = action.calleeName, !name.isEmpty {
            DetailRow(label: String(localized: "Calls"), value: name.bidiIsolated)
            Divider().overlay(MeridianColor.border)
        }
        PhoneNumberRow(label: String(localized: "Number"), display: action.toDisplay, exact: action.to, country: PhoneText.country(action.country))
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "On behalf of"), value: action.onBehalfOf.bidiIsolated)
        Divider().overlay(MeridianColor.border)
        if let callerId = action.callerId {
            PhoneNumberRow(label: String(localized: "The number they see"), display: action.callerIdDisplay ?? callerId, exact: nil, country: nil)
        } else {
            DetailRow(label: String(localized: "The number they see"), value: String(localized: "Not configured on this server"))
        }
    }

    @ViewBuilder
    private var what: some View {
        DetailRow(label: String(localized: "Language of the call"), value: action.language.languageName)
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Purpose"), value: action.purpose.label)
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Goal"), value: action.goal.bidiIsolated)
    }
}

/// A phone number: the readable form, the exact digits dialled, and the country. Always laid
/// out left to right (also in Arabic).
struct PhoneNumberRow: View {
    let label: String
    let display: String
    let exact: String?
    let country: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(verbatim: display)
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .environment(\.layoutDirection, .leftToRight)
            if let detail {
                Text(verbatim: detail)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var detail: String? {
        let parts = [exact.map { $0.bidiIsolated }, country].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Exactly what JARVIS will say and ask, in the call's language and writing direction.
private struct PhoneCallScriptCard: View {
    let script: CallScript
    let language: AppLocale

    var body: some View {
        Card {
            Text("What JARVIS will say, word for word")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityAddTraits(.isHeader)
            ScriptLine(label: String(localized: "First"), text: script.opening, language: language)
            if let question = script.recordingQuestion {
                ScriptLine(label: String(localized: "Then asks about recording"), text: question, language: language)
            }
            if let message = script.message {
                ScriptLine(label: String(localized: "Message"), text: message, language: language)
            }
            ForEach(Array(script.questions.enumerated()), id: \.offset) { item in
                ScriptLine(
                    label: String(localized: "Question \((item.offset + 1).formatted())"),
                    text: item.element,
                    language: language
                )
            }
            ScriptLine(label: String(localized: "Closing"), text: script.closing, language: language)
            if let voicemail = script.voicemailMessage {
                ScriptLine(label: String(localized: "On a voicemail"), text: voicemail, language: language)
            }
        }
    }
}

private struct ScriptLine: View {
    let label: String
    let text: String
    let language: AppLocale

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(verbatim: text)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .environment(\.layoutDirection, language.isRightToLeft ? .rightToLeft : .leftToRight)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

/// When, for how long, how it talks, recording, voicemail, transfer and cost.
private struct PhoneCallLimitsCard: View {
    let action: ApprovalDetails.PhoneCallAction

    var body: some View {
        Card {
            when
            Divider().overlay(MeridianColor.border)
            how
        }
    }

    @ViewBuilder
    private var when: some View {
        if let date = action.date {
            DetailRow(label: String(localized: "Asks about"), value: dateText(date))
            Divider().overlay(MeridianColor.border)
        }
        DetailRow(
            label: String(localized: "Calls only between"),
            value: "\(LocalTimeText.window(start: action.allowedHours.start, end: action.allowedHours.end)) · \(RecurrenceText.zoneName(action.allowedHours.timeZone))"
        )
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Longest call"), value: PhoneText.duration(action.maxDurationSeconds))
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Cost (at most)"), value: action.costEstimate?.formatted ?? String(localized: "Unknown — the server has no price configured"))
    }

    @ViewBuilder
    private var how: some View {
        DetailRow(label: String(localized: "How JARVIS talks"), value: action.dialog.label)
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Recording"), value: action.recording.label)
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Voicemail"), value: action.voicemail.label)
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Putting them through to you"), value: transferText)
    }

    private func dateText(_ date: String) -> String {
        let day = LocalTimeText.formatDate(date) ?? date
        guard let window = action.window else { return day }
        return String(localized: "\(day), between \(LocalTimeText.window(start: window.start, end: window.end))")
    }

    private var transferText: String {
        guard action.transfer.allowed else {
            return String(localized: "Not allowed. If they ask for a person, JARVIS says you'll call back.")
        }
        if let number = action.transfer.to {
            return String(localized: "Allowed, to your verified number \(number.bidiIsolated), if they ask for a person.")
        }
        return String(localized: "Allowed, but your number isn't verified, so JARVIS says you'll call back.")
    }
}

/// The personal details JARVIS may tell the callee — exactly these.
private struct PhoneCallShareCard: View {
    let items: [CallShareItem]

    var body: some View {
        Card {
            Text("JARVIS may tell them only these details")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityAddTraits(.isHeader)
            ForEach(items, id: \.self) { item in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: MeridianSpace.s2) {
                        Text(verbatim: item.label.bidiIsolated)
                            .meridianFont(.label)
                            .foregroundStyle(MeridianColor.textSecondary)
                        ToneBadge(label: String(localized: "Personal"), systemImage: "person", tone: .accent)
                    }
                    Text(verbatim: item.value)
                        .meridianFont(.body)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
