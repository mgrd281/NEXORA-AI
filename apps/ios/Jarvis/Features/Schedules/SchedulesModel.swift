import Foundation
import Observation

/// The user's schedules with pause, resume and delete. Every change shows the schedule the
/// server returns (or reloads), so the list never claims a state the server doesn't have.
@MainActor
@Observable
final class SchedulesModel {
    private(set) var items: [Schedule] = []
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var busyIds: Set<String> = []

    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    /// `SCHEDULE_LIMITS.maxPerUser`: schedules that are not finished.
    static let maxPerUser = 20

    var openCount: Int { items.filter { $0.status != .completed }.count }

    func load(api: APIClient) async {
        isLoading = true
        defer { isLoading = false }
        do {
            items = try await api.schedules()
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func handle(_ event: StreamEvent, api: APIClient) {
        guard event.type == .scheduleChanged else { return }
        scheduleRefresh(api: api)
    }

    func scheduleRefresh(api: APIClient) {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.load(api: api)
        }
    }

    /// Shows a schedule the server just returned (created, edited, paused or resumed).
    func apply(_ schedule: Schedule) {
        if let index = items.firstIndex(where: { $0.id == schedule.id }) {
            items[index] = schedule
        } else {
            items.insert(schedule, at: 0)
        }
    }

    func pause(_ schedule: Schedule, api: APIClient) async {
        await perform(schedule, api: api) { try await api.pauseSchedule(id: schedule.id) }
    }

    func resume(_ schedule: Schedule, api: APIClient) async {
        await perform(schedule, api: api) { try await api.resumeSchedule(id: schedule.id) }
    }

    func delete(_ schedule: Schedule, api: APIClient) async {
        guard !busyIds.contains(schedule.id) else { return }
        busyIds.insert(schedule.id)
        defer { busyIds.remove(schedule.id) }
        do {
            try await api.deleteSchedule(id: schedule.id)
            items.removeAll { $0.id == schedule.id }
            errorMessage = nil
        } catch let error as ApiError where error.code == .notFound {
            items.removeAll { $0.id == schedule.id }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    private func perform(_ schedule: Schedule, api: APIClient, _ action: () async throws -> Schedule) async {
        guard !busyIds.contains(schedule.id) else { return }
        busyIds.insert(schedule.id)
        defer { busyIds.remove(schedule.id) }
        do {
            let updated = try await action()
            apply(updated)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
            // Show where the schedule really is (for example completed meanwhile).
            let message = errorMessage
            await load(api: api)
            errorMessage = message
        }
    }
}
