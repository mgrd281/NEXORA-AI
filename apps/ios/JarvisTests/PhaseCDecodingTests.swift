import Foundation
import Testing
@testable import Jarvis

/// Phase C contract fixtures (validated against the Zod schemas by
/// scripts/validate-fixtures.ts): OAuth providers and connections, calendars and Home
/// "Upcoming", email watches, orders, bookings, evidence and browser sessions, the four new
/// approval kinds and email drafts, and values from a newer server decoding leniently.
@Suite("Decoding Phase C contract fixtures")
struct PhaseCDecodingTests {
    private let googleId = "a1c2e3f4-5b6d-4e7f-8a9b-0c1d2e3f4a51"
    private let screenshotId = "bec5d6f7-8c9e-4fa1-9bcd-def76543218e"

    // MARK: Connections

    @Test("Providers: configured or not, exact scopes per capability, revocation")
    func providers() throws {
        let list = try Fixtures.decode(ItemList<ConnectionProviderInfo>.self, "connection-providers")
        try #require(list.items.count == 4)
        let google = list.items[0]
        #expect(google.oauthProvider == .google)
        #expect(google.kind == .oauth)
        #expect(google.configured)
        #expect(google.revocation == .provider)
        #expect(google.scopes(for: .calendarRead).count == 2)
        #expect(google.scopes(for: .mailSend) == ["https://www.googleapis.com/auth/gmail.send"])
        #expect(google.identityScopes == ["openid", "email"])

        let microsoft = list.items[1]
        #expect(microsoft.oauthProvider == .microsoft)
        #expect(!microsoft.configured)
        #expect(microsoft.revocation == .localOnly)

        let smtp = list.items[2]
        #expect(smtp.kind == .smtp)
        #expect(smtp.oauthProvider == nil)
        #expect(smtp.revocation == nil)
        #expect(smtp.capabilities.isEmpty)
    }

    @Test("Connections: expired Google with its capabilities, active Microsoft, SMTP")
    func connections() throws {
        let list = try Fixtures.decode(ItemList<Connection>.self, "connections-phase-c")
        try #require(list.items.count == 3)
        let google = list.items[0]
        #expect(google.oauthProvider == .google)
        #expect(google.status == .expired)
        #expect(google.statusReason == .grantInvalid)
        #expect(google.needsReconnect)
        #expect(google.knownCapabilities == [.mailRead, .mailSend, .calendarRead])
        // An expired connection grants nothing until it is reconnected.
        #expect(!google.grants(.mailRead))
        #expect(google.scopes?.contains("https://www.googleapis.com/auth/gmail.readonly") == true)

        let microsoft = list.items[1]
        #expect(microsoft.grants(.calendarRead))
        #expect(!microsoft.grants(.calendarWrite))
        #expect(!microsoft.needsReconnect)
        #expect(microsoft.statusReason == nil)

        let smtp = list.items[2]
        #expect(smtp.oauthProvider == nil)
        #expect(smtp.capabilities == [])

        // Reconnecting asks for what the connection had, plus what a failed step needed.
        let all = ConnectionCapability.selectable
        #expect(ConnectionsModel.reconnectCapabilities(for: google, offered: all) == [.mailRead, .mailSend, .calendarRead])
        #expect(ConnectionsModel.reconnectCapabilities(for: google, adding: .mailCompose, offered: all)
            == [.mailRead, .mailCompose, .mailSend, .calendarRead])
        #expect(ConnectionsModel.reconnectCapabilities(for: nil, adding: .calendarRead, offered: all) == [.calendarRead])
        #expect(ConnectionsModel.reconnectCapabilities(for: nil, offered: [.mailRead]) == [.mailRead])

