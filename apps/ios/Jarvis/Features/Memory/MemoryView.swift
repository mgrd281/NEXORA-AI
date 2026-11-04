import SwiftUI

struct MemoryView: View {
    @Environment(AppModel.self) private var app
    @State private var model = MemoryModel()
    @State private var showingAdd = false
    @State private var pendingDelete: Memory? = nil
    @State private var confirmingDelete = false

    private var memoryEnabled: Bool { app.me?.preferences.memory.enabled ?? true }

    var body: some View {
        NavigationStack {
            List {
                if !memoryEnabled {
                    NoteView(text: String(localized: "Memory is turned off. JARVIS neither reads nor saves memories until you turn it on in JARVIS on the web."))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                if let days = app.me?.preferences.retention.memoryDays {
                    let period = RetentionSetting.period(days: days)
                    NoteView(
                        text: String(localized: "Memories that haven't changed for \(period) are deleted automatically, once a day. Change this in Settings."),
                        systemImage: "clock.arrow.circlepath"
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                if let error = model.errorMessage {
                    InlineErrorView(message: error) {
                        Task { await model.reload(api: app.api) }
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                Section {
                    ForEach(model.items) { memory in
                        MemoryRow(memory: memory, isDeleting: model.deletingIds.contains(memory.id))
                            .listRowBackground(MeridianColor.surface)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    requestDelete(memory)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .contextMenu {
                                Button(role: .destructive) {
                                    requestDelete(memory)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .onAppear {
                                if memory.id == model.items.last?.id {
                                    Task { await model.loadMore(api: app.api) }
                                }
                            }
                    }
                    if model.isLoadingMore {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    }
                } footer: {
                    if model.hasLoaded, !model.items.isEmpty {
                        Text("JARVIS uses these to personalise its work. Delete anything you don't want it to know.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(MeridianColor.canvas)
            .overlay {
                if model.hasLoaded, model.items.isEmpty, model.errorMessage == nil {
                    if model.search.trimmingCharacters(in: .whitespaces).isEmpty {
                        ContentUnavailableView {
                            Label("No memories yet", systemImage: MeridianIcon.memory)
                        } description: {
                            Text("Add facts and preferences you want JARVIS to keep in mind.")
                        } actions: {
                            Button("Add memory") { showingAdd = true }
                                .buttonStyle(.meridianSecondary)
                                .fixedSize()
                        }
                    } else {
                        ContentUnavailableView.search(text: model.search)
                    }
                } else if !model.hasLoaded, model.isLoading {
                    ProgressView()
                }
            }
            .navigationTitle(Text("Memory"))
            .searchable(text: $model.search, prompt: Text("Search memories"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingAdd = true
                    } label: {
                        Label("Add memory", systemImage: "plus")
                    }
                }
            }
            .refreshable { await reload() }
            .task(id: model.search) { await searchChanged() }
            .sheet(isPresented: $showingAdd) {
                AddMemorySheet(model: model)
            }
            .confirmationDialog(
                Text("Delete this memory?"),
                isPresented: $confirmingDelete,
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { memory in
                Button("Delete", role: .destructive) {
                    Task { await model.delete(memory, api: app.api) }
                }
                Button("Keep", role: .cancel) {}
            } message: { memory in
                Text(memory.content)
            }
        }
    }

    private func requestDelete(_ memory: Memory) {
        pendingDelete = memory
        confirmingDelete = true
    }

    private func reload() async {
        await model.reload(api: app.api)
    }

    /// Debounces typing in the search field; `.task(id:)` cancels the previous wait.
    private func searchChanged() async {
        if model.hasLoaded {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
        }
        await model.reload(api: app.api)
    }
}

private struct MemoryRow: View {
    let memory: Memory
    let isDeleting: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text(memory.content)
                .meridianFont(.body)
                .foregroundStyle(MeridianColor.textPrimary)
                .textSelection(.enabled)
            HStack(spacing: MeridianSpace.s2) {
                Text(memory.kind.label)
                Text(verbatim: "·")
                    .accessibilityHidden(true)
                Text(memory.source == .assistant ? String(localized: "Saved by JARVIS") : String(localized: "Added by you"))
                Text(verbatim: "·")
                    .accessibilityHidden(true)
                Text(MeridianFormat.relative(memory.createdAt))
            }
            .meridianFont(.caption)
            .foregroundStyle(MeridianColor.textTertiary)
        }
        .padding(.vertical, MeridianSpace.s1)
        .opacity(isDeleting ? 0.4 : 1)
        .accessibilityElement(children: .combine)
    }
}

private struct AddMemorySheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: MemoryModel

    @State private var content = ""
    @State private var kind: MemoryKind = .fact
    @State private var isSaving = false
    @State private var errorMessage: String? = nil
    @FocusState private var focused: Bool

    init(model: MemoryModel) {
        self.model = model
    }

    private var trimmed: String { content.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What should JARVIS remember?", text: $content, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focused)
                    Picker(selection: $kind) {
                        Text(MemoryKind.fact.label).tag(MemoryKind.fact)
                        Text(MemoryKind.preference.label).tag(MemoryKind.preference)
                    } label: {
                        Text("Type")
                    }
                } footer: {
                    Text(verbatim: "\(trimmed.contractLength.formatted()) / \(1000.formatted())")
                        .foregroundStyle(trimmed.contractLength > 1000 ? MeridianColor.danger : MeridianColor.textTertiary)
                }
                if let errorMessage {
                    Section {
                        InlineErrorView(message: errorMessage)
                            .listRowInsets(EdgeInsets())
                    }
                }
            }
            .navigationTitle(Text("Add memory"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") { save() }
                            .disabled(trimmed.isEmpty || trimmed.contractLength > 1000)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .interactiveDismissDisabled(isSaving)
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        Task {
            if let message = await model.add(kind: kind, content: content, api: app.api) {
                errorMessage = message
                isSaving = false
            } else {
                isSaving = false
                dismiss()
            }
        }
    }
}
