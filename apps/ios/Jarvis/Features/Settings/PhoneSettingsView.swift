import Observation
import SwiftUI

/// The account's own phone number as typed: E.164 (the server validates it again and refuses
/// numbers it wouldn't call).
enum PhoneNumberInput {
    /// The E.164 form of what was typed — spaces, dashes, dots, slashes and parentheses removed,
    /// Arabic-Indic digits read as digits, a leading 00 read as + — or nil unless it is "+" and
    /// 8–15 digits not starting with 0.
    static func normalize(_ raw: String) -> String? {
        let digits = asciiDigits(raw).filter { !" \t-./()\u{00A0}\u{2009}\u{202F}".contains($0) }
        var text = digits
        if text.hasPrefix("00") { text = "+" + text.dropFirst(2) }
        guard text.first == "+" else { return nil }
        let body = text.dropFirst()
        guard (8...15).contains(body.count),
              body.allSatisfy({ $0.isASCII && $0.isNumber }),
              body.first != "0"
        else { return nil }
        return "+" + body
    }

    /// The verification code as typed (6 digits; Arabic-Indic digits accepted), else nil.
    static func code(_ raw: String) -> String? {
        let digits = asciiDigits(raw).filter { !$0.isWhitespace }
        guard digits.count == CallLimits.verificationCodeLength, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return digits
    }

    /// Arabic-Indic (٠–٩) and Eastern Arabic-Indic (۰–۹) digits as ASCII digits.
    static func asciiDigits(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars {
            switch scalar.value {
            case 0x0660...0x0669: scalars.append(Unicode.Scalar(UInt8(scalar.value - 0x0660 + 0x30)))
            case 0x06F0...0x06F9: scalars.append(Unicode.Scalar(UInt8(scalar.value - 0x06F0 + 0x30)))
            default: scalars.append(scalar)
            }
        }
        return String(scalars)
    }
}

/// `PATCH /v1/me { phoneNumber }` and verification by a call that reads out a code. The screen
/// shows only what the server saved.
@MainActor
@Observable
final class PhoneSettingsModel {
    var numberText = ""
    var code = ""
    private(set) var isSaving = false
    private(set) var errorMessage: String?
    private(set) var notice: String?
    private(set) var verification: PhoneVerification?
    private(set) var isVerifying = false
    private(set) var verificationError: String?

    func sync(from me: Me?) {
        numberText = me?.phoneNumber ?? ""
    }

    var normalized: String? { PhoneNumberInput.normalize(numberText) }

    /// Shown under the field while what was typed isn't a usable number.
    var inputProblem: String? {
        let typed = numberText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty, normalized == nil else { return nil }
        return String(localized: "Write the number with its country code, for example +49 30 1234567.")
    }

    func canSave(against me: Me?) -> Bool {
        guard let normalized, !isSaving else { return false }
        return normalized != me?.phoneNumber
    }

    /// Only the phone number is sent.
    nonisolated static func patch(_ number: String?) -> UpdateMeRequest {
        let change: NullablePatch<String> = number.map { NullablePatch<String>.set($0) } ?? .remove
        return UpdateMeRequest(phoneNumber: change)
    }

    func save(app: AppModel) async {
        guard let number = normalized, !isSaving else { return }
        await update(Self.patch(number), app: app) { me in
            me.phoneNumberVerifiedAt != nil
                ? String(localized: "Saved.")
                : String(localized: "Saved. Verify it so JARVIS can put callers through to you.")
        }
    }

    func remove(app: AppModel) async {
        guard !isSaving else { return }
        await update(Self.patch(nil), app: app) { _ in String(localized: "Removed. JARVIS can't put callers through to you any more.") }
        verification = nil
    }

