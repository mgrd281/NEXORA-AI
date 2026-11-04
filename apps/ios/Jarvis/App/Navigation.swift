import SwiftUI

// Values pushed onto the app's NavigationStacks. Each tab's stack registers every
// destination once, at its root, with `jarvisDestinations()`, so a task can link to its
// conversation and a conversation to its schedule from whichever tab the user is in.

struct TaskRoute: Hashable {
    let id: String
    /// Pushed from a conversation thread: the task screen then doesn't link back to it.
    var fromConversation = false
}

struct ConversationRoute: Hashable {
    let id: String
    /// Opens with the reply field focused (answering a clarifying question).
    var answering = false
}

struct ScheduleRoute: Hashable {
    let id: String
}

/// The list of schedules.
struct SchedulesRoute: Hashable {}

extension View {
    /// Registers the app's push destinations. Apply once per NavigationStack, on its root view.
    func jarvisDestinations() -> some View {
        navigationDestination(for: TaskRoute.self) { route in
            TaskDetailView(taskId: route.id, showsConversationLink: !route.fromConversation)
        }
        .navigationDestination(for: ConversationRoute.self) { route in
            ConversationThreadView(conversationId: route.id, answering: route.answering)
        }
        .navigationDestination(for: ScheduleRoute.self) { route in
            ScheduleDetailView(scheduleId: route.id)
        }
        .navigationDestination(for: SchedulesRoute.self) { _ in
            SchedulesView()
        }
    }
}
