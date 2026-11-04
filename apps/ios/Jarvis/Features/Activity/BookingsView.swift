import SwiftUI

/// Appointments JARVIS booked or tried to book, newest first (read-only records).
struct BookingsView: View {
    @Environment(AppModel.self) private var app
    @State private var model = PagedListModel<Booking>(eventType: .bookingChanged) { api, cursor in
        try await api.bookings(cursor: cursor)
    }

    var body: some View {
        List {
            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    Task { await model.load(api: app.api) }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if model.hasLoaded, model.items.isEmpty {
                Text("No bookings yet. When JARVIS books an appointment after you approve it, it appears here.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            ForEach(model.items) { booking in
                NavigationLink(value: BookingRoute(id: booking.id)) {
                    BookingRow(booking: booking)
                }
            }
            if model.nextCursor != nil {
                Button("Load more") {
                    Task { await model.loadMore(api: app.api) }
                }
                .disabled(model.isLoading)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .overlay {
            if !model.hasLoaded, model.isLoading { ProgressView() }
        }
        .navigationTitle(Text("Bookings"))
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task {
            for await event in app.live.updates() { model.handle(event, api: app.api) }
        }
    }
}

private struct BookingRow: View {
    let booking: Booking

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            Text(verbatim: "\(booking.service.bidiIsolated) · \(booking.siteName.bidiIsolated)")
                .meridianFont(.bodyStrong)
                .foregroundStyle(MeridianColor.textPrimary)
            Text(CalendarText.when(start: booking.start, end: booking.end, timeZone: booking.timeZone, allDay: false))
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
            ToneBadge(label: booking.status.label, systemImage: booking.status.icon, tone: booking.status.tone)
        }
        .padding(.vertical, MeridianSpace.s1)
        .accessibilityElement(children: .combine)
    }
}

struct BookingDetailView: View {
    @Environment(AppModel.self) private var app
    @State private var model: RecordModel<Booking>

    init(bookingId: String) {
        _model = State(initialValue: RecordModel<Booking>(id: bookingId, eventType: .bookingChanged, idKey: "bookingId") { api, id in
            try await api.booking(id: id)
        })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeridianSpace.s4) {
                if let booking = model.record {
                    BookingCard(booking: booking, showsTaskLink: true)
                } else if let error = model.errorMessage {
                    InlineErrorView(message: error) {
                        Task { await model.load(api: app.api) }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, MeridianSpace.s8)
                }
            }
            .padding(MeridianSpace.s4)
            .frame(maxWidth: MeridianLayout.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Booking"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task {
            for await event in app.live.updates() { await model.handle(event, api: app.api) }
        }
    }
}

/// A booking with the time in the site's zone, the reference the site confirmed and the
/// evidence (screenshot, ICS file). Never shows a reference the site didn't give.
struct BookingCard: View {
    @Environment(AppModel.self) private var app
    let booking: Booking
    var showsTaskLink = false

    var body: some View {
        Card {
            header
            facts
            if !booking.evidence.isEmpty {
                Text("Evidence")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(booking.evidence) { artifact in
                    EvidenceArtifactView(artifact: artifact)
                }
            }
            if showsTaskLink, let taskId = booking.taskId {
                NavigationLink(value: TaskRoute(id: taskId)) {
                    Label("Open task", systemImage: MeridianIcon.tasks)
                }
                .buttonStyle(.meridianSecondary)
            }
        }
        .meridianFont(.callout)
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
            Label {
                Text(verbatim: booking.service.bidiIsolated)
            } icon: {
                Image(systemName: "calendar.badge.checkmark")
                    .accessibilityHidden(true)
            }
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.textPrimary)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            ToneBadge(label: booking.status.label, systemImage: booking.status.icon, tone: booking.status.tone)
        }
        Text(verbatim: "\(booking.siteName.bidiIsolated) · \(booking.siteHost)")
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textSecondary)
        if let note = booking.status.note {
            NoteView(text: note, systemImage: booking.status == .failed ? "info.circle" : "exclamationmark.triangle", tone: booking.status == .failed ? .neutral : .warning)
        }
        if let reason = booking.failureReason, let text = CommerceFailureText.describe(reason) {
            Text(text)
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
        }
    }

    @ViewBuilder
    private var facts: some View {
        LabeledContent {
            Text(CalendarText.when(start: booking.start, end: booking.end, timeZone: booking.timeZone, allDay: false, viewerZone: app.me?.timeZone))
                .multilineTextAlignment(.trailing)
        } label: {
            Text("When")
        }
        LabeledContent {
            Text(RecurrenceText.zoneName(booking.timeZone))
                .multilineTextAlignment(.trailing)
        } label: {
            Text("Time zone")
        }
        if let reference = booking.reference {
            LabeledContent {
                Text(verbatim: reference).textSelection(.enabled)
            } label: {
                Text("Reference")
            }
        }
        if let price = booking.price {
            LabeledContent {
                Text(verbatim: price.formatted)
            } label: {
                Text("Price")
            }
        }
        if booking.binding {
            Label("Binding with the site (cancellation fees may apply).", systemImage: "exclamationmark.triangle")
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.warning)
        }
        LabeledContent {
            Text(booking.calendarEventId != nil ? String(localized: "Added") : String(localized: "Not added"))
        } label: {
            Text("In your calendar")
        }
    }
}
