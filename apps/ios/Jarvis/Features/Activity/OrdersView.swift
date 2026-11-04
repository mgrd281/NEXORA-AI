import SwiftUI

/// Orders JARVIS placed or tried to place, newest first. Read-only: a record of what
/// happened, with the merchant's confirmation as evidence.
struct OrdersView: View {
    @Environment(AppModel.self) private var app
    @State private var model = PagedListModel<Order>(eventType: .orderChanged) { api, cursor in
        try await api.orders(cursor: cursor)
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
                Text("No orders yet. When JARVIS places an order after you approve it, it appears here.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            ForEach(model.items) { order in
                NavigationLink(value: OrderRoute(id: order.id)) {
                    OrderRow(order: order)
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
        .navigationTitle(Text("Orders"))
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task {
            for await event in app.live.updates() { model.handle(event, api: app.api) }
        }
    }
}

private struct OrderRow: View {
    let order: Order

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: order.merchantName.bidiIsolated)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                Spacer(minLength: MeridianSpace.s2)
                Text(verbatim: order.total.formatted)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
            }
            Text(verbatim: order.items.map { "\($0.quantity.formatted()) × \($0.title.bidiIsolated)" }.joined(separator: ", "))
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
                .lineLimit(2)
            HStack(spacing: MeridianSpace.s2) {
                ToneBadge(label: order.status.label, systemImage: order.status.icon, tone: order.status.tone)
                Text(MeridianFormat.dateTime(order.placedAt ?? order.createdAt))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
        }
        .padding(.vertical, MeridianSpace.s1)
        .accessibilityElement(children: .combine)
    }
}

struct OrderDetailView: View {
    @Environment(AppModel.self) private var app
    @State private var model: RecordModel<Order>

    init(orderId: String) {
        _model = State(initialValue: RecordModel<Order>(id: orderId, eventType: .orderChanged, idKey: "orderId") { api, id in
            try await api.order(id: id)
        })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeridianSpace.s4) {
                if let order = model.record {
                    OrderCard(order: order, showsTaskLink: true)
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
        .navigationTitle(Text("Order"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task {
            for await event in app.live.updates() { await model.handle(event, api: app.api) }
        }
    }
}

/// An order with exactly what was bought, the totals the merchant confirmed and its evidence.
struct OrderCard: View {
    let order: Order
    var showsTaskLink = false

    var body: some View {
        Card {
            header
            Divider().overlay(MeridianColor.border)
            ForEach(Array(order.items.enumerated()), id: \.offset) { item in
                LineItemRow(title: item.element.title, quantity: item.element.quantity, unitPrice: item.element.unitPrice, lineTotal: item.element.lineTotal)
            }
            Divider().overlay(MeridianColor.border)
            totals
            facts
            if !order.evidence.isEmpty {
                Text("Evidence")
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textSecondary)
                ForEach(order.evidence) { artifact in
                    EvidenceArtifactView(artifact: artifact)
                }
            }
            if showsTaskLink, let taskId = order.taskId {
                NavigationLink(value: TaskRoute(id: taskId)) {
                    Label("Open task", systemImage: MeridianIcon.tasks)
                }
                .buttonStyle(.meridianSecondary)
            }
        }
    }

    @ViewBuilder
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
            Label {
                Text(verbatim: order.merchantName.bidiIsolated)
            } icon: {
                Image(systemName: "bag")
                    .accessibilityHidden(true)
            }
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.textPrimary)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            ToneBadge(label: order.status.label, systemImage: order.status.icon, tone: order.status.tone)
        }
        Text(verbatim: order.merchantHost)
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textSecondary)
            .environment(\.layoutDirection, .leftToRight)
        if let note = order.status.note {
            NoteView(text: note, systemImage: order.status == .failed ? "info.circle" : "exclamationmark.triangle", tone: order.status == .failed ? .neutral : .warning)
        }
        if let reason = order.failureReason, let text = CommerceFailureText.describe(reason) {
            Text(text)
                .meridianFont(.callout)
                .foregroundStyle(MeridianColor.textPrimary)
        }
    }

    @ViewBuilder
    private var totals: some View {
        AmountRow(label: String(localized: "Subtotal"), money: order.subtotal)
        AmountRow(label: String(localized: "Shipping"), money: order.shipping)
        if let tax = order.tax {
            AmountRow(label: String(localized: "Tax"), money: tax)
        }
        AmountRow(label: String(localized: "Total"), money: order.total, emphasized: true)
    }

    @ViewBuilder
    private var facts: some View {
        if let number = order.merchantOrderId {
            LabeledContent {
                Text(verbatim: number).textSelection(.enabled)
            } label: {
                Text("Order number")
            }
            .meridianFont(.callout)
        }
        if let placed = order.placedAt {
            LabeledContent {
                Text(MeridianFormat.dateTime(placed))
            } label: {
                Text("Placed")
            }
            .meridianFont(.callout)
        }
    }
}

/// "2 × Title … $49.98" with the unit price below.
struct LineItemRow: View {
    let title: String
    let quantity: Int
    let unitPrice: Money?
    let lineTotal: Money

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "\(quantity.formatted()) × \(title.bidiIsolated)")
                    .meridianFont(.body)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let unitPrice, quantity > 1 {
                    Text("\(unitPrice.formatted) each")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
            }
            Spacer(minLength: MeridianSpace.s2)
            Text(verbatim: lineTotal.formatted)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
        }
        .accessibilityElement(children: .combine)
    }
}

struct AmountRow: View {
    let label: String
    let money: Money
    var emphasized = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .meridianFont(emphasized ? .bodyStrong : .callout)
                .foregroundStyle(emphasized ? MeridianColor.textPrimary : MeridianColor.textSecondary)
            Spacer(minLength: MeridianSpace.s2)
            Text(verbatim: money.formatted)
                .meridianFont(emphasized ? .bodyStrong : .callout)
                .foregroundStyle(MeridianColor.textPrimary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Why an order or booking failed, from its stored reason (stored without parameters).
enum CommerceFailureText {
    static func describe(_ reason: String) -> String? {
        if let text = TaskErrorText.reasonText(reason, params: [:]) { return text }
        switch reason {
        case "PRICE_CHANGED":
            return String(localized: "The price changed before the order was placed, so nothing was ordered.")
        case "CHECKOUT_UNSUPPORTED":
            return String(localized: "JARVIS can't order on this site. Finish the purchase on the site yourself.")
        default:
            return BrowserStopReason(rawValue: reason).map(\.label)
        }
    }
}
