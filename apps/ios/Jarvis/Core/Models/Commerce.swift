import Foundation

// Mirrors the Phase C money, evidence, browser-session, shopping and booking shapes in
// packages/contracts/src/schemas.ts. Every amount, slot and confirmation comes from a
// supported site's live page (with evidence) — the app only shows what the server read.

/// An amount as integer micro-units of its currency (1 USD = 1,000,000): no float drift.
struct Money: Decodable, Sendable, Equatable, Hashable {
    let amountMicro: Int64
    /// ISO 4217 code, e.g. USD.
    let currency: String

    var decimalAmount: Decimal { Decimal(amountMicro) / Decimal(1_000_000) }

    /// In the app's locale with the currency's usual decimals, never rounding away a
    /// fraction the merchant stated.
    var formatted: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = .current
        formatter.currencyCode = currency
        let usual = formatter.maximumFractionDigits
        formatter.minimumFractionDigits = usual
        formatter.maximumFractionDigits = max(usual, Self.fractionDigits(of: amountMicro))
        return formatter.string(from: decimalAmount as NSDecimalNumber) ?? Self.param(self)
    }

    /// Decimal places the micro-amount actually needs (0...6).
    static func fractionDigits(of micro: Int64) -> Int {
        var fraction = micro.magnitude % 1_000_000
        guard fraction != 0 else { return 0 }
        var digits = 6
        while fraction % 10 == 0 {
            fraction /= 10
            digits -= 1
        }
        return digits
    }

    /// The server's money parameter form, "USD 129.99" (contracts `moneyParam`).
    static func param(_ money: Money) -> String {
        let magnitude = money.amountMicro.magnitude
        let units = magnitude / 1_000_000
        var fraction = String(magnitude % 1_000_000)
        fraction = String(repeating: "0", count: 6 - fraction.count) + fraction
        while fraction.count > 2, fraction.hasSuffix("0") { fraction.removeLast() }
        return "\(money.currency) \(money.amountMicro < 0 ? "-" : "")\(units).\(fraction)"
    }

    /// Parses a money parameter of a server sentence or task error ("USD 129.99").
    init?(param: String) {
        let parts = param.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let code = String(parts[0])
        guard code.count == 3, code.allSatisfy({ $0.isASCII && $0.isUppercase }) else { return nil }
        var amount = Substring(parts[1])
        let negative = amount.hasPrefix("-")
        if negative { amount = amount.dropFirst() }
        let pieces = amount.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(pieces.count),
              let whole = pieces.first, !whole.isEmpty, whole.allSatisfy({ $0.isASCII && $0.isNumber }),
              let units = Int64(whole), units < 9_000_000_000_000
        else { return nil }
        var micro = units * 1_000_000
        if pieces.count == 2 {
            let fraction = pieces[1]
            guard (1...6).contains(fraction.count), fraction.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = Int64(fraction + String(repeating: "0", count: 6 - fraction.count))
            else { return nil }
            micro += value
        }
        self.init(amountMicro: negative ? -micro : micro, currency: code)
    }

    init(amountMicro: Int64, currency: String) {
        self.amountMicro = amountMicro
        self.currency = currency
    }
}

/// A file the browser agent kept as evidence (a screenshot of the live page, the data it
/// extracted, a booking's ICS file). Only its owner can download it.
struct EvidenceArtifact: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let kind: EvidenceArtifactKind
    let mediaType: EvidenceMediaType
    let sizeBytes: Int64
    /// Hex SHA-256 of the stored bytes.
    let sha256: String
    /// The page it was captured on (nil for files the site sent, e.g. an ICS download).
    let pageUrl: String?
    let taskId: String?
    let browserSessionId: String?
    /// API path that streams the file to its owner.
    let downloadPath: String
    let createdAt: Date
}

/// One run of the isolated browser agent on one supported site, for one step.
struct BrowserSession: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let taskId: String
    let stepId: String
    /// The supported site's recipe id, e.g. `fixture-shop`.
    let siteId: String
    /// The recipe operation, e.g. `search`, `slots`, `book`, `checkout`.
    let operation: String
    let status: BrowserSessionStatus
    let stopReason: BrowserStopReason?
    /// Where the user can continue themselves (handover only).
    let handoverUrl: String?
    let navigations: Int
    let requests: Int
    /// Requests the agent refused (outside the site's allow-list, private addresses, downloads).
    let blockedRequests: Int
    let startedAt: Date?
    let endedAt: Date?
    let createdAt: Date
    let artifacts: [EvidenceArtifact]
}

// MARK: - Shopping

/// A fact about a merchant read from its own pages.
struct ReliabilitySignal: Decodable, Sendable, Equatable {
    let code: ReliabilitySignalCode
    let present: Bool
    /// e.g. "4.6 (1,203 ratings)" as the page states it.
    let value: String?
}

