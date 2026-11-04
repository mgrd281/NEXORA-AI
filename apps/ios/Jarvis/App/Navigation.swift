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

// Phase C
/// Google, Microsoft and the other connections.
struct ConnectionsRoute: Hashable {}

/// The monthly purchase limit.
struct SpendingRoute: Hashable {}

struct OrdersRoute: Hashable {}

struct OrderRoute: Hashable {
    let id: String
}

struct BookingsRoute: Hashable {}

struct BookingRoute: Hashable {
    let id: String
}

/// Threads JARVIS watches for replies.
struct EmailWatchesRoute: Hashable {}

// Phase D
/// One call with every turn.
struct CallRoute: Hashable {
    let id: String
}

/// Calls JARVIS placed.
struct CallsRoute: Hashable {}

/// The account's phone number and its verification.
struct PhoneSettingsRoute: Hashable {}

/// Numbers JARVIS won't call.
struct DoNotCallRoute: Hashable {}

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
        .navigationDestination(for: ConnectionsRoute.self) { _ in
            ConnectionsView()
        }
        .navigationDestination(for: SpendingRoute.self) { _ in
            SpendingView()
        }
        .navigationDestination(for: OrdersRoute.self) { _ in
            OrdersView()
        }
        .navigationDestination(for: OrderRoute.self) { route in
            OrderDetailView(orderId: route.id)
        }
        .navigationDestination(for: BookingsRoute.self) { _ in
            BookingsView()
        }
        .navigationDestination(for: BookingRoute.self) { route in
            BookingDetailView(bookingId: route.id)
        }
        .navigationDestination(for: EmailWatchesRoute.self) { _ in
            EmailWatchesView()
        }
        .navigationDestination(for: CallRoute.self) { route in
            CallDetailView(callId: route.id)
        }
        .navigationDestination(for: CallsRoute.self) { _ in
            CallsView()
        }
        .navigationDestination(for: PhoneSettingsRoute.self) { _ in
            PhoneSettingsView()
        }
        .navigationDestination(for: DoNotCallRoute.self) { _ in
            DoNotCallView()
        }
    }
}
