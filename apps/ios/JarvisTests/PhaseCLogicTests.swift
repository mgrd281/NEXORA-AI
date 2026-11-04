import Foundation
import Testing
@testable import Jarvis

/// Phase C client logic: the OAuth redirect and callback forwarding (security-relevant
/// parsing), request bodies, money parameters, error and sentence rendering, links the app
/// opens, and times shown in an event's own zone.
@Suite("Phase C requests and client logic")
struct PhaseCLogicTests {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private let redirect = OAuthRedirect(
        uri: "https://jarvis.example.net/connections/callback",
        host: "jarvis.example.net",
        path: "/connections/callback"
    )
    private let state = "Qm9uZCB0byB0aGlzIHNlc3Npb24gb25seQ"

    // MARK: OAuth redirect URI

    @Test("Redirect URI: https with host and path only")
    func redirectValidation() {
        let valid = OAuthRedirect.validate("https://Jarvis.Example.net/connections/callback")
        #expect(valid?.host == "jarvis.example.net")
        #expect(valid?.path == "/connections/callback")
        #expect(valid?.uri == "https://Jarvis.Example.net/connections/callback")

        for raw in [
            "",
            "$(JARVIS_OAUTH_REDIRECT_URI)",
            "http://jarvis.example.net/connections/callback",
            "jarvis://connections/callback",
            "https://jarvis.example.net",
            "https://jarvis.example.net/",
            "https://jarvis.example.net/connections/callback?x=1",
            "https://jarvis.example.net/connections/callback#frag",
            "https://jarvis.example.net:8443/connections/callback",
            "https://user:pass@jarvis.example.net/connections/callback",
        ] {
            #expect(OAuthRedirect.validate(raw) == nil, "\(raw) must be refused")
        }
    }

    // MARK: Callback forwarding

    @Test("Callback: the code, state and issuer are forwarded verbatim (percent-decoded once)")
    func callbackWithCode() throws {
        let url = try #require(URL(string: "https://jarvis.example.net/connections/callback?state=\(state)&code=4%2F0AdeuXyz&scope=email&iss=https%3A%2F%2Faccounts.google.com"))
        let request = try #require(redirect.callbackRequest(from: url))
        #expect(request.state == state)
        #expect(request.code == "4/0AdeuXyz")
        #expect(request.error == nil)
        #expect(request.iss == "https://accounts.google.com")

        let body = try json(request)
        #expect(Set(body.keys) == ["state", "code", "iss"])
    }

    @Test("Callback: a denial is forwarded as an error (the server consumes the state)")
    func callbackWithError() throws {
        let url = try #require(URL(string: "https://jarvis.example.net/connections/callback?error=access_denied&error_description=The%20user%20declined&state=\(state)"))
        let request = try #require(redirect.callbackRequest(from: url))
        #expect(request.code == nil)
        #expect(request.error == "access_denied")
        #expect(request.errorDescription == "The user declined")
        let body = try json(request)
        #expect(Set(body.keys) == ["state", "error", "errorDescription"])
    }

    @Test("Callback: anything that isn't exactly this redirect is refused, nothing is sent")
    func callbackRefusals() throws {
        let cases = [
            // another host or path
            "https://evil.example/connections/callback?state=\(state)&code=abc",
            "https://jarvis.example.net/other?state=\(state)&code=abc",
            // not https
            "http://jarvis.example.net/connections/callback?state=\(state)&code=abc",
            // state too short, missing
            "https://jarvis.example.net/connections/callback?state=short&code=abc",
            "https://jarvis.example.net/connections/callback?code=abc",
            // neither code nor error, or an empty code
            "https://jarvis.example.net/connections/callback?state=\(state)",
            "https://jarvis.example.net/connections/callback?state=\(state)&code=",
            // a repeated parameter is never guessed between
            "https://jarvis.example.net/connections/callback?state=\(state)&code=abc&code=def",
            "https://jarvis.example.net/connections/callback?state=\(state)&state=\(state)&code=abc",
        ]
        for raw in cases {
            let url = try #require(URL(string: raw))
            #expect(redirect.callbackRequest(from: url) == nil, "\(raw) must be refused")
        }
    }

    @Test("The provider page is opened only over https (http only on this device's loopback)")
    func authorizationURL() {
        #expect(OAuthConnector.authorizationURL("https://accounts.google.com/o/oauth2/v2/auth?x=1") != nil)
        #expect(OAuthConnector.authorizationURL("http://localhost:4100/o/oauth2/v2/auth") != nil)
        #expect(OAuthConnector.authorizationURL("http://127.0.0.1:4100/authorize") != nil)
        #expect(OAuthConnector.authorizationURL("http://accounts.google.com/o/oauth2/v2/auth") == nil)
        #expect(OAuthConnector.authorizationURL("javascript:alert(1)") == nil)
        #expect(OAuthConnector.authorizationURL("https://user:pw@accounts.google.com/") == nil)
        #expect(OAuthConnector.authorizationURL("not a url") == nil)
    }

