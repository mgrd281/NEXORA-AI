import Observation
import SwiftUI

@MainActor
@Observable
final class SkillsModel {
    private(set) var skills: [Skill] = []
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    var builtSkills: [Skill] { skills.filter { $0.status != .planned } }
    var plannedSkills: [Skill] { skills.filter { $0.status == .planned } }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            skills = try await api.skills()
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}

/// What JARVIS can do for this account, with each skill's real availability as the server
/// reports it. Read-only here: skills are switched on or off in JARVIS on the web. Skills
/// never grant permissions; the safety policy decides every step.
struct SkillsView: View {
    @Environment(AppModel.self) private var app
    @State private var model = SkillsModel()

    var body: some View {
        List {
            if let error = model.errorMessage {
                InlineErrorView(message: error) {
                    Task { await model.load(api: app.api) }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
            if model.hasLoaded {
                Section {
                    ForEach(model.builtSkills) { skill in
                        SkillRow(skill: skill)
                            .listRowBackground(MeridianColor.surface)
                    }
                } footer: {
                    Text("Skills never grant permissions: the safety policy still checks every step, and anything risky still asks you first. Turn skills on or off in JARVIS on the web.")
                }
                if !model.plannedSkills.isEmpty {
                    Section {
                        ForEach(model.plannedSkills) { skill in
                            SkillRow(skill: skill)
                                .listRowBackground(MeridianColor.surface)
                        }
                    } header: {
                        Text("Coming later")
                    } footer: {
                        Text("Described in the product plan but not built yet. They can't run.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .overlay {
            if !model.hasLoaded, model.isLoading {
                ProgressView()
            }
        }
        .navigationTitle(Text("Skills"))
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
    }
}

private struct SkillRow: View {
    let skill: Skill

    var body: some View {
        HStack(alignment: .top, spacing: MeridianSpace.s3) {
            Image(systemName: skill.skillId.icon)
                .foregroundStyle(MeridianColor.textSecondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: MeridianSpace.s2) { header }
                    VStack(alignment: .leading, spacing: MeridianSpace.s1) { header }
                }
                Text(skill.skillId.summary)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let reason = skill.unavailableText {
                    Text(reason)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                } else if !skill.canToggle, skill.status == .implemented {
                    Text("Part of how JARVIS plans and asks questions, so it can't be turned off.")
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if skill.status != .planned {
                    Text(skill.modelUse.label)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textTertiary)
                }
            }
        }
        .padding(.vertical, MeridianSpace.s1)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var header: some View {
        Text(skill.skillId.name)
            .meridianFont(.bodyStrong)
            .foregroundStyle(MeridianColor.textPrimary)
        ToneBadge(label: skill.stateLabel, systemImage: skill.stateIcon, tone: skill.stateTone)
    }
}