    private func update(_ patch: UpdateMeRequest, app: AppModel, saved: (Me) -> String) async {
        isSaving = true
        errorMessage = nil
        notice = nil
        defer { isSaving = false }
        do {
            try await app.updateMe(patch)
            sync(from: app.me)
            if let me = app.me { notice = saved(me) }
        } catch is CancellationError {
            sync(from: app.me)
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    /// The verification still in progress (or that just failed) when the screen opens, so the
    /// code field comes back after leaving the screen. A failed read keeps the screen as it is.
    func resume(api: APIClient) async {
        guard verification == nil, !isVerifying else { return }
        if let current = try? await api.currentPhoneVerification(), verification == nil {
            verification = current
        }
    }

    /// Asks the server to call the account's number and read out a code.
    func startVerification(api: APIClient) async {
        guard !isVerifying else { return }
        isVerifying = true
        verificationError = nil
        notice = nil
        defer { isVerifying = false }
        do {
            verification = try await api.startPhoneVerification()
            code = ""
        } catch is CancellationError {
            return
        } catch {
            verificationError = ErrorText.message(for: error)
        }
    }

    var codeIsValid: Bool { PhoneNumberInput.code(code) != nil }

    func confirm(app: AppModel) async {
        guard let digits = PhoneNumberInput.code(code), !isVerifying else { return }
        isVerifying = true
        verificationError = nil
        defer { isVerifying = false }
        do {
            let me = try await app.api.confirmPhoneVerification(code: digits)
            app.replaceMe(me)
            sync(from: me)
            verification = nil
            code = ""
            notice = String(localized: "Your phone number is verified.")
        } catch is CancellationError {
            return
        } catch let error as ApiError {
            verificationError = ErrorText.message(for: error)
            // The server counts the tries; it says how many are left.
            if let left = error.details?["attemptsLeft"]?.numberValue, let current = verification {
                verification = PhoneVerification(
                    id: current.id,
                    status: current.status,
                    number: current.number,
                    attemptsLeft: max(0, Int(left)),
                    expiresAt: current.expiresAt,
                    createdAt: current.createdAt
                )
            }
        } catch {
            verificationError = ErrorText.message(for: error)
        }
    }

    /// `phone_verification.changed { verificationId, status }` (the call went through or not).
    func handle(_ event: StreamEvent) {
        guard event.type == .phoneVerificationChanged,
              let current = verification,
              event.data["verificationId"]?.stringValue == current.id,
              let raw = event.data["status"]?.stringValue,
              let status = PhoneVerificationStatus(rawValue: raw), status != .unknown
        else { return }
        verification = PhoneVerification(
            id: current.id,
            status: status,
            number: current.number,
            attemptsLeft: current.attemptsLeft,
            expiresAt: current.expiresAt,
            createdAt: current.createdAt
        )
    }
}

struct PhoneSettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var model = PhoneSettingsModel()
    @State private var confirmingRemove = false

    var body: some View {
        Form {
            numberSection
            verificationSection
        }
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Your phone number"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.sync(from: app.me)
            await model.resume(api: app.api)
        }
        .task {
            for await event in app.live.updates() {
                model.handle(event)
            }
        }
        .confirmationDialog(Text("Remove your phone number?"), isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove number", role: .destructive) {
                Task { await model.remove(app: app) }
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("JARVIS can then no longer put callers through to you, and numbers you write without a country code need one.")
        }
    }

    private var numberSection: some View {
        Section {
            TextField(text: $model.numberText, prompt: Text(verbatim: "+49 30 1234567")) {
                Text("Phone number")
            }
            .keyboardType(.phonePad)
            .textContentType(.telephoneNumber)
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityHint(Text("With the country code, for example +49 30 1234567"))
            if let problem = model.inputProblem {
                Text(problem)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.danger)
            }
            if let error = model.errorMessage {
                InlineErrorView(message: error)
                    .listRowInsets(EdgeInsets())
            }
            if let notice = model.notice {
                Text(notice)
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.success)
            }
            Button {
                Task { await model.save(app: app) }
            } label: {
                if model.isSaving {
                    ProgressView()
                } else {
                    Text("Save number")
                }
            }
            .disabled(!model.canSave(against: app.me))
            if app.me?.phoneNumber != nil {
                Button("Remove number", role: .destructive) {
                    confirmingRemove = true
                }
                .disabled(model.isSaving)
            }
        } header: {
            Text("Number")
        } footer: {
            Text("With the country code. JARVIS uses it only to put a caller through to you when you allow it for a call, and as the country of numbers you write without one. It's personal data: exported with your data and deleted with your account.")
        }
    }

    @ViewBuilder
    private var verificationSection: some View {
        if let me = app.me, me.phoneNumber != nil {
            Section {
                if let verifiedAt = me.phoneNumberVerifiedAt {
                    Label {
                        Text("Verified \(MeridianFormat.dateTime(verifiedAt))")
                    } icon: {
                        Image(systemName: "checkmark.seal")
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(MeridianColor.success)
                } else {
                    Label {
                        Text("Not verified")
                    } icon: {
                        Image(systemName: "seal")
                            .accessibilityHidden(true)
                    }
                    .foregroundStyle(MeridianColor.textSecondary)
                    VerificationFlow(model: model)
                }
            } header: {
                Text("Verification")
            } footer: {
                Text(me.phoneNumberVerifiedAt != nil
                     ? String(localized: "Callers can be put through to this number when you allow it for a call.")
                     : String(localized: "Verify it so JARVIS can put callers through to you. JARVIS calls the number and reads out a code."))
            }
        }
    }
}

