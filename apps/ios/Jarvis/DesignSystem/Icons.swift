/// SF Symbol names from the shared icon map (`icons` in packages/tokens/src/tokens.ts),
/// so the same concept uses the same glyph on every platform.
enum MeridianIcon {
    static let home = "house"
    static let tasks = "checklist"
    static let memory = "brain"
    static let connections = "powerplug"
    static let settings = "gearshape"
    static let voice = "mic"
    static let send = "arrow.up"
    static let approve = "checkmark"
    static let reject = "xmark"
    static let conversations = "bubble.left.and.bubble.right"
    static let schedules = "calendar.badge.clock"
    static let skills = "puzzlepiece.extension"
    static let attachment = "paperclip"
    static let question = "questionmark.bubble"

    static func status(_ status: TaskStatus) -> String {
        switch status {
        case .queued: "clock"
        case .planning: "point.topleft.down.to.point.bottomright.curvepath"
        case .awaitingApproval: "hand.raised"
        case .running: "play"
        case .verifying: "checkmark.shield"
        case .completed: "checkmark.circle"
        case .failed: "exclamationmark.circle"
        case .cancelled: "slash.circle"
        case .expired: "timer"
        case .unknown: "questionmark.circle"
        }
    }
}
