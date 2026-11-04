import SwiftUI

// Phase C parts of the task screen. Step outputs are the server's redacted previews
// (`TaskStep.output`, not a frozen contract): each view reads them defensively and shows
// nothing rich when a field is missing — the generic "Details" disclosure still lists them.

extension JSONValue {
    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
}

/// Typed reads of step output previews.
enum StepPreview {
    static func money(_ value: JSONValue?) -> Money? {
        guard let object = value?.objectValue,
              let micro = object["amountMicro"]?.numberValue, micro.rounded() == micro, abs(micro) < 9e15,
              let currency = object["currency"]?.stringValue, currency.count == 3
        else { return nil }
        return Money(amountMicro: Int64(micro), currency: currency)
    }

    static func objects(_ value: JSONValue?) -> [[String: JSONValue]] {
        (value?.arrayValue ?? []).compactMap(\.objectValue)
    }

    static func date(_ value: JSONValue?) -> Date? {
        value?.stringValue.flatMap(JSONCoding.parseDate)
    }

    /// A small whole number (counts, quantities); nil for anything else.
    static func int(_ value: JSONValue?) -> Int? {
        guard let number = value?.numberValue, number.isFinite, number.rounded() == number, abs(number) < 1_000_000_000
        else { return nil }
        return Int(number)
    }

    static func strings(_ value: JSONValue?) -> [String] {
        (value?.arrayValue ?? []).compactMap(\.stringValue)
    }

    /// The order a `shop.checkout` step placed.
    static func orderId(_ step: TaskStep) -> String? {
        guard step.toolId == .shopCheckout else { return nil }
        return step.output?["orderId"]?.stringValue
    }

    /// The booking a `booking.book` step made.
    static func bookingId(_ step: TaskStep) -> String? {
        guard step.toolId == .bookingBook else { return nil }
        return step.output?["bookingId"]?.stringValue
    }

    /// The merchant's cart link of a `shop.prepare_cart` step whose shop can't check out here.
    static func cartHandoverURL(_ steps: [TaskStep]) -> URL? {
        for step in steps.reversed() where step.toolId == .shopPrepareCart {
            if let url = ExternalLink.url(step.output?["handoverUrl"]?.stringValue) { return url }
        }
        return nil
    }
}

// MARK: - Browser sessions

/// The browser agent's runs for this task: site, status, why it stopped, where to continue,
/// and the evidence it kept.
struct BrowserSessionsSection: View {
    let sessions: [BrowserSession]

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: String(localized: "On supported sites"), count: sessions.count)
            Text("JARVIS used an isolated browser that keeps nothing between visits, and stops at CAPTCHAs and sign-ins instead of working around them.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(sessions) { session in
                BrowserSessionCard(session: session)
            }
        }
    }
}

private struct BrowserSessionCard: View {
    @Environment(\.openURL) private var openURL
    let session: BrowserSession

