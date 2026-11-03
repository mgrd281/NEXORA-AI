import Foundation

/// An arbitrary JSON value, for contract fields typed `record(string, unknown)`
/// (event data, redacted step input/output, error details).
enum JSONValue: Sendable, Equatable, Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// A compact, human-readable rendering for display (not for round-tripping).
    var displayText: String {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            if value.rounded() == value, abs(value) < 1e15 {
                return String(Int64(value))
            }
            return String(value)
        case .bool(let value):
            return value ? "true" : "false"
        case .null:
            return "—"
        case .array(let values):
            return values.map(\.displayText).joined(separator: ", ")
        case .object(let fields):
            return fields.keys.sorted()
                .map { key in "\(key): \(fields[key]?.displayText ?? "")" }
                .joined(separator: ", ")
        }
    }
}
