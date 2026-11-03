import Foundation

/// JSON configuration shared by the API client, the event stream and tests.
///
/// Contract timestamps are ISO 8601 with an offset (`z.iso.datetime({ offset: true })`).
/// The server emits `Date.toISOString()` (UTC, millisecond fractions); other
/// valid forms (no fraction, numeric offsets) are accepted too.
enum JSONCoding {
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { dateDecoder in
            let container = try dateDecoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = JSONCoding.parseDate(text) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO 8601 timestamp, got \(text)"
                )
            }
            return date
        }
        return decoder
    }

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()

    static func parseDate(_ text: String) -> Date? {
        if let date = try? fractional.parse(text) { return date }
        if let date = try? whole.parse(text) { return date }
        // Numeric offsets such as +02:00 (valid per the contract, not emitted today).
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}
