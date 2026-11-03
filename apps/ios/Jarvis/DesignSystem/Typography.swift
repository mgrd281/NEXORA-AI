import SwiftUI

/// The Meridian type scale, scaled with Dynamic Type relative to the closest system text style.
enum MeridianTextStyle: Sendable {
    case display
    case title1
    case title2
    case title3
    case body
    case bodyStrong
    case callout
    case label
    case caption
    case mono

    var token: TypeStyle {
        switch self {
        case .display: MeridianType.display
        case .title1: MeridianType.title1
        case .title2: MeridianType.title2
        case .title3: MeridianType.title3
        case .body: MeridianType.body
        case .bodyStrong: MeridianType.bodyStrong
        case .callout: MeridianType.callout
        case .label: MeridianType.label
        case .caption: MeridianType.caption
        case .mono: MeridianType.mono
        }
    }

    /// The system text style whose Dynamic Type curve this style follows.
    var relativeTo: Font.TextStyle {
        switch self {
        case .display: .largeTitle
        case .title1: .title
        case .title2: .title2
        case .title3: .title3
        case .body, .bodyStrong: .body
        case .callout: .callout
        case .label: .subheadline
        case .caption: .caption
        case .mono: .footnote
        }
    }

    var design: Font.Design {
        self == .mono ? .monospaced : .default
    }
}

private struct MeridianFontModifier: ViewModifier {
    let style: MeridianTextStyle
    @ScaledMetric private var size: CGFloat

    init(style: MeridianTextStyle) {
        self.style = style
        _size = ScaledMetric(wrappedValue: style.token.size, relativeTo: style.relativeTo)
    }

    func body(content: Content) -> some View {
        let token = style.token
        let scale = token.size > 0 ? size / token.size : 1
        // SF's natural line height is ~1.2em; add the remainder of the token's line height.
        let extraLeading = max(0, (token.lineHeight - token.size * 1.2) * scale)
        return content
            .font(.system(size: size, weight: token.weight, design: style.design))
            .tracking(token.tracking * size)
            .lineSpacing(extraLeading)
    }
}

extension View {
    /// Applies a Meridian text style that grows and shrinks with Dynamic Type.
    func meridianFont(_ style: MeridianTextStyle) -> some View {
        modifier(MeridianFontModifier(style: style))
    }
}
