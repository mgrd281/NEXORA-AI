import Observation
import SwiftUI

/// The monthly purchase limit (`preferences.spending.monthlyPurchaseLimitUsd`). 0 — the
/// default — turns purchases off; the Policy Engine refuses any purchase over the limit.
/// Raising the limit asks for confirmation first; the screen shows only what the server saved.
@MainActor
@Observable
final class SpendingModel {
    /// `COMMERCE_LIMITS.monthlyPurchaseLimitUsdMax`.
    nonisolated static let maxLimitUsd = 10_000

    /// The amount being edited, in whole US dollars.
    var draftUsd = 0
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var savedNotice: String?

    func sync(from me: Me?) {
        guard let me else { return }
        draftUsd = Self.wholeDollars(me.preferences.spending.monthlyPurchaseLimitUsd)
    }

    nonisolated static func wholeDollars(_ value: Double) -> Int {
        guard value.isFinite, value > 0 else { return 0 }
        return min(maxLimitUsd, Int(value.rounded(.down)))
    }

    var isValid: Bool { (0...Self.maxLimitUsd).contains(draftUsd) }

    func hasChanges(against me: Me?) -> Bool {
        guard let me else { return false }
        return Double(draftUsd) != me.preferences.spending.monthlyPurchaseLimitUsd
    }

    /// True when saving would let JARVIS spend more than now (asks for confirmation first).
    func raisesLimit(against me: Me?) -> Bool {
        guard let me else { return false }
        return Double(draftUsd) > me.preferences.spending.monthlyPurchaseLimitUsd
    }

    /// Only the purchase limit is sent; the AI budget keeps its stored value.
    nonisolated static func patch(limitUsd: Int) -> UpdateMeRequest {
        var preferences = PreferencesPatch()
        preferences.spending = PreferencesPatch.Spending(monthlyAiBudgetUsd: nil, monthlyPurchaseLimitUsd: Double(limitUsd))
        return UpdateMeRequest(preferences: preferences)
    }

    func save(_ limitUsd: Int, app: AppModel) async {
        guard (0...Self.maxLimitUsd).contains(limitUsd), !isSaving else { return }
        isSaving = true
        errorMessage = nil
        savedNotice = nil
        defer { isSaving = false }
        do {
            try await app.updateMe(Self.patch(limitUsd: limitUsd))
            sync(from: app.me)
            let saved = app.me?.preferences.spending.monthlyPurchaseLimitUsd ?? 0
            savedNotice = saved > 0
                ? String(localized: "Saved. JARVIS may spend up to \(Self.usd(saved)) a month, each purchase after you approve it.")
                : String(localized: "Saved. Purchases are off.")
        } catch is CancellationError {
            sync(from: app.me)
        } catch {
            errorMessage = ErrorText.message(for: error)
            sync(from: app.me)
        }
    }

    nonisolated static func usd(_ amount: Double) -> String {
        amount.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
    }
}

struct SpendingView: View {
    @Environment(AppModel.self) private var app
    @State private var model = SpendingModel()
    @State private var confirmingRaise = false

    private var current: Double { app.me?.preferences.spending.monthlyPurchaseLimitUsd ?? 0 }

    var body: some View {
        Form {
            if let error = model.errorMessage {
                Section {
                    InlineErrorView(message: error)
                        .listRowInsets(EdgeInsets())
                }
            }
            if let notice = model.savedNotice {
                Section {
                    NoteView(text: notice, systemImage: "checkmark.circle", tone: .success)
                        .listRowInsets(EdgeInsets())
                }
            }
            Section {
                LabeledContent {
                    if current > 0 {
                        Text(verbatim: SpendingModel.usd(current))
                    } else {
                        ToneBadge(label: String(localized: "Purchases off"), systemImage: "nosign", tone: .neutral)
                    }
                } label: {
                    Text("Now")
                }
                TextField("Monthly limit in US dollars", value: $model.draftUsd, format: .number)
                    .keyboardType(.numberPad)
                .accessibilityHint(Text("0 turns purchases off"))
                if !model.isValid {
                    Text("Enter an amount from $0 to $10,000.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.danger)
                }
                Button {
                    if model.raisesLimit(against: app.me) {
                        confirmingRaise = true
                    } else {
                        Task { await model.save(model.draftUsd, app: app) }
                    }
                } label: {
                    if model.isSaving {
                        ProgressView()
                    } else {
                        Text("Save limit")
                    }
                }
                .disabled(!model.isValid || !model.hasChanges(against: app.me) || model.isSaving)
                if current > 0 {
                    Button("Turn purchases off", role: .destructive) {
                        model.draftUsd = 0
                        Task { await model.save(0, app: app) }
                    }
                    .disabled(model.isSaving)
                }
            } header: {
                Text("Monthly purchase limit")
            } footer: {
                Text("The most JARVIS may spend on purchases in a calendar month of your time zone. Orders being placed, placed, or with an unknown outcome count against it. Purchases in other currencies are refused, and every purchase still needs your approval of the exact items and total.")
            }

            Section {
                if let budget = app.me?.preferences.spending.monthlyAiBudgetUsd {
                    LabeledContent {
                        Text(verbatim: SpendingModel.usd(budget))
                    } label: {
                        Text("Monthly AI budget")
                    }
                }
            } footer: {
                Text("Separate from the purchase limit: it covers the cost of AI models and is changed on the web.")
            }

            Section {
                NavigationLink(value: OrdersRoute()) {
                    Label("Orders", systemImage: "bag")
                }
                NavigationLink(value: BookingsRoute()) {
                    Label("Bookings", systemImage: "calendar.badge.checkmark")
                }
            } header: {
                Text("History")
            }
        }
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Spending"))
        .navigationBarTitleDisplayMode(.inline)
        .task { model.sync(from: app.me) }
        .confirmationDialog(
            Text("Allow JARVIS to spend up to \(SpendingModel.usd(Double(model.draftUsd))) a month?"),
            isPresented: $confirmingRaise,
            titleVisibility: .visible
        ) {
            Button("Allow purchases up to this limit") {
                Task { await model.save(model.draftUsd, app: app) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("JARVIS still asks you before every purchase and shows the exact items, total, merchant and delivery. It never buys more than this in a month.")
        }
    }
}