/// Start the verification call, then enter the code it reads out.
private struct VerificationFlow: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: PhoneSettingsModel

    var body: some View {
        if let verification = model.verification, verification.status == .calling || verification.status == .pending {
            Text(verification.status == .calling
                 ? String(localized: "JARVIS is calling \(verification.number.bidiIsolated) and will read out a \(CallLimits.verificationCodeLength.formatted())-digit code.")
                 : String(localized: "Enter the code JARVIS read out on the call to \(verification.number.bidiIsolated)."))
                .meridianFont(.callout)
                .fixedSize(horizontal: false, vertical: true)
            TextField(text: $model.code, prompt: Text(verbatim: "123456")) {
                Text("Code from the call")
            }
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .environment(\.layoutDirection, .leftToRight)
            Text("Tries left: \(verification.attemptsLeft.formatted()) · valid until \(verification.expiresAt.formatted(date: .omitted, time: .shortened))")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
            Button {
                Task { await model.confirm(app: app) }
            } label: {
                if model.isVerifying {
                    ProgressView()
                } else {
                    Text("Confirm")
                }
            }
            .disabled(!model.codeIsValid || model.isVerifying)
        } else {
            if let verification = model.verification, verification.status == .failed || verification.status == .expired {
                Text(verification.status == .failed
                     ? String(localized: "The verification call didn't go through. You can try again.")
                     : String(localized: "This code has expired. Start a new verification call."))
                    .meridianFont(.callout)
                    .foregroundStyle(MeridianColor.warning)
            }
            Button {
                Task { await model.startVerification(api: app.api) }
            } label: {
                if model.isVerifying {
                    ProgressView()
                } else {
                    Label("Verify by phone call", systemImage: "phone.arrow.down.left")
                }
            }
            .disabled(model.isVerifying)
        }
        if let error = model.verificationError {
            InlineErrorView(message: error)
                .listRowInsets(EdgeInsets())
        }
    }
}

/// Numbers JARVIS won't call (masked). The callee's opt-out can be removed only deliberately.
@MainActor
@Observable
final class DoNotCallModel {
    private(set) var entries: [DoNotCallEntry] = []
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?
    private(set) var removingIds: Set<String> = []

    func load(api: APIClient) async {
        do {
            entries = try await api.doNotCallEntries()
            hasLoaded = true
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func remove(_ entry: DoNotCallEntry, api: APIClient) async {
        guard !removingIds.contains(entry.id) else { return }
        removingIds.insert(entry.id)
        defer { removingIds.remove(entry.id) }
        do {
            try await api.deleteDoNotCall(id: entry.id)
            entries.removeAll { $0.id == entry.id }
        } catch let error as ApiError where error.code == .notFound {
            entries.removeAll { $0.id == entry.id }
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }
}

struct DoNotCallView: View {
    @Environment(AppModel.self) private var app
    @State private var model = DoNotCallModel()
    @State private var removing: DoNotCallEntry?

    var body: some View {
        List {
            if let error = model.errorMessage {
                Section {
                    InlineErrorView(message: error) {
                        Task { await model.load(api: app.api) }
                    }
                    .listRowInsets(EdgeInsets())
                }
            }
            Section {
                if model.hasLoaded, model.entries.isEmpty {
                    Text("No numbers. If someone asks JARVIS not to call again, the number appears here.")
                        .meridianFont(.callout)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
                ForEach(model.entries) { entry in
                    DoNotCallRow(entry: entry, isRemoving: model.removingIds.contains(entry.id)) {
                        removing = entry
                    }
                }
            } footer: {
                Text("When someone asks JARVIS not to call again, their number goes on this list and every later call to it is refused. Only a masked form is kept.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(MeridianColor.canvas)
        .navigationTitle(Text("Numbers JARVIS won't call"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.load(api: app.api) }
        .task { await model.load(api: app.api) }
        .confirmationDialog(
            Text("Let JARVIS call \(removing?.number.bidiIsolated ?? "") again?"),
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { entry in
            Button("Remove from the list", role: .destructive) {
                Task { await model.remove(entry, api: app.api) }
            }
            Button("Keep it", role: .cancel) {}
        } message: { entry in
            Text(entry.source == .calleeRequest
                 ? String(localized: "The person asked not to be called again. Remove the number only if that was a misunderstanding — JARVIS can then call it again when you ask and approve.")
                 : String(localized: "JARVIS can then call it again when you ask and approve."))
        }
    }
}

private struct DoNotCallRow: View {
    let entry: DoNotCallEntry
    let isRemoving: Bool
    let remove: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: MeridianSpace.s3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: entry.number)
                    .meridianFont(.bodyStrong)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .environment(\.layoutDirection, .leftToRight)
                Text(verbatim: [PhoneText.country(entry.country), entry.source.label, MeridianFormat.dateTime(entry.createdAt)]
                    .compactMap { $0 }
                    .joined(separator: " · "))
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            Spacer(minLength: 0)
            Button(role: .destructive) {
                remove()
            } label: {
                if isRemoving {
                    ProgressView()
                } else {
                    Text("Remove")
                }
            }
            .buttonStyle(.borderless)
            .disabled(isRemoving)
            .accessibilityLabel(Text("Remove \(entry.number) from the list"))
        }
        .accessibilityElement(children: .contain)
    }
}