    // MARK: Request bodies

    @Test("OAuth start: exactly the contract's fields; nil fields omitted")
    func startBody() throws {
        let connect = try json(OAuthStartRequest(
            provider: .google,
            capabilities: [.mailRead, .calendarRead],
            redirectUri: redirect.uri
        ))
        #expect(Set(connect.keys) == ["provider", "capabilities", "redirectUri"])
        #expect(connect["provider"] as? String == "google")
        #expect(connect["capabilities"] as? [String] == ["mail.read", "calendar.read"])
        #expect(connect["redirectUri"] as? String == "https://jarvis.example.net/connections/callback")

        let reconnect = try json(OAuthStartRequest(
            provider: .microsoft,
            capabilities: [.calendarWrite],
            redirectUri: redirect.uri,
            connectionId: "b2d3f4a5-6c7e-4f8a-9b0c-1d2e3f4a5b62"
        ))
        #expect(Set(reconnect.keys) == ["provider", "capabilities", "redirectUri", "connectionId"])
    }

    @Test("Purchase limit: only that field is sent, so the AI budget keeps its value")
    func purchaseLimitPatch() throws {
        let body = try json(SpendingModel.patch(limitUsd: 250))
        #expect(Set(body.keys) == ["preferences"])
        let preferences = try #require(body["preferences"] as? [String: Any])
        #expect(Set(preferences.keys) == ["spending"])
        let spending = try #require(preferences["spending"] as? [String: Any])
        #expect(Set(spending.keys) == ["monthlyPurchaseLimitUsd"])
        #expect(spending["monthlyPurchaseLimitUsd"] as? Double == 250)

        let off = try json(SpendingModel.patch(limitUsd: 0))
        let offSpending = try #require((off["preferences"] as? [String: Any])?["spending"] as? [String: Any])
        #expect(offSpending["monthlyPurchaseLimitUsd"] as? Double == 0)
    }

    @Test("Purchase limit: whole dollars within 0…10,000")
    func purchaseLimitBounds() {
        #expect(SpendingModel.maxLimitUsd == 10_000)
        #expect(SpendingModel.wholeDollars(49.99) == 49)
        #expect(SpendingModel.wholeDollars(0) == 0)
        #expect(SpendingModel.wholeDollars(-5) == 0)
        #expect(SpendingModel.wholeDollars(.nan) == 0)
        #expect(SpendingModel.wholeDollars(.infinity) == 0)
        #expect(SpendingModel.wholeDollars(25_000) == 10_000)
    }

    // MARK: Money

    @Test("Money parameters (\"USD 129.99\") parse exactly, in micro-units")
    func moneyParameters() {
        #expect(Money(param: "USD 129.99") == Money(amountMicro: 129_990_000, currency: "USD"))
        #expect(Money(param: "EUR 5") == Money(amountMicro: 5_000_000, currency: "EUR"))
        #expect(Money(param: "USD 0.000001") == Money(amountMicro: 1, currency: "USD"))
        #expect(Money(param: "USD -2.50") == Money(amountMicro: -2_500_000, currency: "USD"))
        for raw in ["usd 1.00", "USD1.00", "USD 1.0000001", "USD -", "USD 1.a", "US 1", "USD 1,00", "USD  1", ""] {
            #expect(Money(param: raw) == nil, "\(raw) must not parse")
        }
        #expect(Money.param(Money(amountMicro: 129_990_000, currency: "USD")) == "USD 129.99")
        #expect(Money.param(Money(amountMicro: 5_000_000, currency: "EUR")) == "EUR 5.00")
        #expect(Money.param(Money(amountMicro: 1_500_001, currency: "USD")) == "USD 1.500001")
        #expect(Money.fractionDigits(of: 129_990_000) == 2)
        #expect(Money.fractionDigits(of: 5_000_000) == 0)
        #expect(Money.fractionDigits(of: 1_000_001) == 6)
        // Formatting never drops a stated fraction.
        #expect(Money(amountMicro: 1_234_500, currency: "USD").formatted.contains("2345"))
    }

    // MARK: Copy

