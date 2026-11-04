import SwiftUI

// Exactly what a Phase C approval allows, as the server will execute it: every value comes
// from the approval's details (bound to its action hash). Text written by others — event
// titles from invitations, a site's cancellation terms, product names — is shown as it is,
// bidi-isolated, never interpreted.

/// `calendar_event`: what is written to which calendar, when (in the event's zone), and who
/// is told.
struct CalendarEventPreview: View {
    @Environment(AppModel.self) private var app
    let action: ApprovalDetails.CalendarEventAction

    var body: some View {
        Card {
            what
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Calendar"), value: "\(action.provider.name) · \(action.account)")
            Divider().overlay(MeridianColor.border)
            attendees
            if let previous = action.previous {
                Divider().overlay(MeridianColor.border)
                VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                    Text(action.action == .cancel ? String(localized: "The event being cancelled") : String(localized: "Replaces"))
                        .meridianFont(.label)
                        .foregroundStyle(MeridianColor.textSecondary)
                    Text(verbatim: previous.title.bidiIsolated)
                        .meridianFont(.body)
                        .foregroundStyle(MeridianColor.textPrimary)
                    Text(CalendarText.when(start: previous.start, end: previous.end, timeZone: action.timeZone, allDay: action.allDay))
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        if action.conflictCheck, action.action != .cancel {
            NoteView(text: String(localized: "Right before saving, JARVIS checks your calendar again. If the time is taken by then, it stops and nothing is saved."), systemImage: "calendar.badge.exclamationmark")
        } else if !action.conflictCheck, action.action != .cancel {
            NoteView(text: String(localized: "This is saved even if the time overlaps another event in your calendar."), systemImage: "exclamationmark.triangle", tone: .warning)
        }
    }

    /// Title, time in the event's zone (and in the viewer's, when different), place, notes.
    @ViewBuilder
    private var what: some View {
        DetailRow(label: actionLabel, value: action.title.isEmpty ? String(localized: "(no title)") : action.title)
        Divider().overlay(MeridianColor.border)
        DetailRow(
            label: String(localized: "When"),
            value: CalendarText.when(start: action.start, end: action.end, timeZone: action.timeZone, allDay: action.allDay)
        )
        Divider().overlay(MeridianColor.border)
        DetailRow(label: String(localized: "Time zone"), value: RecurrenceText.zoneName(action.timeZone))
        if let viewer = app.me?.timeZone, viewer != action.timeZone, !action.allDay {
            Text("That is \(CalendarText.when(start: action.start, end: action.end, timeZone: viewer, allDay: false)) in your time zone.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        }
        if let location = action.location, !location.isEmpty {
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Location"), value: location)
        }
        if let description = action.description, !description.isEmpty {
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Description"), value: description)
        }
    }

    private var actionLabel: String {
        switch action.action {
        case .create: String(localized: "New event")
        case .update: String(localized: "Changed event")
        case .cancel: String(localized: "Cancelled event")
        case .unknown: String(localized: "Event")
        }
    }

    @ViewBuilder
    private var attendees: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            Text("Guests")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            if action.attendees.isEmpty {
                Text("Only you.")
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
            } else {
                ForEach(action.attendees, id: \.self) { address in
                    Text(verbatim: address)
                        .meridianFont(.body)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .textSelection(.enabled)
                        .environment(\.layoutDirection, .leftToRight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text(notifyText)
                    .meridianFont(.callout)
                    .foregroundStyle(action.notifyAttendees ? MeridianColor.warning : MeridianColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var notifyText: String {
        guard action.notifyAttendees else {
            return String(localized: "Guests are not emailed.")
        }
        let name = action.provider.name.bidiIsolated
        switch action.action {
        case .cancel: return String(localized: "\(name) emails each guest that the event is cancelled.")
        case .update: return String(localized: "\(name) emails each guest the change.")
        case .create, .unknown: return String(localized: "\(name) emails each guest an invitation.")
        }
    }
}

/// `booking`: the slot as the site offered it live, every field the form submits, the
/// price and whether it's binding — and the screenshot it relies on.
struct BookingPreview: View {
    @Environment(AppModel.self) private var app
    let action: ApprovalDetails.BookingAction

    var body: some View {
        Card {
            DetailRow(label: String(localized: "Service"), value: action.service)
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Site"), value: "\(action.siteName) · \(action.siteHost)")
            Divider().overlay(MeridianColor.border)
            DetailRow(
                label: String(localized: "When"),
                value: CalendarText.when(start: action.start, end: action.end, timeZone: action.timeZone, allDay: false, viewerZone: app.me?.timeZone)
            )
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Time zone"), value: RecurrenceText.zoneName(action.timeZone))
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Price"), value: action.price?.formatted ?? String(localized: "The site states no price."))
        }
        FormFieldsCard(fields: action.fields, title: String(localized: "The site's form receives"))
        if action.binding {
            BindingNote(terms: action.cancellationTerms)
        } else if let terms = action.cancellationTerms, !terms.isEmpty {
            TermsCard(terms: terms)
        }
        if let id = action.evidenceArtifactId {
            EvidenceFileButton(artifactId: id, title: String(localized: "View the availability JARVIS read"))
        }
    }
}

/// `purchase`: the exact order — items, quantities, totals, merchant, delivery and payment —
/// and the monthly limit it is checked against.
struct PurchasePreview: View {
    let action: ApprovalDetails.PurchaseAction

    var body: some View {
        Card {
            DetailRow(label: String(localized: "Merchant"), value: "\(action.merchant.name) · \(action.merchant.host)")
            Divider().overlay(MeridianColor.border)
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text("Items")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(Array(action.items.enumerated()), id: \.offset) { item in
                    LineItemRow(title: item.element.title, quantity: item.element.quantity, unitPrice: item.element.unitPrice, lineTotal: item.element.lineTotal)
                    if let host = ExternalLink.host(item.element.productUrl) {
                        Text(verbatim: host)
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textTertiary)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                }
            }
            Divider().overlay(MeridianColor.border)
            AmountRow(label: String(localized: "Subtotal"), money: action.subtotal)
            AmountRow(label: String(localized: "Shipping"), money: action.shipping)
            if let tax = action.tax {
                AmountRow(label: String(localized: "Tax"), money: tax)
            }
            AmountRow(label: String(localized: "Total"), money: action.total, emphasized: true)
        }
        Card {
            DetailRow(label: String(localized: "Delivery"), value: action.delivery.method)
            if let estimate = action.delivery.estimate, !estimate.isEmpty {
                DetailRow(label: String(localized: "Delivery time (as the shop states it)"), value: estimate)
            }
            DetailRow(label: String(localized: "Ships to"), value: action.delivery.address)
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Payment"), value: action.paymentMethod)
        }
        LimitBar(limit: action.limit)
        NoteView(text: String(localized: "JARVIS checks the cart again right before ordering. If the price or the items changed, it stops and nothing is ordered. The order is placed only once."), systemImage: "checkmark.shield")
        if let id = action.evidenceArtifactId {
            EvidenceFileButton(artifactId: id, title: String(localized: "View the cart JARVIS checked"))
        }
    }
}

/// `form_submission`: exactly what the site's form receives.
struct FormSubmissionPreview: View {
    let action: ApprovalDetails.FormSubmissionAction

    var body: some View {
        Card {
            DetailRow(label: String(localized: "Site"), value: "\(action.siteName) · \(action.siteHost)")
            Divider().overlay(MeridianColor.border)
            DetailRow(label: String(localized: "Form"), value: action.form)
        }
        FormFieldsCard(fields: action.fields, title: String(localized: "The form receives"))
        if action.binding {
            BindingNote(terms: nil)
        }
        if let id = action.evidenceArtifactId {
            EvidenceFileButton(artifactId: id, title: String(localized: "View the form JARVIS filled in"))
        }
    }
}

/// Every field a site's form will receive; personal details are marked.
private struct FormFieldsCard: View {
    let fields: [ApprovalDetails.FormField]
    let title: String

    var body: some View {
        Card {
            Text(title)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityAddTraits(.isHeader)
            if fields.isEmpty {
                Text("No details.")
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            ForEach(fields, id: \.self) { field in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: MeridianSpace.s2) {
                        Text(verbatim: field.label.bidiIsolated)
                            .meridianFont(.label)
                            .foregroundStyle(MeridianColor.textSecondary)
                        if field.personal {
                            ToneBadge(label: String(localized: "Personal"), systemImage: "person", tone: .accent)
                        }
                    }
                    Text(verbatim: field.value)
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

private struct BindingNote: View {
    let terms: String?

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Label {
                Text("This is binding with the site")
            } icon: {
                Image(systemName: "exclamationmark.triangle")
                    .accessibilityHidden(true)
            }
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.warning)
            Text("For example, cancellation fees may apply or payment may be due.")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
            if let terms, !terms.isEmpty {
                Text("The site's terms, as shown there:")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                Text(verbatim: terms.bidiIsolated)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(MeridianSpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(MeridianColor.warningSoft, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct TermsCard: View {
    let terms: String

    var body: some View {
        Card {
            Text("The site's cancellation terms, as shown there")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
            Text(verbatim: terms.bidiIsolated)
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// This month's purchases against the limit, after this purchase.
struct LimitBar: View {
    let limit: ApprovalDetails.PurchaseAction.Limit

    private var fraction: Double {
        let monthly = Double(limit.monthly.amountMicro)
        guard monthly > 0 else { return 1 }
        let used = Double(limit.monthly.amountMicro - limit.remainingAfter.amountMicro)
        return min(1, max(0, used / monthly))
    }

    var body: some View {
        Card {
            Text("Monthly purchase limit")
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityAddTraits(.isHeader)
            ProgressView(value: fraction)
                .tint(fraction >= 0.9 ? MeridianColor.warning : MeridianColor.accent)
                .accessibilityLabel(Text("Share of the monthly limit used after this purchase"))
            AmountRow(label: String(localized: "Limit"), money: limit.monthly)
            AmountRow(label: String(localized: "Already spent this month"), money: limit.spentThisMonth)
            AmountRow(label: String(localized: "Left after this purchase"), money: limit.remainingAfter, emphasized: true)
        }
    }
}
