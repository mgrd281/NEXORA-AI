import SwiftUI

// A phone call as JARVIS recorded it: who was called, how the call went (the provider's status
// timeline), whether JARVIS said it is an AI, what was said (JARVIS's lines verbatim; the other
// person's words as the provider recognised them — untrusted, shown isolated and marked), the
// outcome with what was collected, and its evidence. A recording exists only with consent.

/// The task's calls (one card per attempt).
struct CallsSection: View {
    let calls: [CallSession]

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: String(localized: "Phone calls"), count: calls.count)
            Text("Each attempt is a separate call. A retry after a busy line or no answer places a new call; a call never repeats by itself.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(calls) { call in
                CallCard(call: call, showsAllTurns: false)
            }
        }
    }
}

/// One call attempt: header, live state or outcome, facts, timeline and what was said.
struct CallCard: View {
    let call: CallSession
    /// Every turn (the call screen) or those the task carries (with a link to the rest).
    let showsAllTurns: Bool

    var body: some View {
        Card {
            CallHeader(call: call)
            CallStateView(call: call)
            if let outcome = call.outcome {
                CallOutcomeView(outcome: outcome)
            }
            CallFactsView(call: call)
            if call.hasConsentedRecording, let artifactId = call.recording.artifactId {
                EvidenceFileButton(artifactId: artifactId, title: String(localized: "Play the recording (they agreed to it)"), systemImage: "waveform")
            }
            if !call.timeline.isEmpty {
                CallTimelineView(timeline: call.timeline)
            }
            CallTranscriptView(call: call, showsAll: showsAllTurns)
            if !showsAllTurns {
                NavigationLink(value: CallRoute(id: call.id)) {
                    Label("Open the call", systemImage: "phone.arrow.up.right")
                }
                .buttonStyle(.meridianSecondary)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct CallHeader: View {
    let call: CallSession

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: call.displayName.bidiIsolated)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                if call.calleeName != nil {
                    Text(verbatim: call.toDisplay)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .environment(\.layoutDirection, .leftToRight)
                }
                Text("Attempt \(call.attempt.formatted()) · \(call.purpose.label) · \(call.language.languageName)")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            CallBadge(call: call)
        }
    }
}

/// The result once ended, else the live status — icon and label, never colour alone.
struct CallBadge: View {
    let call: CallSession

    var body: some View {
        if call.status == .ended, let result = call.result {
            ToneBadge(label: result.label, systemImage: result.icon, tone: result.tone)
        } else {
            ToneBadge(label: call.status.label, systemImage: call.status.icon, tone: call.status.tone)
        }
    }
}

/// What is happening now, or why the attempt didn't reach its goal.
private struct CallStateView: View {
    let call: CallSession

