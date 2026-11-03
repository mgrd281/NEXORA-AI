import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var app

    @State private var email = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String? = nil
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case email
        case password
    }

    init() {}

    private var canSubmit: Bool {
        !isSubmitting
            && email.trimmingCharacters(in: .whitespacesAndNewlines).contains("@")
            && !password.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MeridianSpace.s6) {
                VStack(alignment: .leading, spacing: MeridianSpace.s3) {
                    PresenceView(state: isSubmitting ? .planning : .idle, diameter: 56)
                    Text("Sign in to JARVIS")
                        .meridianFont(.display)
                        .foregroundStyle(MeridianColor.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text("Your personal agent. It asks before it acts.")
                        .meridianFont(.body)
                        .foregroundStyle(MeridianColor.textSecondary)
                }

                if let notice = app.signInNotice {
                    NoteView(text: notice)
                }

                VStack(alignment: .leading, spacing: MeridianSpace.s4) {
                    field(label: String(localized: "Email")) {
                        TextField(text: $email) { Text(verbatim: "name@example.com") }
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .focused($focus, equals: .email)
                            .onSubmit { focus = .password }
                    }
                    field(label: String(localized: "Password")) {
                        SecureField(text: $password) { Text("Password") }
                            .textContentType(.password)
                            .submitLabel(.go)
                            .focused($focus, equals: .password)
                            .onSubmit { submit() }
                    }
                }

                if let errorMessage {
                    InlineErrorView(message: errorMessage)
                }

                Button {
                    submit()
                } label: {
                    if isSubmitting {
                        ProgressView()
                            .tint(MeridianColor.onInk)
                            .accessibilityLabel(Text("Signing in"))
                    } else {
                        Text("Sign in")
                    }
                }
                .buttonStyle(.meridianPrimary)
                .disabled(!canSubmit)

                Text("Connected to \(app.configuration.apiBaseURL.host() ?? app.configuration.apiBaseURL.absoluteString)")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textTertiary)
            }
            .padding(.horizontal, MeridianSpace.s6)
            .padding(.vertical, MeridianSpace.s10)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(MeridianColor.canvas)
    }

    private func field<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            Text(label)
                .meridianFont(.label)
                .foregroundStyle(MeridianColor.textSecondary)
                .accessibilityHidden(true)
            content()
                .meridianFont(.body)
                .padding(.horizontal, MeridianSpace.s3)
                .frame(minHeight: MeridianLayout.minTouchTarget)
                .background(MeridianColor.surface, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous)
                        .strokeBorder(MeridianColor.borderControl, lineWidth: 1)
                }
                .accessibilityLabel(Text(label))
        }
    }

    private func submit() {
        guard canSubmit else { return }
        isSubmitting = true
        errorMessage = nil
        focus = nil
        Task {
            do {
                try await app.signIn(email: email, password: password)
                password = ""
            } catch let error as ApiError where error.code == .unauthenticated {
                errorMessage = String(localized: "Email or password is incorrect.")
            } catch {
                errorMessage = ErrorText.message(for: error)
            }
            isSubmitting = false
        }
    }
}
