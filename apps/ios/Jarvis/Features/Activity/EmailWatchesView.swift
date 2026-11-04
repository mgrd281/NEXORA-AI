import SwiftUI

/// Threads JARVIS watches for replies (email.track_replies). Subjects and senders are
/// written by other people and shown as they are, isolated.
struct EmailWatchesView: View {
    @Environment(AppModel.self) private var app
    @State private var model = EmailWatchesModel()

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
                Text("JARVIS isn't watching any email threads. Ask it to tell you when someone replies to a message it sent.")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            if !model.watching.isEmpty {
                Section {
                    ForEach(model.watching) { watch in
                        WatchRow(watch: watch, stopping: model.stoppingIds.contains(watch.id)) {
                            Task { await model.stop(watch, api: app.api) }
                        }
                    }
                } header: {
                    Text("Watching")
                } footer: {
                    Text("JARVIS checks each thread about every 10 minutes and tells you when a reply arrives. It only reads who replied and the subject.")
                }
            }
            if !model.ended.isEmpty {
                Section {
                    ForEach(model.ended) { watch in
                        WatchRow(watch: watch, stopping: false, onStop: nil)
                    }
                } header: {
                    Text("Ended")
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .overlay {
            if !model.hasLoaded, model.isLoading { ProgressView() }
        }
        .navigationTitle(Text("Reply tracking"))
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .task {
            for await event in app.live.updates() { model.handle(event, api: app.api) }
        }
    }
}

private struct WatchRow: View {
    let watch: EmailWatch
    let stopping: Bool
    let onStop: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) {
                Text(verbatim: watch.subject.isEmpty ? "—" : watch.subject.bidiIsolated)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: 0)
                ToneBadge(label: watch.status.label, systemImage: watch.status.icon, tone: watch.status.tone)
            }
            Text(watch.provider.name)
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
            detail
            if let onStop {
                Button(role: .destructive, action: onStop) {
                    if stopping {
                        ProgressView()
                    } else {
                        Text("Stop watching")
                    }
                }
                .buttonStyle(.borderless)
                .frame(minHeight: MeridianLayout.minTouchTarget)
                .disabled(stopping)
            }
            if let taskId = watch.taskId {
                NavigationLink(value: TaskRoute(id: taskId)) {
                    Text("Open task")
                        .meridianFont(.label)
                }
            }
        }
        .padding(.vertical, MeridianSpace.s1)
    }

    @ViewBuilder
    private var detail: some View {
        switch watch.status {
        case .watching:
            Text("Until \(MeridianFormat.dateTime(watch.expiresAt))")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        case .replied:
            if let from = watch.replyFrom, let at = watch.replyAt {
                Text("\(from.display.bidiIsolated) replied \(MeridianFormat.relative(at)).")
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textPrimary)
            }
        case .expired:
            Text("No reply arrived before \(MeridianFormat.dateTime(watch.expiresAt)).")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        case .failed:
            Text("The connection stopped working or the thread is gone, so JARVIS stopped checking.")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        case .stopped, .unknown:
            EmptyView()
        }
    }
}