/// One product offer as a supported shop showed it live. Nil means the page didn't say —
/// never an estimate.
struct ProductOffer: Decodable, Sendable, Equatable, Identifiable {
    struct Delivery: Decodable, Sendable, Equatable {
        let minDays: Int?
        let maxDays: Int?
        /// As the page states it.
        let text: String?
    }

    struct Rating: Decodable, Sendable, Equatable {
        let value: Double
        let count: Int
    }

    let id: String
    let siteId: String
    let merchantName: String
    let merchantHost: String
    /// As the page states it (untrusted text).
    let title: String
    let productUrl: String
    let price: Money
    let shipping: Money?
    /// price + shipping when both are known and in the same currency.
    let total: Money?
    let delivery: Delivery
    let inStock: Bool?
    let rating: Rating?
    let signals: [ReliabilitySignal]
    let evidenceArtifactId: String?
    let capturedAt: Date
}

/// `shop.compare` output: offers side by side, with where each came from.
struct ShoppingComparison: Decodable, Sendable, Equatable {
    struct Site: Decodable, Sendable, Equatable {
        enum Status: String, Codable, Sendable {
            case ok
            case failed
            case handover
            case unknown

            init(from decoder: any Decoder) throws {
                self = try LenientEnum.decode(decoder, fallback: .unknown)
            }
        }

        let siteId: String
        let status: Status
        let reason: BrowserStopReason?
    }

    let query: String
    let offers: [ProductOffer]
    /// Offer ids, lowest known total first; offers without a known total come last.
    let ranking: [String]
    let sites: [Site]
    /// Offers in different currencies are not converted (no verifiable exchange rate).
    let mixedCurrencies: Bool
    let generatedAt: Date
}

struct CartLine: Decodable, Sendable, Equatable {
    let title: String
    let quantity: Int
    let unitPrice: Money
    let lineTotal: Money
    let productUrl: String
}

/// `shop.prepare_cart` output: a cart on the merchant's site, nothing bought.
struct PreparedCart: Decodable, Sendable, Equatable {
    let siteId: String
    let merchantName: String
    let merchantHost: String
    let lines: [CartLine]
    let subtotal: Money
    let shipping: Money?
    let total: Money?
    /// The site's recipe can place the order; otherwise the user finishes at `handoverUrl`.
    let checkoutSupported: Bool
    let handoverUrl: String?
    let evidenceArtifactId: String?
    let preparedAt: Date
}

/// An order `shop.checkout` placed or tried to place (`GET /v1/orders`).
struct Order: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let taskId: String?
    let siteId: String
    let merchantName: String
    let merchantHost: String
    let status: OrderStatus
    let items: [CartLine]
    let subtotal: Money
    let shipping: Money
    let tax: Money?
    let total: Money
    /// The merchant's order number (placed only).
    let merchantOrderId: String?
    let placedAt: Date?
    /// failed / unknown: why (a `TaskErrorReason`, kept as a string so newer reasons decode).
    let failureReason: String?
    let evidence: [EvidenceArtifact]
    let createdAt: Date
    let updatedAt: Date
}

// MARK: - Booking

/// A free slot exactly as the site offered it live.
struct BookingSlot: Decodable, Sendable, Equatable {
    let id: String
    let start: Date
    let end: Date?
    let timeZone: String
    let service: String
    let price: Money?
}

/// `booking.find_slots` output.
struct BookingSlots: Decodable, Sendable, Equatable {
    let siteId: String
    let siteName: String
    let service: String
    let slots: [BookingSlot]
    /// Labels of the details the site's form requires.
    let requiredFields: [String]
    let evidenceArtifactId: String?
    let capturedAt: Date
}

/// `booking.book` output: what the site confirmed, read from its confirmation page.
struct BookingConfirmation: Decodable, Sendable, Equatable {
    let bookingId: String
    let reference: String
    let service: String
    let start: Date
    let end: Date?
    let timeZone: String
    let location: String?
    let siteId: String
    let siteHost: String
    let icsArtifactId: String?
    let screenshotArtifactId: String?
    let confirmedAt: Date
}

/// An appointment `booking.book` made or tried to make (`GET /v1/bookings`).
struct Booking: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let taskId: String?
    let siteId: String
    let siteName: String
    let siteHost: String
    let service: String
    let status: BookingStatus
    let start: Date
    let end: Date?
    let timeZone: String
    let reference: String?
    let price: Money?
    let binding: Bool
    /// The calendar entry JARVIS created for it, if any.
    let calendarEventId: String?
    let failureReason: String?
    let evidence: [EvidenceArtifact]
    let createdAt: Date
    let updatedAt: Date
}