    @Test("Task errors: provider, capability and money parameters are shown as words and amounts")
    func errorParameters() throws {
        let scope = TaskErrorText.reasonText(
            "CONNECTION_SCOPE_MISSING",
            params: ["provider": .string("microsoft"), "capability": .string("mail.send")]
        )
        let scopeText = try #require(scope)
        #expect(scopeText.contains("Microsoft"))
        #expect(scopeText.contains("Send email"))
        #expect(!scopeText.contains("mail.send"))

        let price = try #require(TaskErrorText.reasonText(
            "PRICE_CHANGED",
            params: ["expected": .string("USD 10.00"), "actual": .string("USD 12.50")]
        ))
        #expect(!price.contains("USD 10.00"))
        #expect(!price.contains("USD 12.50"))

        #expect(TaskErrorText.reasonText(
            "PURCHASE_LIMIT",
            params: ["limit": .string("USD 100.00"), "spent": .string("USD 80.00"), "amount": .string("USD 54.48")]
        ) != nil)
        // A missing parameter falls back to the code's general sentence.
        #expect(TaskErrorText.reasonText("PURCHASE_LIMIT", params: [:]) == nil)
        let fallback = TaskError(code: .policyDenied, message: "x", retryable: false, reason: "PURCHASE_LIMIT", params: [:])
        #expect(TaskErrorText.describe(fallback) == ErrorText.codeMessage(.policyDenied))

        #expect(TaskErrorText.reasonText("PURCHASES_DISABLED", params: [:]) != nil)
        #expect(TaskErrorText.reasonText("CAPTCHA_DETECTED", params: ["host": .string("shop.example")])?.contains("shop.example") == true)
    }

    @Test("API errors of the OAuth flow are explained")
    func apiErrorReasons() {
        for reason in ["REDIRECT_URI_NOT_ALLOWED", "OAUTH_STATE_INVALID", "OAUTH_STATE_EXPIRED", "CONNECTION_NOT_OAUTH", "EVIDENCE_NOT_AVAILABLE"] {
            #expect(ApiErrorReasonText.describe(reason, details: [:]) != nil, "\(reason)")
        }
        let denied = ApiErrorReasonText.describe("OAUTH_DENIED", details: ["provider": .string("google")])
        #expect(denied?.contains("Google") == true)
        let scopes = ApiErrorReasonText.describe("OAUTH_SCOPE_NOT_GRANTED", details: ["capabilities": .string("mail.read,calendar.read")])
        #expect(scopes != nil)
    }

    @Test("Server sentences: money in the app's locale, names as written")
    func serverSentences() throws {
        let purchase = ServerMessage(key: "approval.purchase", params: [
            "total": .text("USD 54.48"),
            "merchant": .text("Fixture Kitchen Supply"),
        ])
        let text = try #require(purchase.rendered)
        #expect(text.contains("Fixture Kitchen Supply"))
        #expect(!text.contains("USD 54.48"))

        let booked = ServerMessage(key: "result.booked", params: [
            "service": .text("Check-up"), "site": .text("Fixture Dental"), "reference": .text("FD-7Q2K"),
        ])
        #expect(booked.rendered?.contains("FD-7Q2K") == true)
        // A missing parameter means the server's own text is shown instead.
        #expect(ServerMessage(key: "result.booked", params: ["service": .text("Check-up")]).rendered == nil)
        #expect(ServerMessage(key: "question.dateTime").rendered != nil)
    }

    @Test("Every Phase C policy reason and evidence code has copy")
    func phaseCCopy() {
        for code in ["CONNECTION_EXPIRED", "CONNECTION_SCOPE_MISSING", "PURCHASES_DISABLED", "PURCHASE_LIMIT", "PURCHASE_CURRENCY", "PURCHASE", "BINDING_COMMITMENT"] {
            #expect(PolicyReasonText.describe(code) != nil, "\(code)")
        }
        for code in ["SCREENSHOT", "PAGE_EXTRACT", "ICS_FILE", "ORDER_CONFIRMATION", "BOOKING_CONFIRMATION", "HANDOVER", "MAIL_SENT", "FREE_BUSY"] {
            #expect(EvidenceText.title(code: code) != nil, "\(code)")
        }
        #expect(EvidenceText.title(code: "SOMETHING_NEW") == nil)
        #expect(BrowserStopReason.captchaDetected.isHandover)
        #expect(BrowserStopReason.loginRequired.isHandover)
        #expect(!BrowserStopReason.pageChanged.isHandover)
    }

    // MARK: Links and previews

    @Test("Links from the server open only over https (http only on loopback)")
    func externalLinks() {
        #expect(ExternalLink.url("https://calendar.google.com/calendar/event?eid=1") != nil)
        #expect(ExternalLink.url("http://localhost:4300/booking") != nil)
        #expect(ExternalLink.url("http://shop.example/cart") == nil)
        #expect(ExternalLink.url("javascript:alert(1)") == nil)
        #expect(ExternalLink.url("https://user:pw@shop.example/") == nil)
        #expect(ExternalLink.url(nil) == nil)
        #expect(ExternalLink.host("https://shop.fixture.test/shop/products/KET-12") == "shop.fixture.test")
    }

    @Test("Step previews are read defensively")
    func stepPreviews() {
        #expect(StepPreview.money(.object(["amountMicro": .number(1_500_000), "currency": .string("USD")]))
            == Money(amountMicro: 1_500_000, currency: "USD"))
        #expect(StepPreview.money(.object(["amountMicro": .number(1.5), "currency": .string("USD")])) == nil)
        #expect(StepPreview.money(.object(["amountMicro": .number(100), "currency": .string("DOLLAR")])) == nil)
        #expect(StepPreview.money(.string("USD 1.00")) == nil)
        #expect(StepPreview.money(nil) == nil)
        #expect(StepPreview.int(.number(3)) == 3)
        #expect(StepPreview.int(.number(1e30)) == nil)
        #expect(StepPreview.int(.number(2.5)) == nil)
        #expect(StepPreview.objects(.array([.object([:]), .string("x")])).count == 1)
        #expect(StepPreview.strings(.array([.string("Phone"), .number(1)])) == ["Phone"])
    }

    @Test("Evidence downloads: media type → file extension")
    func evidenceMediaTypes() {
        #expect(EvidenceMediaType(rawValue: "image/png") == .png)
        #expect(EvidenceMediaType(rawValue: "text/calendar")?.fileExtension == "ics")
        #expect(EvidenceMediaType(rawValue: "text/html") == nil)
        #expect(EvidenceMediaType.unknown.fileExtension == "bin")
    }

    // MARK: Time zones

    @Test("Times are shown in the event's zone, naming it when it isn't the viewer's")
    func eventTimes() throws {
        let start = try #require(JSONCoding.parseDate("2026-11-10T14:00:00.000Z"))
        let end = start.addingTimeInterval(30 * 60)
        let foreign = CalendarText.when(start: start, end: end, timeZone: "America/New_York", allDay: false, viewerZone: "Europe/Berlin")
        let own = CalendarText.when(start: start, end: end, timeZone: "Europe/Berlin", allDay: false, viewerZone: "Europe/Berlin")
        #expect(foreign.hasSuffix(")"))
        #expect(!own.hasSuffix(")"))
        // Same offset at that instant: no zone name needed.
        let sameOffset = CalendarText.when(start: start, end: end, timeZone: "Europe/Paris", allDay: false, viewerZone: "Europe/Berlin")
        #expect(!sameOffset.hasSuffix(")"))
        // An end before the start never crashes the range formatter.
        #expect(!CalendarText.when(start: start, end: start.addingTimeInterval(-60), timeZone: nil, allDay: false).isEmpty)

        let allDayStart = try #require(JSONCoding.parseDate("2026-11-04T23:00:00.000Z"))
        let oneDay = CalendarText.when(start: allDayStart, end: allDayStart.addingTimeInterval(86_400), timeZone: "Europe/Berlin", allDay: true)
        let twoDays = CalendarText.when(start: allDayStart, end: allDayStart.addingTimeInterval(2 * 86_400), timeZone: "Europe/Berlin", allDay: true)
        #expect(oneDay != twoDays)
    }

    @Test("Day headings for Upcoming are computed in the viewer's zone")
    func dayTitles() throws {
        let zone = try #require(TimeZone(identifier: "Europe/Berlin"))
        let now = try #require(JSONCoding.parseDate("2026-11-04T10:00:00.000Z"))
        #expect(CalendarText.dayTitle(now, zone: zone, now: now) == String(localized: "Today"))
        #expect(CalendarText.dayTitle(now.addingTimeInterval(86_400), zone: zone, now: now) == String(localized: "Tomorrow"))
        // 23:30 UTC on the 4th is already the 5th in Berlin.
        let lateUTC = try #require(JSONCoding.parseDate("2026-11-04T23:30:00.000Z"))
        #expect(CalendarText.dayTitle(lateUTC, zone: zone, now: now) == String(localized: "Tomorrow"))
        #expect(CalendarText.dayStart(lateUTC, zone: zone) == JSONCoding.parseDate("2026-11-04T23:00:00.000Z"))
    }

    // MARK: Connections screen

    @Test("Provider cards: what's offered, and what a connection doesn't grant yet")
    func providerCards() throws {
        let providers = try Fixtures.decode(ItemList<ConnectionProviderInfo>.self, "connection-providers").items
        let connections = try Fixtures.decode(ItemList<Connection>.self, "connections-phase-c").items
        let card = ConnectionsModel.ProviderCard(
            provider: .microsoft,
            info: providers.first { $0.oauthProvider == .microsoft },
            connection: connections.first { $0.oauthProvider == .microsoft }
        )
        #expect(!card.configured)
        #expect(card.offered == ConnectionCapability.selectable)
        #expect(card.notYetGranted == [.mailRead, .mailCompose, .mailSend, .calendarWrite])

        let missing = ConnectionsModel.ProviderCard(provider: .google, info: nil, connection: nil)
        #expect(!missing.configured)
        #expect(missing.offered.isEmpty)
    }
}
