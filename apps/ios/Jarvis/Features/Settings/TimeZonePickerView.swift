import Observation
import SwiftUI

/// Time zones the server accepts (`GET /v1/meta/time-zones`: known to both its database and
/// its runtime), so the picker never offers a zone the server would reject.
@MainActor
@Observable
final class TimeZoneListModel {
    private(set) var zones: [TimeZoneInfo] = []
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            zones = try await api.timeZones()
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    /// Zones whose identifier or localized name contains the search text.
    func filtered(by search: String) -> [TimeZoneInfo] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return zones }
        return zones.filter { zone in
            Self.displayId(zone.id).localizedStandardContains(query)
                || RecurrenceText.zoneName(zone.id).localizedStandardContains(query)
        }
    }

    /// "America/New_York" → "America/New York".
    static func displayId(_ id: String) -> String {
        id.replacingOccurrences(of: "_", with: " ")
    }
}

struct TimeZonePickerView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var model = TimeZoneListModel()
    @State private var search = ""

    init(selection: Binding<String>) {
        _selection = selection
    }

    var body: some View {
        List {
            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    Task { await model.load(api: app.api) }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            ForEach(model.filtered(by: search)) { zone in
                Button {
                    selection = zone.id
                    dismiss()
                } label: {
                    TimeZoneRow(zone: zone, isSelected: zone.id == selection)
                }
                .foregroundStyle(MeridianColor.textPrimary)
                .accessibilityAddTraits(zone.id == selection ? [.isSelected] : [])
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .overlay {
            if !model.hasLoaded, model.isLoading {
                ProgressView()
            } else if model.hasLoaded, model.filtered(by: search).isEmpty {
                ContentUnavailableView.search(text: search)
            }
        }
        .navigationTitle(Text("Time zone"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: Text("Search time zones"))
        .task { await model.load(api: app.api) }
    }
}

private struct TimeZoneRow: View {
    let zone: TimeZoneInfo
    let isSelected: Bool

    var body: some View {
        HStack(spacing: MeridianSpace.s3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: TimeZoneListModel.displayId(zone.id))
                    .meridianFont(.body)
                Text(verbatim: RecurrenceText.zoneName(zone.id))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            Spacer(minLength: MeridianSpace.s2)
            Text(verbatim: zone.offsetLabel)
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
                .environment(\.layoutDirection, .leftToRight)
            if isSelected {
                Image(systemName: "checkmark")
                    .foregroundStyle(MeridianColor.accent)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: MeridianLayout.minTouchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