    var body: some View {
        Card {
            HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(BrowserOperationText.label(session.operation))
                        .meridianFont(.bodyStrong)
                        .foregroundStyle(MeridianColor.textPrimary)
                    Text(verbatim: session.siteId)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .environment(\.layoutDirection, .leftToRight)
                }
                Spacer(minLength: 0)
                ToneBadge(label: session.status.label, systemImage: session.status.icon, tone: session.status.tone)
            }
            if let reason = session.stopReason {
                Text(reason.label)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if session.status == .interrupted {
                Text("The browser stopped mid-way. If this step submits something, JARVIS can't tell whether it went through.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if session.status == .handover, let url = ExternalLink.url(session.handoverUrl) {
                Button {
                    openURL(url)
                } label: {
                    Label("Continue on the site", systemImage: "safari")
                }
                .buttonStyle(.meridianPrimary)
                .accessibilityHint(Text("Opens the site in your browser. JARVIS doesn't continue there for you."))
            }
            Text("Pages: \(session.navigations.formatted()) · Requests: \(session.requests.formatted()) · Blocked: \(session.blockedRequests.formatted())")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textTertiary)
            ForEach(session.artifacts) { artifact in
                EvidenceArtifactView(artifact: artifact)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Step outputs

/// A readable view of a Phase C step's output preview (nothing when it doesn't apply).
struct StepOutputView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let step: TaskStep

    private var output: [String: JSONValue] { step.output ?? [:] }

    var body: some View {
        switch step.toolId {
        case .shopSearch: shopSearch
        case .shopCompare: shopCompare
        case .shopPrepareCart: cart
        case .bookingFindSlots: slots
        case .emailSearch, .calendarList, .calendarFreeBusy:
            untrustedText(output["text"]?.stringValue, source: sourceLabel)
        case .emailReadThread:
            untrustedText(output["digest"]?.stringValue, source: String(localized: "From your mailbox, written by others"))
        case .browserRead: browserRead
        case .emailDraftReply: draft
        case .emailTrackReplies: watch
        case .calendarCreateEvent, .calendarUpdateEvent: event
        default: EmptyView()
        }
    }

    private var sourceLabel: String {
        step.toolId == .emailSearch
            ? String(localized: "From your mailbox, written by others")
            : String(localized: "From your calendar; invitations are written by others")
    }

    private var injectionFlagged: Bool { output["suspectedInjection"]?.boolValue == true }

    @ViewBuilder
    private func untrustedText(_ text: String?, source: String) -> some View {
        if let text, !text.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s1) {
                Text(source)
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                if injectionFlagged {
                    Label("Some of this text tries to give instructions to AI assistants. JARVIS doesn't follow it.", systemImage: "exclamationmark.triangle")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.danger)
                }
                Text(verbatim: text)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .textSelection(.enabled)
                    .lineLimit(24)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(MeridianSpace.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
            .accessibilityElement(children: .combine)
        }
    }

    // Shopping

    @ViewBuilder
    private var shopSearch: some View {
        let sites = StepPreview.objects(output["sites"])
        let offers = StepPreview.objects(output["offers"])
        if !sites.isEmpty || !offers.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                ForEach(Array(sites.enumerated()), id: \.offset) { item in
                    siteRow(item.element)
                }
                if !offers.isEmpty {
                    Text("Offers as the shops show them")
                        .meridianFont(.label)
                        .foregroundStyle(MeridianColor.textSecondary)
                    ForEach(Array(offers.enumerated()), id: \.offset) { item in
                        offerRow(item.element, rank: nil, best: false)
                    }
                }
                if injectionFlagged {
                    Label("Some product text tries to give instructions to AI assistants. JARVIS doesn't follow it.", systemImage: "exclamationmark.triangle")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.danger)
                }
            }
        }
    }

    private func siteRow(_ site: [String: JSONValue]) -> some View {
        let status = site["status"]?.stringValue.flatMap(ShoppingComparison.Site.Status.init(rawValue:)) ?? .unknown
        let reason = site["reason"]?.stringValue.flatMap(BrowserStopReason.init(rawValue:))
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: MeridianSpace.s2) {
                Text(verbatim: site["siteId"]?.stringValue ?? "—")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .environment(\.layoutDirection, .leftToRight)
                ToneBadge(label: status.label, systemImage: status == .ok ? "checkmark" : "exclamationmark", tone: status.tone)
            }
            if let reason, status != .ok {
                Text(reason.label)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var shopCompare: some View {
        let ranking = StepPreview.objects(output["ranking"])
        if !ranking.isEmpty {
            let best = output["best"]?.objectValue
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text("Compared by total price including shipping")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(Array(ranking.enumerated()), id: \.offset) { item in
                    offerRow(item.element, rank: item.offset + 1, best: isBest(item.element, best))
                }
                if output["mixedCurrencies"]?.boolValue == true {
                    NoteView(text: String(localized: "The offers are in different currencies. JARVIS doesn't convert them, because it has no exchange rate it can verify."), systemImage: "exclamationmark.triangle", tone: .warning)
                } else if best == nil {
                    Text("No offer has a known total with shipping, so JARVIS doesn't name a best one.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
                Text("Prices, shipping and delivery come only from the shops' own pages, with screenshots as evidence.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
        }
    }

    private func isBest(_ offer: [String: JSONValue], _ best: [String: JSONValue]?) -> Bool {
        guard let best else { return false }
        return offer["title"] == best["title"] && offer["merchant"] == best["merchant"] && offer["total"] == best["total"]
    }

    private func offerRow(_ offer: [String: JSONValue], rank: Int?, best: Bool) -> some View {
        let total = StepPreview.money(offer["total"])
        let price = StepPreview.money(offer["price"])
        return HStack(alignment: .top, spacing: MeridianSpace.s3) {
            if let rank {
                Text(rank.formatted())
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textTertiary)
                    .frame(minWidth: 16)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: (offer["title"]?.stringValue ?? "—").bidiIsolated)
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: (offer["merchant"]?.stringValue ?? "—").bidiIsolated)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                if best {
                    ToneBadge(label: String(localized: "Lowest known total"), systemImage: "arrow.down.circle", tone: .success)
                }
            }
            Spacer(minLength: MeridianSpace.s2)
            VStack(alignment: .trailing, spacing: 2) {
                if let total {
                    Text(verbatim: total.formatted)
                        .meridianFont(.bodyStrong)
                        .foregroundStyle(MeridianColor.textPrimary)
                    Text("incl. shipping")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textTertiary)
                } else {
                    if let price {
                        Text(verbatim: price.formatted)
                            .meridianFont(.bodyStrong)
                            .foregroundStyle(MeridianColor.textPrimary)
                    }
                    Text("Shipping not stated")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textTertiary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var cart: some View {
        let lines = StepPreview.objects(output["lines"])
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                Text("In the cart at \((output["merchant"]?.stringValue ?? "—").bidiIsolated)")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(Array(lines.enumerated()), id: \.offset) { item in
                    if let lineTotal = StepPreview.money(item.element["lineTotal"]) {
                        LineItemRow(
                            title: item.element["title"]?.stringValue ?? "—",
                            quantity: StepPreview.int(item.element["quantity"]) ?? 1,
                            unitPrice: nil,
                            lineTotal: lineTotal
                        )
                    }
                }
                if let total = StepPreview.money(output["total"]) {
                    AmountRow(label: String(localized: "Total"), money: total, emphasized: true)
                } else {
                    Text("The shop doesn't state the total with shipping yet.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
                Text("Nothing is bought by filling a cart.")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
                if output["checkoutSupported"]?.boolValue == false, let url = ExternalLink.url(output["handoverUrl"]?.stringValue) {
                    Text("JARVIS can't order on this shop. Your cart is ready there: finish the purchase yourself.")
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open the cart on the shop", systemImage: "cart")
                    }
                    .buttonStyle(.meridianSecondary)
                }
            }
        }
    }

    // Booking

    @ViewBuilder
    private var slots: some View {
        let offered = StepPreview.objects(output["slots"])
        let count = StepPreview.int(output["slotCount"]) ?? offered.count
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            if offered.isEmpty {
                Text("The site shows no free appointments right now.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
            } else {
                Text(count > offered.count
                    ? String(localized: "Free appointments the site showed (first \(offered.count.formatted()) of \(count.formatted()))")
                    : String(localized: "Free appointments the site showed"))
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(Array(offered.enumerated()), id: \.offset) { item in
                    if let start = StepPreview.date(item.element["start"]) {
                        Label {
                            Text(CalendarText.when(start: start, end: nil, timeZone: item.element["timeZone"]?.stringValue, allDay: false, viewerZone: app.me?.timeZone))
                        } icon: {
                            Image(systemName: "clock")
                                .accessibilityHidden(true)
                        }
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textPrimary)
                    }
                }
            }
            let required = StepPreview.strings(output["requiredFields"])
            if !required.isEmpty {
                Text("The site's form asks for: \(required.map(\.bidiIsolated).formatted(.list(type: .and)))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // Browser, email, calendar

    @ViewBuilder
    private var browserRead: some View {
        if let excerpt = output["excerpt"]?.stringValue, !excerpt.isEmpty {
            let host = ExternalLink.host(output["url"]?.stringValue) ?? (output["siteId"]?.stringValue ?? "")
            untrustedText(excerpt, source: String(localized: "From \(host.bidiIsolated), as the page states it"))
        }
    }

    @ViewBuilder
    private var draft: some View {
        if output["draftId"]?.stringValue != nil {
            let subject = output["subject"]?.stringValue ?? ""
            Label {
                Text("Draft saved in your mailbox: “\(subject.bidiIsolated)”. Nothing was sent.")
            } icon: {
                Image(systemName: "square.and.pencil")
                    .accessibilityHidden(true)
            }
            .meridianFont(.callout)
            .foregroundStyle(MeridianColor.textPrimary)
        }
    }

    @ViewBuilder
    private var watch: some View {
        if output["watchId"]?.stringValue != nil {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                if let until = StepPreview.date(output["expiresAt"]) {
                    Text("JARVIS tells you when someone replies, until \(MeridianFormat.dateTime(until)).")
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textPrimary)
                }
                NavigationLink(value: EmailWatchesRoute()) {
                    Label("Reply tracking", systemImage: "eye")
                }
                .buttonStyle(.meridianSecondary)
            }
        }
    }

    @ViewBuilder
    private var event: some View {
        if let start = StepPreview.date(output["start"]) {
            let title = output["title"]?.stringValue ?? ""
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title.bidiIsolated)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                Text(CalendarText.when(start: start, end: StepPreview.date(output["end"]), timeZone: app.me?.timeZone, allDay: false))
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Next actions for failures

/// What the user can do about a Phase C failure: reconnect, set the purchase limit, continue
/// on the site, open the cart, or check orders and bookings before retrying.
struct TaskErrorActions: View {
    @Environment(\.openURL) private var openURL
    let error: TaskError
    let detail: TaskDetail
    var onReconnected: () -> Void = {}

    private var provider: OAuthProvider? { OAuthProvider.named(error.params?["provider"]?.stringValue) }

    var body: some View {
        switch error.reason ?? "" {
        case "CONNECTION_EXPIRED", "CONNECTION_SCOPE_MISSING":
            if let provider {
                ReconnectButton(
                    provider: provider,
                    capability: ConnectionCapability.named(error.params?["capability"]?.stringValue)
                ) { _ in onReconnected() }
            } else {
                connectionsLink
            }
        case "CONNECTION_MISSING", "EMAIL_NOT_CONNECTED":
            connectionsLink
        case "PURCHASES_DISABLED", "PURCHASE_LIMIT":
            NavigationLink(value: SpendingRoute()) {
                Label("Open purchase limit", systemImage: "creditcard")
            }
            .buttonStyle(.meridianSecondary)
        case "CAPTCHA_DETECTED", "LOGIN_REQUIRED", "BOT_PROTECTION":
            if let url = ExternalLink.url((detail.browserSessions ?? []).last(where: { $0.status == .handover })?.handoverUrl) {
                Button {
                    openURL(url)
                } label: {
                    Label("Continue on the site", systemImage: "safari")
                }
                .buttonStyle(.meridianSecondary)
            }
        case "CHECKOUT_UNSUPPORTED":
            if let url = StepPreview.cartHandoverURL(detail.steps) {
                Button {
                    openURL(url)
                } label: {
                    Label("Open the cart on the shop", systemImage: "cart")
                }
                .buttonStyle(.meridianSecondary)
            }
        case "ORDER_UNKNOWN":
            NavigationLink(value: OrdersRoute()) {
                Label("Check your orders", systemImage: "bag")
            }
            .buttonStyle(.meridianSecondary)
        case "BOOKING_UNCONFIRMED":
            NavigationLink(value: BookingsRoute()) {
                Label("Check your bookings", systemImage: "calendar.badge.checkmark")
            }
            .buttonStyle(.meridianSecondary)
        // Phase D
        case "DO_NOT_CALL":
            NavigationLink(value: DoNotCallRoute()) {
                Label("Open the do-not-call list", systemImage: "phone.down")
            }
            .buttonStyle(.meridianSecondary)
        case "CALL_STATE_UNKNOWN":
            NavigationLink(value: CallsRoute()) {
                Label("Check your calls", systemImage: "phone.arrow.up.right")
            }
            .buttonStyle(.meridianSecondary)
        default:
            EmptyView()
        }
    }

    private var connectionsLink: some View {
        NavigationLink(value: ConnectionsRoute()) {
            Label("Open Connections", systemImage: MeridianIcon.connections)
        }
        .buttonStyle(.meridianSecondary)
    }
}