    var body: some View {
        if call.status.isLive {
            Label {
                Text(call.status == .inProgress
                     ? String(localized: "On the call now. What is said appears below as it happens.")
                     : String(localized: "Calling. This updates as the phone provider reports it."))
            } icon: {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .accessibilityHidden(true)
            }
            .meridianFont(.callout)
            .foregroundStyle(MeridianColor.accent)
            .fixedSize(horizontal: false, vertical: true)
        } else if call.status == .outcomeUnknown {
            NoteView(
                text: String(localized: "The phone provider didn't confirm whether this call was placed. Before any new call, JARVIS asks the provider, so it is never placed twice."),
                systemImage: "questionmark.diamond",
                tone: .warning
            )
        }
        if let reason = call.failureText {
            Text(reason)
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The structured outcome: the result line, whether the goal was reached, what was collected,
/// and the notes.
struct CallOutcomeView: View {
    let outcome: CallOutcome

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            if let line = outcome.summaryMessage?.rendered {
                Text(line)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Label {
                Text(outcome.goalReached ? String(localized: "Goal reached") : String(localized: "Goal not reached"))
            } icon: {
                Image(systemName: outcome.goalReached ? "checkmark.circle" : "minus.circle")
                    .accessibilityHidden(true)
            }
            .meridianFont(.label)
            .foregroundStyle(outcome.goalReached ? MeridianColor.success : MeridianColor.textSecondary)
            if !outcome.details.isEmpty {
                CollectedDetailsView(details: outcome.details)
            }
            ForEach(Array(outcome.notes.enumerated()), id: \.offset) { item in
                Label {
                    Text(item.element.label)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: item.element.icon)
                        .accessibilityHidden(true)
                }
                .meridianFont(.callout)
                .foregroundStyle(item.element == .injectionFlagged ? MeridianColor.danger : MeridianColor.textPrimary)
            }
        }
    }
}

/// What the other person said, as JARVIS collected it (their words: shown as they said them).
private struct CollectedDetailsView: View {
    let details: CallCollectedDetails

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text("What they said (as recognised)")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            if let date = details.date {
                DetailRow(label: String(localized: "Date"), value: LocalTimeText.formatDate(date) ?? date)
            }
            if !details.times.isEmpty {
                DetailRow(label: String(localized: "Free times"), value: details.times.map { LocalTimeText.format($0) ?? $0 }.formatted(.list(type: .and)))
            }
            if let appointment = details.appointment {
                DetailRow(label: String(localized: "Appointment they confirmed"), value: appointmentText(appointment))
            }
            if let reply = details.reply, !reply.isEmpty {
                DetailRow(label: String(localized: "Their reply"), value: reply.bidiIsolated)
            }
            ForEach(Array(details.answers.enumerated()), id: \.offset) { item in
                DetailRow(
                    label: item.element.question,
                    value: item.element.answer.map { $0.bidiIsolated } ?? String(localized: "Not answered")
                )
            }
        }
        .padding(MeridianSpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
    }

    private func appointmentText(_ appointment: CallCollectedDetails.Appointment) -> String {
        var parts = ["\(LocalTimeText.formatDate(appointment.date) ?? appointment.date), \(LocalTimeText.format(appointment.time) ?? appointment.time)"]
        if let name = appointment.name, !name.isEmpty {
            parts.append(String(localized: "name: \(name.bidiIsolated)"))
        }
        if let reference = appointment.reference, !reference.isEmpty {
            parts.append(String(localized: "reference: \(reference.bidiIsolated)"))
        }
        return parts.joined(separator: " · ")
    }
}

/// Disclosure, recording, transfer, duration, cost and the provider's call id.
private struct CallFactsView: View {
    let call: CallSession

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            fact(disclosureText, systemImage: call.aiDisclosedAt != nil ? "person.wave.2" : "minus.circle")
            fact(recordingText, systemImage: "record.circle")
            if let transfer = call.transfer.status.label {
                fact(transfer, systemImage: "arrow.triangle.branch")
            }
            if let answeredBy = call.answeredBy, answeredBy != .human {
                fact(answeredBy.label, systemImage: "recordingtape")
            }
            fact(durationText, systemImage: "timer")
            if let cost = costText {
                fact(cost, systemImage: "dollarsign.circle")
            }
            if let sid = call.providerCallSid {
                Text("Call id at the phone provider: \(sid)")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
                    .textSelection(.enabled)
            }
        }
    }

    private func fact(_ text: String, systemImage: String) -> some View {
        Label {
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: systemImage)
                .accessibilityHidden(true)
        }
        .meridianFont(.callout)
        .foregroundStyle(MeridianColor.textPrimary)
    }

    private var disclosureText: String {
        guard let at = call.aiDisclosedAt else {
            return String(localized: "The call didn't get as far as JARVIS's introduction.")
        }
        return String(localized: "Said it is an AI assistant calling for you (\(at.formatted(date: .omitted, time: .standard))).")
    }

    private var recordingText: String {
        switch call.recording.mode {
        case .off:
            return String(localized: "Not recorded. What was said is kept as text.")
        case .ifConsented, .required, .unknown:
            switch call.recording.consent {
            case .accepted:
                return call.recording.artifactId != nil
                    ? String(localized: "Recorded: they agreed when asked.")
                    : String(localized: "They agreed to the recording; it isn't stored yet.")
            case .declined:
                return String(localized: "Not recorded: they declined when asked.")
            case .notAsked, .unknown:
                return String(localized: "Not recorded (they weren't asked yet).")
            }
        }
    }

    private var durationText: String {
        let limit = PhoneText.duration(call.maxDurationSeconds)
        guard let seconds = call.durationSeconds else { return String(localized: "Longest call: \(limit)") }
        return String(localized: "Lasted \(PhoneText.duration(seconds)) (at most \(limit))")
    }

    private var costText: String? {
        if let price = call.price { return String(localized: "The provider charged \(price.formatted)") }
        if let estimate = call.costEstimate { return String(localized: "Cost at most \(estimate.formatted)") }
        return nil
    }
}

