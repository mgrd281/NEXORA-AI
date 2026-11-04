import SwiftUI

/// Home "Upcoming": the next events of the connected calendars, read live by the server.
/// Shown only when a connection grants calendar.read (`HomeSnapshot.upcoming` not nil).
/// Calendars that didn't answer are named with their fix; Home never claims "nothing
/// planned" for a calendar it couldn't read.
struct UpcomingSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let upcoming: UpcomingEvents

    private struct Day: Identifiable {
        let id: Date
        let title: String
        let events: [CalendarEventSummary]
    }

    private var viewerZone: TimeZone { CalendarText.zone(app.me?.timeZone) }

    private var days: [Day] {
        let zone = viewerZone
        let visible = upcoming.events.filter { $0.status != .cancelled }
        let grouped = Dictionary(grouping: visible) { CalendarText.dayStart($0.start, zone: zone) }
        return grouped.keys.sorted().map { day in
            Day(
                id: day,
                title: CalendarText.dayTitle(day, zone: zone),
                events: (grouped[day] ?? []).sorted { $0.start < $1.start }
            )
        }
    }

    private var problems: [CalendarSource] { upcoming.sources.filter { $0.status != .ok } }

    private var answered: Bool { upcoming.sources.contains { $0.status == .ok } }

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s3) {
            SectionHeader(title: String(localized: "Upcoming"), count: upcoming.events.isEmpty ? nil : upcoming.events.count)
            ForEach(problems, id: \.connectionId) { source in
                sourceProblem(source)
            }
            if days.isEmpty {
                if answered {
                    Text("Nothing on your calendar in the next 7 days.")
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(days) { day in
                        Text(day.title)
                            .meridianFont(.label)
                            .foregroundStyle(MeridianColor.textSecondary)
                            .accessibilityAddTraits(.isHeader)
                            .padding(.top, MeridianSpace.s3)
                            .padding(.bottom, MeridianSpace.s1)
                        ForEach(day.events, id: \.listId) { event in
                            eventRow(event)
                            if event.listId != day.events.last?.listId {
                                Divider().overlay(MeridianColor.border)
                            }
                        }
                    }
                }
                .padding(.horizontal, MeridianSpace.s4)
                .padding(.bottom, MeridianSpace.s2)
                .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MeridianRadius.lg, style: .continuous)
                        .strokeBorder(MeridianColor.border, lineWidth: 1)
                }
            }
        }
    }

    @ViewBuilder
    private func sourceProblem(_ source: CalendarSource) -> some View {
        if let text = source.problem {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                NoteView(text: text, systemImage: "exclamationmark.triangle", tone: .warning)
                if source.status == .expired, source.provider != .unknown {
                    ReconnectButton(provider: source.provider, capability: .calendarRead)
                } else if source.needsConnectionFix {
                    NavigationLink(value: ConnectionsRoute()) {
                        Label("Open Connections", systemImage: MeridianIcon.connections)
                    }
                    .buttonStyle(.meridianSecondary)
                }
            }
        }
    }

    private func eventRow(_ event: CalendarEventSummary) -> some View {
        let link = ExternalLink.url(event.webLink)
        return Button {
            if let link { openURL(link) }
        } label: {
            HStack(alignment: .top, spacing: MeridianSpace.s3) {
                Text(time(event))
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .frame(minWidth: 72, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 2) {
                    // Titles of invitations are written by others: shown as they are, isolated.
                    Text(verbatim: event.title.isEmpty ? String(localized: "(no title)") : event.title.bidiIsolated)
                        .meridianFont(.bodyStrong)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .multilineTextAlignment(.leading)
                        .lineLimit(3)
                    if let location = event.location, !location.isEmpty {
                        Text(verbatim: location.bidiIsolated)
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textSecondary)
                            .lineLimit(2)
                    }
                    HStack(spacing: MeridianSpace.s2) {
                        Text(event.provider.name)
                        if event.attendeeCount > 0 {
                            Text("People: \(event.attendeeCount.formatted())")
                        }
                        if event.status == .tentative {
                            Text("Tentative")
                        }
                    }
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
                }
                Spacer(minLength: 0)
                if link != nil {
                    Image(systemName: "arrow.up.forward.square")
                        .foregroundStyle(MeridianColor.textTertiary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, MeridianSpace.s2)
            .frame(minHeight: MeridianLayout.minTouchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(link == nil)
        .accessibilityElement(children: .combine)
        .accessibilityHint(link != nil ? Text("Opens the event at \(event.provider.name)") : Text(verbatim: ""))
    }

    /// The time in the event's own zone; its zone's short name when it isn't the viewer's.
    private func time(_ event: CalendarEventSummary) -> String {
        if event.allDay { return String(localized: "All day") }
        let range = CalendarText.timeRange(start: event.start, end: event.end, timeZone: event.timeZone ?? app.me?.timeZone)
        guard let identifier = event.timeZone, let own = TimeZone(identifier: identifier),
              own.secondsFromGMT(for: event.start) != viewerZone.secondsFromGMT(for: event.start)
        else { return range }
        return "\(range) \(CalendarText.shortZoneName(own, at: event.start))"
    }
}