        // A server before Phase C sends none of the new fields.
        let older = try Fixtures.decode(ItemList<Connection>.self, "connections")
        #expect(older.items.allSatisfy { $0.capabilities == nil && $0.scopes == nil && $0.statusReason == nil })
        #expect(older.items.allSatisfy { !$0.needsReconnect })
    }

    @Test("OAuth start and callback: the URL to open, the connection and resumable tasks")
    func oauth() throws {
        let start = try Fixtures.decode(OAuthStartResponse.self, "oauth-start")
        let url = try #require(OAuthConnector.authorizationURL(start.authorizationUrl))
        #expect(url.host() == "accounts.google.com")
        #expect(start.expiresAt > Date(timeIntervalSince1970: 1_790_000_000))

        let result = try Fixtures.decode(OAuthCallbackResult.self, "oauth-callback-result")
        #expect(result.connection.id == googleId)
        #expect(result.connection.status == .active)
        #expect(!result.connection.needsReconnect)
        #expect(result.returnTo == nil)
        #expect(result.resumableTaskIds == ["d4f5a6b7-8e9a-4b0c-9d2e-3f4a5b6c7d84"])
        #expect(result.id == googleId)
    }

    // MARK: Calendars

    @Test("Upcoming: events with their own zones, all-day, and a calendar that didn't answer")
    func upcoming() throws {
        let response = try Fixtures.decode(UpcomingEventsResponse.self, "calendar-upcoming")
        let upcoming = try #require(response.upcoming)
        try #require(upcoming.events.count == 2)
        #expect(upcoming.events[0].timeZone == "Europe/Berlin")
        #expect(upcoming.events[0].attendeeCount == 3)
        #expect(upcoming.events[0].listId == "\(googleId)/evt-standup-20261104")
        #expect(upcoming.events[1].allDay)
        #expect(upcoming.events[1].timeZone == nil)
        #expect(upcoming.events[1].status == .tentative)
        #expect(upcoming.events[1].webLink == nil)
        #expect(upcoming.sources.map(\.status) == [.ok, .unavailable])
        #expect(upcoming.sources[0].problem == nil)
        #expect(upcoming.sources[1].problem != nil)
        #expect(!upcoming.sources[1].needsConnectionFix)

        let home = try Fixtures.decode(HomeSnapshot.self, "home-snapshot-upcoming")
        #expect(home.upcoming == upcoming)
        #expect(home.assistant.capabilities.calendar == true)
        #expect(home.assistant.capabilities.purchases == false)
        #expect(home.assistant.capabilities.browser == true)

        // Without a calendar (or from an older server) there is no "Upcoming" at all.
        let older = try Fixtures.decode(HomeSnapshot.self, "home-snapshot")
        #expect(older.upcoming == nil)
        #expect(older.assistant.capabilities.mail == nil)
    }

    @Test("Calendar events: attendees with responses, the account itself, the organizer")
    func calendarEvents() throws {
        let list = try Fixtures.decode(CalendarEventList.self, "calendar-events")
        let event = try #require(list.items.first)
        #expect(!list.truncated)
        #expect(event.provider == .google)
        #expect(event.organizer == "lin@example.org")
        #expect(event.attendees.map(\.isSelf) == [false, true, false])
        #expect(event.attendees.map(\.organizer) == [true, false, false])
        #expect(event.attendees.map(\.response) == [.accepted, .needsAction, nil])
    }

    // MARK: Email watches

    @Test("Email watches: watching and replied")
    func emailWatches() throws {
        let list = try Fixtures.decode(ItemList<EmailWatch>.self, "email-watches")
        #expect(list.items.map(\.status) == [.watching, .replied])
        #expect(list.items[0].nextCheckAt != nil)
        #expect(list.items[1].nextCheckAt == nil)
        #expect(list.items[1].replyFrom?.address == "billing@example.org")
        #expect(list.items[1].replyFrom?.display == "Billing <billing@example.org>")
        #expect(list.items[1].provider == .microsoft)
    }

    // MARK: Orders, bookings, evidence

    @Test("Orders: placed with the merchant's number; unknown outcome is its own status")
    func orders() throws {
        let page = try Fixtures.decode(Page<Order>.self, "orders-page")
        #expect(page.nextCursor != nil)
        let placed = try #require(page.items.first)
        #expect(placed.status == .placed)
        #expect(placed.total == Money(amountMicro: 54_480_000, currency: "USD"))
        #expect(placed.items.first?.quantity == 2)
        #expect(placed.merchantOrderId == "FX-100231")
        #expect(placed.evidence.map(\.kind) == [.screenshot])

        let unknown = try Fixtures.decode(Order.self, "order")
        // The contract's own `unknown` (interrupted after submitting) is not a newer value.
        #expect(unknown.status == .outcomeUnknown)
        #expect(unknown.status != .unrecognized)
        #expect(unknown.failureReason == "ORDER_UNKNOWN")
        #expect(unknown.placedAt == nil)
        #expect(unknown.tax != nil)
        #expect(unknown.status.note != nil)
    }

    @Test("Bookings: confirmed with reference, calendar entry and evidence (screenshot, ICS)")
    func bookings() throws {
        let page = try Fixtures.decode(Page<Booking>.self, "bookings-page")
        #expect(page.nextCursor == nil)
        let booking = try Fixtures.decode(Booking.self, "booking")
        #expect(page.items == [booking])
        #expect(booking.status == .confirmed)
        #expect(booking.reference == "FD-7Q2K")
        #expect(booking.binding)
        #expect(booking.timeZone == "Europe/Berlin")
        #expect(booking.calendarEventId != nil)
        #expect(booking.evidence.map(\.kind) == [.screenshot, .ics])
        #expect(booking.evidence.map(\.mediaType) == [.png, .calendar])
        #expect(booking.evidence.map(\.mediaType.fileExtension) == ["png", "ics"])
    }

    @Test("Evidence artifact metadata")
    func evidence() throws {
        let artifact = try Fixtures.decode(EvidenceArtifact.self, "evidence-artifact")
        #expect(artifact.kind == .extract)
        #expect(artifact.mediaType == .json)
        #expect(artifact.downloadPath == "/v1/evidence/\(artifact.id)/content")
        #expect(artifact.browserSessionId != nil)
    }

    // MARK: Task detail

    @Test("Comparison task: browser sessions with handover, evidence codes, step previews")
    func shoppingTask() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail-shopping")
        #expect(detail.displayTitle.contains("pour-over kettle"))
        let sessions = try #require(detail.browserSessions)
        try #require(sessions.count == 2)
        #expect(sessions[0].status == .succeeded)
        #expect(sessions[0].artifacts.map(\.kind) == [.screenshot, .extract])
        #expect(sessions[0].blockedRequests == 2)
        #expect(sessions[1].status == .handover)
        #expect(sessions[1].stopReason == .captchaDetected)
        #expect(sessions[1].stopReason?.isHandover == true)
        #expect(ExternalLink.url(sessions[1].handoverUrl) != nil)

        let search = detail.steps[0]
        #expect(search.toolId == .shopSearch)
        #expect(search.evidence.map(\.kind) == [.browserCapture, .note])
        #expect(search.evidence.map(\.code) == ["SCREENSHOT", "HANDOVER"])
        #expect(search.evidence[0].artifactId == screenshotId)
        #expect(search.evidence[1].artifactId == nil)
        #expect(EvidenceText.title(search.evidence[0]) == "Screenshot of the page")
        #expect(StepPreview.objects(search.output?["sites"]).count == 2)

        let compare = detail.steps[1]
        #expect(compare.toolId == .shopCompare)
        let ranking = StepPreview.objects(compare.output?["ranking"])
        try #require(ranking.count == 2)
        #expect(StepPreview.money(ranking[0]["total"]) == Money(amountMicro: 29_480_000, currency: "USD"))
        #expect(StepPreview.money(ranking[1]["total"]) == nil)
        #expect(compare.output?["mixedCurrencies"]?.boolValue == false)
        #expect(StepPreview.orderId(compare) == nil)
    }

    @Test("Scenario 9: a step denied because the Google connection expired, with Reconnect")
    func expiredConnectionTask() throws {
        let detail = try Fixtures.decode(TaskDetail.self, "task-detail-connection-expired")
        let error = try #require(detail.error)
        #expect(error.code == .connectionRequired)
        #expect(error.reason == "CONNECTION_EXPIRED")
        #expect(error.retryable)
        #expect(OAuthProvider.named(error.params?["provider"]?.stringValue) == .google)
        #expect(detail.canRetry)
        #expect(!detail.hasUnknownOutcome)
        #expect(TaskErrorText.describe(error) == "Your \("Google".bidiIsolated) connection has expired. Reconnect it, then retry.")
        #expect(detail.steps[0].status == .blocked)
        #expect(detail.steps[0].policy.reasons == ["CONNECTION_EXPIRED"])
        #expect(PolicyReasonText.describe("CONNECTION_EXPIRED") != nil)
        #expect(detail.browserSessions == [])
    }

    // MARK: Approvals

    @Test("Purchase approval: exact items, totals, delivery, payment and the monthly limit")
    func purchaseApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-purchase")
        guard case .purchase(let purchase) = approval.details else {
            Issue.record("Expected a purchase, got \(approval.details)")
            return
        }
        #expect(approval.isReviewable)
        #expect(approval.riskLevel == .high)
        #expect(approval.reasons.contains("PURCHASE"))
        #expect(purchase.merchant.host == "shop.fixture.test")
        #expect(purchase.items.map(\.quantity) == [2])
        #expect(purchase.total.amountMicro == 54_480_000)
        #expect(purchase.tax == nil)
        #expect(purchase.delivery.estimate == "2–4 business days")
        #expect(purchase.paymentMethod == "Visa •••• 4242")
        #expect(purchase.limit.remainingAfter.amountMicro == 25_520_000)
        #expect(approval.details.evidenceArtifactId == screenshotId)
        #expect(approval.displaySummary.contains("Fixture Kitchen Supply"))
        #expect(approval.displaySummary != approval.summary)
    }

    @Test("Calendar approval: title, time in its zone, guests who are emailed")
    func calendarApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-calendar-event")
        guard case .calendarEvent(let event) = approval.details else {
            Issue.record("Expected a calendar event, got \(approval.details)")
            return
        }
        #expect(approval.isReviewable)
        #expect(event.action == .create)
        #expect(event.provider == .google)
        #expect(event.eventId == nil)
        #expect(event.timeZone == "America/New_York")
        #expect(event.attendees == ["lin@example.org"])
        #expect(event.notifyAttendees)
        #expect(event.conflictCheck)
        #expect(event.previous == nil)
        #expect(approval.reasons.contains("RECIPIENT_EXTERNAL"))
        #expect(approval.displaySummary.contains("Project kickoff"))
    }

    @Test("Booking and form approvals: every field, personal ones marked, binding terms")
    func bookingAndFormApprovals() throws {
        let booking = try Fixtures.decode(Approval.self, "approval-booking")
        guard case .booking(let action) = booking.details else {
            Issue.record("Expected a booking, got \(booking.details)")
            return
        }
        #expect(booking.isReviewable)
        #expect(action.fields.filter(\.personal).map(\.label) == ["Name", "Phone"])
        #expect(action.binding)
        #expect(action.price == nil)
        #expect(action.cancellationTerms?.contains("24 hours") == true)
        #expect(booking.details.evidenceArtifactId != nil)

        let form = try Fixtures.decode(Approval.self, "approval-form-submission")
        guard case .formSubmission(let submission) = form.details else {
            Issue.record("Expected a form submission, got \(form.details)")
            return
        }
        #expect(form.isReviewable)
        #expect(submission.form == "contact")
        #expect(!submission.binding)
        #expect(form.details.evidenceArtifactId == nil)
    }

    @Test("Email draft approval: mode, via, reply thread")
    func emailDraftApproval() throws {
        let approval = try Fixtures.decode(Approval.self, "approval-email-draft")
        guard case .email(let email) = approval.details else {
            Issue.record("Expected an email, got \(approval.details)")
            return
        }
        #expect(approval.isReviewable)
        #expect(email.isDraft)
        #expect(email.via == .google)
        #expect(email.cc == [])
        #expect(email.inReplyTo?.subject == "Quote for the kitchen")

        // Older email approvals (no mode / via) are SMTP sends.
        let older = try Fixtures.decode(TaskDetail.self, "task-detail")
        guard case .email(let send) = older.approvals.first?.details else {
            Issue.record("Expected the older email approval")
            return
        }
        #expect(!send.isDraft)
        #expect(send.mode == nil)
        #expect(send.via == nil)
        #expect(older.approvals[0].isReviewable)
    }

    // MARK: Skills, stream events, preferences

    @Test("Skills: connection options and the new unavailable reasons")
    func skills() throws {
        let list = try Fixtures.decode(ItemList<Skill>.self, "skills-phase-c")
        try #require(list.items.count == 2)
        let email = list.items[0]
        #expect(email.status == .needsConnection)
        #expect(email.tools.contains(.emailDraftReply))
        #expect(email.connectionOptions?.map(\.provider) == [.smtp, .google, .microsoft])
        #expect(email.connectionOptions?.map(\.capability) == [nil, .mailRead, .mailRead])
        #expect(email.unavailableText?.contains("Google") == true)
        #expect(list.items[1].unavailableReason == .browserUnavailable)
        #expect(list.items[1].tools == [.shopSearch, .shopCompare, .shopPrepareCart, .shopCheckout])
    }

    @Test("order.changed stream event carries the task in its data")
    func streamEvent() throws {
        let event = try Fixtures.decode(StreamEvent.self, "stream-event-order")
        #expect(event.type == .orderChanged)
        #expect(event.taskId == nil)
        #expect(event.data["taskId"]?.stringValue == "c3e4f5a6-7d8f-4a9b-8c1d-2e3f4a5b6c73")
    }

    @Test("Purchase limit: 0 (off) by default, read when sent")
    func purchaseLimit() throws {
        let me = try Fixtures.decode(Me.self, "me")
        #expect(me.preferences.spending.monthlyPurchaseLimitUsd == 50)
        #expect(me.preferences.spending.purchasesEnabled)
        let older = try Fixtures.decode(Me.self, "me-before-phase-b")
        #expect(older.preferences.spending.monthlyPurchaseLimitUsd == 0)
        #expect(!older.preferences.spending.purchasesEnabled)
        #expect(older.preferences.spending.monthlyAiBudgetUsd == me.preferences.spending.monthlyAiBudgetUsd)
    }

    // MARK: Tool outputs (decoded leniently when a route sends them)

    @Test("Free/busy: an inaccessible calendar is reported, never assumed free")
    func freeBusy() throws {
        let result = try Fixtures.decode(FreeBusyResult.self, "free-busy-result")
        #expect(result.timeZone == "Europe/Berlin")
        #expect(result.durationMinutes == 30)
        #expect(result.calendars.map(\.accessible) == [true, false])
        #expect(result.calendars[0].busy.count == 1)
        #expect(result.slots.count == 2)
    }

    @Test("Email thread and message summaries: metadata only, sender as reported")
    func emailSummaries() throws {
        let thread = try Fixtures.decode(EmailThreadSummary.self, "email-thread-summary")
        #expect(thread.provider == .google)
        #expect(thread.needsReply)
        #expect(thread.lastMessageFrom.display == "Lin <lin@example.org>")
        #expect(thread.participants.map(\.name) == ["Lin", nil])
        let message = try Fixtures.decode(EmailMessageSummary.self, "email-message-summary")
        #expect(message.threadId == thread.id)
        #expect(message.cc.isEmpty)
        #expect(!message.hasAttachments)
    }

    @Test("Comparison: offers with totals, delivery, rating and reliability signals; mixed currencies")
    func comparison() throws {
        let comparison = try Fixtures.decode(ShoppingComparison.self, "shopping-comparison")
        try #require(comparison.offers.count == 2)
        #expect(comparison.mixedCurrencies)
        #expect(comparison.ranking == comparison.offers.map(\.id))
        let best = comparison.offers[0]
        #expect(best.total == Money(amountMicro: 29_480_000, currency: "USD"))
        #expect(best.delivery.minDays == 2)
        #expect(best.rating?.count == 1203)
        #expect(best.signals.map(\.code) == [.https, .returnPolicy, .customerRating, .legalNotice])
        #expect(best.signals.last?.present == false)
        let other = comparison.offers[1]
        #expect(other.price.currency == "EUR")
        #expect(other.shipping == nil)
        #expect(other.total == nil)
        #expect(other.inStock == nil)
        #expect(comparison.sites.map(\.status) == [.ok, .handover])
        #expect(comparison.sites[1].reason == .captchaDetected)
    }

    @Test("Prepared cart on a shop without checkout support hands over the cart link")
    func preparedCart() throws {
        let cart = try Fixtures.decode(PreparedCart.self, "prepared-cart")
        #expect(!cart.checkoutSupported)
        #expect(ExternalLink.url(cart.handoverUrl) != nil)
        #expect(cart.total == nil)
        #expect(cart.lines.map(\.quantity) == [2])
    }

    @Test("Booking slots and confirmation: live slots in the site's zone, the site's reference")
    func bookingResults() throws {
        let slots = try Fixtures.decode(BookingSlots.self, "booking-slots")
        #expect(slots.slots.map(\.timeZone) == ["Europe/Berlin", "Europe/Berlin"])
        #expect(slots.slots[1].end == nil)
        #expect(slots.slots[0].price == nil)
        #expect(slots.requiredFields == ["Name", "Email", "Phone"])
        let confirmation = try Fixtures.decode(BookingConfirmation.self, "booking-confirmation")
        #expect(confirmation.reference == "FD-7Q2K")
        #expect(confirmation.icsArtifactId != nil)
        #expect(confirmation.location == "Example Street 5, Berlin")
    }

    // MARK: Newer server

    @Test("Values from a newer server decode leniently and are never approvable blindly")
    func unknownValues() throws {
        let connections = try Fixtures.decode(ItemList<Connection>.self, "unknown-values-connections")
        let connection = try #require(connections.items.first)
        #expect(connection.provider == .unknown)
        #expect(connection.status == .unknown)
        #expect(connection.capabilities == [.unknown])
        #expect(connection.knownCapabilities.isEmpty)
        #expect(connection.statusReason == .unknown)
        #expect(connection.oauthProvider == nil)

        let order = try Fixtures.decode(Order.self, "unknown-values-commerce")
        #expect(order.status == .unrecognized)
        #expect(order.failureReason == "CARD_DECLINED")
        #expect(order.evidence.map(\.kind) == [.unknown])
        #expect(order.evidence.map(\.mediaType) == [.unknown])

        let detail = try Fixtures.decode(TaskDetail.self, "unknown-values-phase-c")
        #expect(detail.steps[0].evidence[0].code == "VIDEO_RECORDING")
        #expect(EvidenceText.title(detail.steps[0].evidence[0]) == "Recording")
        try #require(detail.approvals.count == 2)
        guard case .email(let email) = detail.approvals[0].details,
              case .calendarEvent(let event) = detail.approvals[1].details
        else {
            Issue.record("Expected an email and a calendar event")
            return
        }
        #expect(email.mode == .unknown)
        #expect(email.via == .unknown)
        #expect(!detail.approvals[0].isReviewable)
        #expect(event.action == .unknown)
        #expect(!detail.approvals[1].isReviewable)
        let session = try #require(detail.browserSessions?.first)
        #expect(session.status == .unknown)
        #expect(session.stopReason == .unknown)
    }
}
