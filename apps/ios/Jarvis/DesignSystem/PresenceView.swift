import SwiftUI

/// The JARVIS Presence ring. Mirrors the web indicator's states; with Reduce Motion
/// enabled nothing rotates or pulses — each state is drawn as a static ring instead.
struct PresenceView: View {
    let state: PresenceState
    var diameter: CGFloat = 72

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || !state.isContinuouslyAnimated)) { timeline in
            Canvas { context, size in
                PresenceRenderer(
                    state: state,
                    time: timeline.date.timeIntervalSinceReferenceDate,
                    reduceMotion: reduceMotion
                )
                .draw(in: &context, size: size)
            }
        }
        .frame(width: diameter, height: diameter)
        .overlay {
            if let symbol = centerSymbol {
                Image(systemName: symbol)
                    .font(.system(size: diameter * 0.28, weight: .semibold))
                    .foregroundStyle(symbolColor)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(state.accessibilityLabel))
        .accessibilityAddTraits(state.isContinuouslyAnimated ? [.updatesFrequently] : [])
    }

    private var centerSymbol: String? {
        switch state {
        case .listening: MeridianIcon.voice
        case .awaiting: "hand.raised"
        case .completed: MeridianIcon.approve
        case .failed: "exclamationmark"
        case .reconnecting: "arrow.triangle.2.circlepath"
        case .idle, .planning, .running: nil
        }
    }

    private var symbolColor: Color {
        switch state {
        case .awaiting: MeridianColor.warning
        case .completed: MeridianColor.success
        case .failed: MeridianColor.danger
        case .reconnecting: MeridianColor.textTertiary
        default: MeridianColor.accent
        }
    }
}

/// Pure drawing for `PresenceView`; `time` drives rotation and breathing.
private struct PresenceRenderer {
    let state: PresenceState
    let time: TimeInterval
    let reduceMotion: Bool

    func draw(in context: inout GraphicsContext, size: CGSize) {
        let side = min(size.width, size.height)
        let lineWidth = max(2, side * 0.07)
        let radius = (side - lineWidth) / 2 - side * 0.04
        let center = CGPoint(x: size.width / 2, y: size.height / 2)

        // Track
        context.stroke(
            circle(center: center, radius: radius),
            with: .color(MeridianColor.border),
            lineWidth: lineWidth
        )

        switch state {
        case .idle:
            context.stroke(
                circle(center: center, radius: radius),
                with: .color(MeridianColor.borderStrong),
                lineWidth: lineWidth
            )
            context.fill(
                circle(center: center, radius: side * 0.06),
                with: .color(MeridianColor.accent)
            )

        case .listening(let level):
            if reduceMotion {
                // Level shown as intensity rather than movement.
                context.stroke(
                    circle(center: center, radius: radius),
                    with: .color(MeridianColor.accent.opacity(0.35 + 0.65 * level)),
                    lineWidth: lineWidth
                )
            } else {
                let outer = radius * (0.82 + 0.18 * level)
                context.stroke(
                    circle(center: center, radius: radius),
                    with: .color(MeridianColor.accent.opacity(0.25)),
                    lineWidth: lineWidth
                )
                context.stroke(
                    circle(center: center, radius: outer),
                    with: .color(MeridianColor.accent),
                    lineWidth: lineWidth
                )
            }

        case .planning:
            let start = reduceMotion ? -90.0 : rotationDegrees(period: MeridianMotion.presenceRotation)
            context.stroke(
                arc(center: center, radius: radius, startDegrees: start, sweepDegrees: 90),
                with: .color(MeridianColor.accent),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )

        case .running(let progress):
            if let progress {
                context.stroke(
                    arc(center: center, radius: radius, startDegrees: -90, sweepDegrees: max(6, 360 * progress)),
                    with: .color(MeridianColor.accent),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
            } else {
                let start = reduceMotion ? -90.0 : rotationDegrees(period: MeridianMotion.presenceRotation * 1.5)
                context.stroke(
                    arc(center: center, radius: radius, startDegrees: start, sweepDegrees: 140),
                    with: .color(MeridianColor.accent),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
            }
            context.fill(
                circle(center: center, radius: side * 0.06),
                with: .color(MeridianColor.accent)
            )

        case .awaiting:
            let opacity = reduceMotion ? 1.0 : 0.6 + 0.4 * breathing(period: 2.4)
            context.stroke(
                circle(center: center, radius: radius),
                with: .color(MeridianColor.warning.opacity(opacity)),
                lineWidth: lineWidth
            )

        case .completed:
            context.stroke(
                circle(center: center, radius: radius),
                with: .color(MeridianColor.success),
                lineWidth: lineWidth
            )

        case .failed:
            context.stroke(
                circle(center: center, radius: radius),
                with: .color(MeridianColor.danger),
                lineWidth: lineWidth
            )

        case .reconnecting:
            let dash = max(2, radius * 0.25)
            let phase = reduceMotion ? 0 : CGFloat(rotationDegrees(period: 4) / 360) * dash * 4
            context.stroke(
                circle(center: center, radius: radius),
                with: .color(MeridianColor.textTertiary),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, dash: [dash, dash], dashPhase: phase)
            )
        }
    }

    private func circle(center: CGPoint, radius: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
    }

    /// An arc starting at `startDegrees` (0° = trailing edge, -90° = top) sweeping
    /// clockwise on screen.
    private func arc(center: CGPoint, radius: CGFloat, startDegrees: Double, sweepDegrees: Double) -> Path {
        var path = Path()
        path.addArc(
            center: center,
            radius: radius,
            startAngle: .degrees(startDegrees),
            endAngle: .degrees(startDegrees + sweepDegrees),
            clockwise: false
        )
        return path
    }

    private func rotationDegrees(period: Double) -> Double {
        guard period > 0 else { return 0 }
        return (time.truncatingRemainder(dividingBy: period) / period) * 360 - 90
    }

    /// 0...1 sine wave.
    private func breathing(period: Double) -> Double {
        guard period > 0 else { return 1 }
        return (sin(time / period * 2 * .pi) + 1) / 2
    }
}
