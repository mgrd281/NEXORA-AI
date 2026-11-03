import SwiftUI

@main
struct JarvisApp: App {
    @State private var model: AppModel? = nil
    private let configurationProblem: AppConfiguration.Problem?

    init() {
        switch AppConfiguration.load() {
        case .success(let configuration):
            _model = State(initialValue: AppModel(configuration: configuration))
            configurationProblem = nil
        case .failure(let problem):
            _model = State(initialValue: nil)
            configurationProblem = problem
        }
    }

    var body: some Scene {
        WindowGroup {
            if let model {
                RootView()
                    .environment(model)
            } else {
                ConfigurationProblemView(problem: configurationProblem ?? .missing)
            }
        }
    }
}

/// Shown when the build has no usable API address. Nothing else can work without one.
private struct ConfigurationProblemView: View {
    let problem: AppConfiguration.Problem

    var body: some View {
        ContentUnavailableView {
            Label("JARVIS isn't configured", systemImage: "wrench.and.screwdriver")
        } description: {
            Text(detail)
        }
        .background(MeridianColor.canvas)
    }

    private var detail: String {
        switch problem {
        case .missing:
            String(localized: "This build has no API address. Set JARVIS_API_BASE_URL in the build configuration.")
        case .invalid(let value):
            String(localized: "The API address “\(value)” isn't a valid URL.")
        case .insecure(let value):
            String(localized: "The API address “\(value)” must use HTTPS. Plain HTTP is only allowed for localhost.")
        }
    }
}
