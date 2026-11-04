import Foundation
import Observation
import UniformTypeIdentifiers

/// A file read from the document picker, checked and ready to upload.
struct PickedFile: Sendable, Equatable {
    let name: String
    let data: Data
    let mediaType: AttachmentMediaType

    /// The types the document picker offers (PDF, Word, text, Markdown, CSV).
    static let contentTypes: [UTType] = {
        var types: [UTType] = [.pdf, .plainText, .commaSeparatedText]
        for identifier in ["org.openxmlformats.wordprocessingml.document", "net.daringfireball.markdown"] {
            if let type = UTType(identifier), !types.contains(type) { types.append(type) }
        }
        if let markdown = UTType(filenameExtension: "md"), !types.contains(markdown) { types.append(markdown) }
        return types
    }()

    /// Reads a picked file (security-scoped) and applies the client-side checks. The size is
    /// checked before reading, so an oversized file is never loaded into memory.
    static func load(from url: URL) async -> Result<PickedFile, AttachmentPolicy.Problem> {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let name = AttachmentPolicy.displayFilename(url.lastPathComponent)
        guard AttachmentPolicy.mediaType(forFilename: name) != nil else { return .failure(.unsupportedType) }
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           Int64(size) > AttachmentPolicy.maxBytes {
            return .failure(.tooLarge)
        }
        // Read fully (not memory-mapped): access to the security-scoped file ends on return.
        guard let data = try? Data(contentsOf: url) else {
            return .failure(.unreadable)
        }
        switch AttachmentPolicy.check(filename: name, data: data) {
        case .success(let type): return .success(PickedFile(name: name, data: data, mediaType: type))
        case .failure(let problem): return .failure(problem)
        }
    }
}

extension AttachmentPolicy.Problem {
    var message: String {
        switch self {
        case .empty:
            String(localized: "error.api.FILE_EMPTY", defaultValue: "The file is empty.")
        case .tooLarge:
            String(localized: "error.api.FILE_TOO_LARGE", defaultValue: "Files can be at most \(AttachmentPolicy.maxSizeText.bidiIsolated).")
        case .unsupportedType:
            String(localized: "error.api.UNSUPPORTED_FILE_TYPE", defaultValue: "JARVIS reads PDF, Word (.docx), text, Markdown and CSV files.")
        case .contentMismatch:
            String(localized: "error.api.FILE_CONTENT_MISMATCH", defaultValue: "The file's content doesn't match its file type.")
        case .unreadable:
            String(localized: "This file couldn't be opened on your iPhone.")
        }
    }
}

/// Files being attached to the next request: each is checked, uploaded with progress, and
/// becomes an attachment id the request names. Removing an uploaded file deletes it on the
/// server (unsent uploads would otherwise expire there after 24 hours).
@MainActor
@Observable
final class AttachmentDraft {
    struct Item: Identifiable, Equatable {
        enum State: Equatable {
            case uploading(Double)
            case ready(Attachment)
            case failed(String)
        }

        let id: UUID
        let filename: String
        let sizeBytes: Int64
        let mediaType: AttachmentMediaType
        var state: State
    }

    private(set) var items: [Item] = []
    /// A note about the last pick (for example the per-request limit), cleared on the next pick.
    private(set) var notice: String?

    @ObservationIgnored private var uploads: [UUID: Task<Void, Never>] = [:]
    /// Kept only until the upload succeeds, so a failed one can be retried.
    @ObservationIgnored private var pending: [UUID: PickedFile] = [:]

    var isEmpty: Bool { items.isEmpty }
    var readyIds: [String] {
        items.compactMap { item in
            if case .ready(let attachment) = item.state { return attachment.id }
            return nil
        }
    }

    var isUploading: Bool {
        items.contains { item in
            if case .uploading = item.state { return true }
            return false
        }
    }

    var hasFailures: Bool {
        items.contains { item in
            if case .failed = item.state { return true }
            return false
        }
    }

