import Foundation

// Mirrors `Skill` / `UpdateSkillRequest` in packages/contracts/src/schemas.ts.

/// A skill of the server's registry with its real availability for the signed-in user.
/// Skills never grant permissions: the server's policy engine decides every step.
struct Skill: Decodable, Sendable, Equatable, Identifiable {
    /// The `SkillId` as sent (kept as a string so two unknown ids stay distinct in lists).
    let id: String
    /// Semver of the skill definition.
    let version: String
    let status: SkillStatus
    /// The user's switch (personal-memory mirrors the memory setting).
    let enabled: Bool
    /// Whether the user may switch it (false for planned and core skills).
    let canToggle: Bool
    /// It can run for this user now.
    let available: Bool
    let unavailableReason: SkillUnavailableReason?
    /// Implemented tools the skill owns.
    let tools: [ToolId]
    let plannedTools: [String]
    /// Declarative scopes; informational, never grants anything.
    let permissions: [String]
    /// Highest risk any of its tools can have.
    let maxRisk: RiskLevel
    let requiredConnections: [ConnectionProvider]
    /// Phase C: the skill also works with any ONE of these (a provider, optionally with a
    /// capability it must grant). Nil from older servers; empty = only `requiredConnections`.
    var connectionOptions: [ConnectionOption]? = nil
    let modelUse: SkillModelUse
    /// Projected model cost per run above which the policy asks first; nil = budget rules only.
    let maxCostPerRunMicroUsd: Int64?
    let docsPath: String

    var skillId: SkillId { SkillId(rawValue: id) ?? .unknown }
}

/// `Skill.connectionOptions` entry: e.g. Google with `mail.read`.
struct ConnectionOption: Decodable, Sendable, Equatable {
    let provider: ConnectionProvider
    var capability: ConnectionCapability? = nil
}

/// `PATCH /v1/skills/:id`.
struct UpdateSkillRequest: Encodable, Sendable, Equatable {
    let enabled: Bool
}
