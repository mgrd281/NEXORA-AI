import SwiftUI

struct TaskListView: View {
    @Environment(AppModel.self) private var app
    @State private var model = TaskListModel()
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    filterBar
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                if let error = model.errorMessage {
                    InlineErrorView(message: error) {
                        model.scheduleRefresh(api: app.api)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                Section {
                    ForEach(model.items) { task in
                        NavigationLink(value: TaskRoute(id: task.id)) {
                            TaskRow(task: task)
                        }
                        .listRowBackground(MeridianColor.surface)
                        .onAppear {
                            if task.id == model.items.last?.id { loadMore() }
                        }
                    }
                    if model.isLoadingMore {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(MeridianColor.canvas)
            .overlay {
                if model.hasLoaded, model.items.isEmpty, model.errorMessage == nil {
                    ContentUnavailableView {
                        Label(emptyTitle, systemImage: MeridianIcon.tasks)
                    } description: {
                        Text(emptyDescription)
                    }
                } else if !model.hasLoaded, model.isLoading {
                    ProgressView()
                }
            }
            .navigationTitle(Text("Tasks"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink(value: SchedulesRoute()) {
                        Label("Schedules", systemImage: MeridianIcon.schedules)
                    }
                }
            }
            .jarvisDestinations()
            .refreshable { await reload() }
            .task { await initialLoad() }
            .task { await followEvents() }
            .onChange(of: app.live.openCount) { _, _ in
                model.scheduleRefresh(api: app.api)
            }
        }
    }

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: MeridianSpace.s2) {
                ForEach(TaskListFilter.allCases) { filter in
                    let selected = model.filter == filter
                    Button {
                        select(filter)
                    } label: {
                        Text(filter.label)
                            .meridianFont(.label)
                            .padding(.horizontal, MeridianSpace.s3)
                            .frame(minHeight: MeridianLayout.minTouchTarget)
                            .foregroundStyle(selected ? MeridianColor.onInk : MeridianColor.textPrimary)
                            .background(selected ? MeridianColor.ink : MeridianColor.surface, in: Capsule())
                            .overlay {
                                Capsule().strokeBorder(selected ? Color.clear : MeridianColor.borderControl, lineWidth: 1)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }
            .padding(.vertical, MeridianSpace.s2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Filter tasks"))
    }

    private var emptyTitle: String {
        switch model.filter {
        case .all: String(localized: "No tasks yet")
        case .active: String(localized: "Nothing in progress")
        case .needsApproval: String(localized: "Nothing needs your approval")
        case .completed: String(localized: "No completed tasks")
        case .failed: String(localized: "No failed tasks")
        }
    }

    private var emptyDescription: String {
        switch model.filter {
        case .all: String(localized: "Ask JARVIS for something on Home and it appears here.")
        default: String(localized: "Tasks matching this filter appear here.")
        }
    }

    private func select(_ filter: TaskListFilter) {
        Task { await model.select(filter, api: app.api) }
    }

    private func loadMore() {
        Task { await model.loadMore(api: app.api) }
    }

    private func reload() async {
        await model.reload(api: app.api)
    }

    private func initialLoad() async {
        if model.hasLoaded {
            await model.reload(api: app.api)
        } else {
            await model.select(model.filter, api: app.api)
        }
    }

    private func followEvents() async {
        for await event in app.live.updates() {
            model.handle(event, api: app.api)
        }
    }
}

extension TaskListFilter {
    var label: String {
        switch self {
        case .all: String(localized: "All")
        case .active: String(localized: "In progress")
        case .needsApproval: String(localized: "Needs you")
        case .completed: String(localized: "Completed")
        case .failed: String(localized: "Failed or stopped")
        }
    }
}
