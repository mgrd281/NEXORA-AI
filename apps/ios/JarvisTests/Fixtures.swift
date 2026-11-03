import Foundation
@testable import Jarvis

/// Loads the JSON fixtures in JarvisTests/Fixtures. They are validated against the Zod
/// contracts by apps/ios/scripts/validate-fixtures.ts, so these tests decode exactly
/// what the API sends.
enum Fixtures {
    struct Missing: Error, CustomStringConvertible {
        let name: String
        var description: String { "Fixture \(name).json is not in the test bundle" }
    }

    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            throw Missing(name: name)
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: data(name))
    }
}

private final class BundleToken {}

/// Builds a `TaskSummary` for state-mapping tests.
func makeSummary(
    id: String = UUID().uuidString.lowercased(),
    status: TaskStatus,
    completed: Int = 0,
    total: Int = 0
) -> TaskSummary {
    TaskSummary(
        id: id,
        title: "Test task",
        request: "Test request",
        status: status,
        riskLevel: .low,
        source: .text,
        progress: TaskProgress(completed: completed, total: total),
        pendingApprovalId: nil,
        resultSummary: nil,
        error: nil,
        createdAt: Date(timeIntervalSince1970: 1_793_718_245),
        updatedAt: Date(timeIntervalSince1970: 1_793_718_245),
        completedAt: nil
    )
}