    var remainingSlots: Int { max(0, AttachmentPolicy.maxPerRequest - items.count) }

    /// Why the request can't be sent yet because of its files, or nil.
    var blockingReason: String? {
        if isUploading { return String(localized: "Wait until the files have finished uploading.") }
        if hasFailures { return String(localized: "Remove the files that couldn't be attached, then send.") }
        return nil
    }

    func add(_ urls: [URL], api: APIClient) async {
        notice = nil
        var accepted = urls
        if accepted.count > remainingSlots {
            accepted = Array(accepted.prefix(remainingSlots))
            notice = String(localized: "error.api.TOO_MANY_ATTACHMENTS", defaultValue: "You can attach up to \(AttachmentPolicy.maxPerRequest.formatted().bidiIsolated) files to one request.")
        }
        for url in accepted {
            let id = UUID()
            let result = await PickedFile.load(from: url)
            switch result {
            case .success(let file):
                items.append(Item(
                    id: id,
                    filename: file.name,
                    sizeBytes: Int64(file.data.count),
                    mediaType: file.mediaType,
                    state: .uploading(0)
                ))
                pending[id] = file
                startUpload(id, file: file, api: api)
            case .failure(let problem):
                items.append(Item(
                    id: id,
                    filename: AttachmentPolicy.displayFilename(url.lastPathComponent),
                    sizeBytes: 0,
                    mediaType: AttachmentPolicy.mediaType(forFilename: url.lastPathComponent) ?? .unknown,
                    state: .failed(problem.message)
                ))
            }
        }
    }

    func retry(_ id: UUID, api: APIClient) {
        guard let file = pending[id], let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = .uploading(0)
        startUpload(id, file: file, api: api)
    }

    /// Removes a file from the request; an uploaded one is deleted on the server (best effort).
    func remove(_ id: UUID, api: APIClient) {
        uploads[id]?.cancel()
        uploads[id] = nil
        pending[id] = nil
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        let item = items.remove(at: index)
        if case .ready(let attachment) = item.state {
            Task { try? await api.deleteAttachment(id: attachment.id) }
        }
    }

    /// After the request was sent: the files now belong to its conversation.
    func clearAfterSend() {
        for task in uploads.values { task.cancel() }
        uploads.removeAll()
        pending.removeAll()
        items.removeAll()
        notice = nil
    }

    /// Discards the draft (for example when its screen closes without sending).
    func discard(api: APIClient) {
        for item in items { remove(item.id, api: api) }
        notice = nil
    }

    private func startUpload(_ id: UUID, file: PickedFile, api: APIClient) {
        uploads[id]?.cancel()
        let progress: @Sendable (Double) -> Void = { [weak self] fraction in
            Task { @MainActor in self?.setProgress(id, fraction) }
        }
        uploads[id] = Task { [weak self] in
            do {
                let attachment = try await api.uploadAttachment(
                    filename: file.name,
                    mediaType: file.mediaType,
                    data: file.data,
                    onProgress: progress
                )
                self?.finish(id, attachment: attachment, api: api)
            } catch is CancellationError {
                return
            } catch {
                self?.fail(id, message: ErrorText.message(for: error))
            }
        }
    }

    private func setProgress(_ id: UUID, _ fraction: Double) {
        guard let index = items.firstIndex(where: { $0.id == id }),
              case .uploading = items[index].state
        else { return }
        items[index].state = .uploading(fraction)
    }

    private func finish(_ id: UUID, attachment: Attachment, api: APIClient) {
        uploads[id] = nil
        guard let index = items.firstIndex(where: { $0.id == id }) else {
            // Removed while uploading: don't leave the upload behind on the server.
            Task { try? await api.deleteAttachment(id: attachment.id) }
            return
        }
        pending[id] = nil
        items[index].state = .ready(attachment)
    }

    private func fail(_ id: UUID, message: String) {
        uploads[id] = nil
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].state = .failed(message)
    }
}