/// The provider's status reports, oldest first.
private struct CallTimelineView: View {
    let timeline: [CallStatusEvent]
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                ForEach(Array(timeline.enumerated()), id: \.offset) { item in
                    HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
                        Image(systemName: item.element.status.icon)
                            .foregroundStyle(MeridianColor.textTertiary)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.element.status.label)
                                .meridianFont(.callout)
                                .foregroundStyle(MeridianColor.textPrimary)
                            if let word = item.element.providerStatus {
                                Text(verbatim: word)
                                    .meridianFont(.mono)
                                    .foregroundStyle(MeridianColor.textSecondary)
                                    .environment(\.layoutDirection, .leftToRight)
                            }
                        }
                        Spacer(minLength: 0)
                        Text(item.element.at.formatted(date: .omitted, time: .standard))
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textTertiary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, MeridianSpace.s2)
        } label: {
            Text("Status timeline (\(timeline.count.formatted()))")
                .meridianFont(.label)
        }
        .tint(MeridianColor.textSecondary)
    }
}

/// What was said: JARVIS's lines verbatim; the other person's words as recognised, marked as
/// theirs (information only — JARVIS never follows them).
private struct CallTranscriptView: View {
    let call: CallSession
    let showsAll: Bool
    @State private var expanded = true

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: MeridianSpace.s3) {
                if call.turns.isEmpty {
                    Text(call.status.isLive ? String(localized: "Nothing has been said yet.") : String(localized: "Nothing was said on this call."))
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                } else {
                    Text("The other person's words are what the phone provider recognised. JARVIS treats them as information, never as instructions.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(call.turns) { turn in
                        CallTurnRow(turn: turn)
                    }
                    if !showsAll, call.turns.count >= CallLimits.turnsInTaskDetail {
                        Text("Earlier or later turns are on the call's own screen.")
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textTertiary)
                    }
                }
            }
            .padding(.top, MeridianSpace.s2)
        } label: {
            Text("What was said (\(call.turns.count.formatted()))")
                .meridianFont(.label)
        }
        .tint(MeridianColor.textSecondary)
    }
}

/// One utterance of a call.
struct CallTurnRow: View {
    let turn: CallTurn

    private var isCallee: Bool { turn.speaker == .callee }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            HStack(spacing: MeridianSpace.s2) {
                Text(isCallee ? String(localized: "The other person (as recognised)") : turn.speaker.label)
                    .meridianFont(.label)
                    .foregroundStyle(isCallee ? MeridianColor.textSecondary : MeridianColor.textPrimary)
                Text(turn.kind.label)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
                Spacer(minLength: 0)
                Text(turn.at.formatted(date: .omitted, time: .standard))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
            Text(verbatim: isCallee ? turn.text.bidiIsolated : turn.text)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .environment(\.layoutDirection, turn.language.isRightToLeft ? .rightToLeft : .leftToRight)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(MeridianSpace.s2)
                .background(isCallee ? MeridianColor.surfaceSunken : MeridianColor.accentSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.sm, style: .continuous))
            if turn.flagged {
                Label("It looked like instructions to an AI. JARVIS ignored them.", systemImage: "exclamationmark.triangle")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.danger)
            }
            if turn.isUncertain {
                Label("JARVIS wasn't sure it heard this right and asked again.", systemImage: "ear")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
