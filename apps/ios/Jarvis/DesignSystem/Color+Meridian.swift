import SwiftUI
import UIKit

// Helpers referenced by the generated `Tokens.swift`.
extension Color {
    /// An opaque sRGB colour from a 24-bit `0xRRGGBB` value, as emitted by the token build.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1
        )
    }

    /// A colour that follows the effective appearance (light or dark) of the view that renders it.
    ///
    /// Backed by a dynamic `UIColor`, so it also honours `.preferredColorScheme(_:)`
    /// overrides and changes live when the system appearance changes.
    static func adaptive(light: Color, dark: Color) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
    }
}

/// Semantic tone shared by every client (see `taskStateTone` in packages/tokens).
/// Colour is never the only signal: badges always pair it with an icon and a label.
enum MeridianTone: Sendable, Equatable {
    case neutral
    case accent
    case warning
    case success
    case danger

    var foreground: Color {
        switch self {
        case .neutral: MeridianColor.textSecondary
        case .accent: MeridianColor.accentOnSoft
        case .warning: MeridianColor.warning
        case .success: MeridianColor.success
        case .danger: MeridianColor.danger
        }
    }

    var background: Color {
        switch self {
        case .neutral: MeridianColor.surfaceSunken
        case .accent: MeridianColor.accentSoft
        case .warning: MeridianColor.warningSoft
        case .success: MeridianColor.successSoft
        case .danger: MeridianColor.dangerSoft
        }
    }
}
