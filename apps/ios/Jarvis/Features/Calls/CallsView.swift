import Observation
import SwiftUI

/// One call with every turn (`GET /v1/calls/:id`), refreshed while it is live.
@MainActor
@Observable
final class CallDetailModel {
    let callId: String
    private(set) var call: CallSession?
    private(set) var errorMessage: String?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    init(callId: String) {
        self.callId = callId
    }

    func load(api: APIClient) async {
        do {
            call = try await api.call(id: callId)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    /// `call.turn` / `call.status_changed` of this call (live captions): refetch.
    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == .callTurn || event.type == .callStatusChanged,
              event.data["callId"]?.stringValue == callId
        else { return }
        scheduleRefresh(api: api)
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }
}

struct CallDetailView: View {
    @Environment(AppModel.self) private var app
    @State private var model: CallDetailModel

    init(callId: String) {
        _model = State(initialValue: CallDetailModel(callId: callId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeridianSpace.s4) {
                if let call = model.call {
                    CallCard(call: call, showsAllTurns: true)
                    NavigationLink(value: TaskRoute(id: call.taskId)) {
                        Label("Open the task", systemImage: MeridianIcon.tasks)
                    }
                    .buttonStyle(.meridianSecondary)
                } else if let error = model.errorMessage {
                    InlineErrorView(message: error) {
                        model.scheduleRefresh(api: app.api)
                    }
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, MeridianSpace.s10)
                }
            }
            .padding(MeridianSpace.s4)
            .frame(maxWidth: MeridianLayout.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Call"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task {
            for await event in app.live.updates() {
                model.handle(event, api: app.api)
            }
        }
        .onChange(of: app.live.openCount) { _, _ in
            model.scheduleRefresh(api: app.api)
        }
    }
}

/// Calls JARVIS placed or tried to place, newest first (`GET /v1/calls`).
@MainActor
@Observable
final class CallsModel {
    var filter: CallResult? = nil
    private(set) var calls: [CallSummary] = []
    private(set) var nextCursor: String?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    /// The results offered as filters (nil = all).
    static let filters: [CallResult?] = [nil, .completed, .answered, .busy, .noAnswer, .voicemail, .failed, .hungUp, .declined]

    func reload(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await api.calls(result: filter, cursor: nil)
            calls = page.items
            nextCursor = page.nextCursor
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func loadMore(api: APIClient) async {
        guard let cursor = nextCursor, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await api.calls(result: filter, cursor: cursor)
            let known = Set(calls.map(\.id))
            calls.append(contentsOf: page.items.filter { !known.contains($0.id) })
            nextCursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == .callStatusChanged else { return }
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.reload(api: api)
        }
    }
}

struct CallsView: View {
    @Environment(AppModel.self) private var app
    @State private var model = CallsModel()

    var body: some View {
        List {
            Section {
                Picker(selection: $model.filter) {
                    ForEach(Array(CallsModel.filters.enumerated()), id: \.offset) { item in
                        Text(item.element?.label ?? String(localized: "All calls")).tag(item.element)
                    }
                } label: {
                    Text("Show")
                }
            }
            if let error = model.errorMessage {
                Section {
                    InlineErrorView(message: error) {
                        Task { await model.reload(api: app.api) }
                    }
                    .listRowInsets(EdgeInsets())
                }
            }
            Section {
                if model.hasLoaded, model.calls.isEmpty {
                    Text("No calls yet. JARVIS calls only when you ask for a call and approve it.")
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
                ForEach(model.calls) { call in
                    NavigationLink(value: CallRoute(id: call.id)) {
                        CallRow(call: call)
                    }
                }
                if model.nextCursor != nil {
                    Button("Show more") {
                        Task { await model.loadMore(api: app.api) }
                    }
                    .disabled(model.isLoading)
                }
            } footer: {
                Text("JARVIS keeps what was said on each call as text with its task. Audio is kept only when you asked for a recording and the other person agreed.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Calls"))
        .refreshable { await model.reload(api: app.api) }
        .task { await model.reload(api: app.api) }
        .task {
            for await event in app.live.updates() {
                model.handle(event, api: app.api)
            }
        }
        .onChange(of: model.filter) { _, _ in
            Task { await model.reload(api: app.api) }
        }
    }
}

private struct CallRow: View {
    let call: CallSummary

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: call.displayName.bidiIsolated)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                Spacer(minLength: MeridianSpace.s2)
                CallBadge(call: call)
            }
            if let title = call.displayTaskTitle {
                Text(verbatim: title)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .lineLimit(1)
            }
            Text(verbatim: "\(call.purpose.label) · \(MeridianFormat.dateTime(call.createdAt))")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
            if let text = call.failureText {
                Text(text)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, MeridianSpace.s1)
        .accessibilityElement(children: .combine)
    }
}
