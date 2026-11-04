import QuickLook
import SwiftUI

/// Files picked for the next request: name, type and size, upload progress, and remove or
/// retry. File names are user content and are shown bidi-isolated.
struct AttachmentTray: View {
    @Environment(AppModel.self) private var app
    let draft: AttachmentDraft

    var body: some View {
        if !draft.isEmpty || draft.notice != nil {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                ForEach(draft.items) { item in
                    AttachmentDraftRow(
                        item: item,
                        onRemove: { draft.remove(item.id, api: app.api) },
                        onRetry: { draft.retry(item.id, api: app.api) }
                    )
                }
                if let notice = draft.notice {
                    Text(notice)
                        .meridianFont(.caption)
                        .foregroundStyle(MeridianColor.textSecondary)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Files to send"))
        }
    }
}

private struct AttachmentDraftRow: View {
    let item: AttachmentDraft.Item
    let onRemove: () -> Void
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: MeridianSpace.s3) {
            Image(systemName: item.mediaType.icon)
                .foregroundStyle(MeridianColor.textSecondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.filename.bidiIsolated)
                    .meridianFont(.label)
                    .foregroundStyle(MeridianColor.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                status
            }
            Spacer(minLength: MeridianSpace.s2)
            if case .failed = item.state, item.sizeBytes > 0 {
                Button(action: onRetry) {
                    Image(systemName: "arrow.clockwise")
                        .frame(minWidth: MeridianLayout.minTouchTarget, minHeight: MeridianLayout.minTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(MeridianColor.textPrimary)
                .accessibilityLabel(Text("Try \(item.filename.bidiIsolated) again"))
            }
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .frame(minWidth: MeridianLayout.minTouchTarget, minHeight: MeridianLayout.minTouchTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(MeridianColor.textSecondary)
            .accessibilityLabel(Text("Remove \(item.filename.bidiIsolated)"))
        }
        .padding(.leading, MeridianSpace.s3)
        .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
    }

    @ViewBuilder
    private var status: some View {
        switch item.state {
        case .uploading(let fraction):
            ProgressView(value: fraction) {
                Text("Uploading, \(fraction.formatted(.percent.precision(.fractionLength(0))))")
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.textSecondary)
            }
            .tint(MeridianColor.accent)
        case .ready:
            Text(verbatim: "\(item.mediaType.label) · \(ByteCountFormatter.string(fromByteCount: item.sizeBytes, countStyle: .file))")
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.textSecondary)
        case .failed(let message):
            Text(message)
                .meridianFont(.caption)
                .foregroundStyle(MeridianColor.danger)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The paper-clip button that opens the document picker. Disabled when the request already
/// has the maximum number of files or uploads are known to be unavailable on this server.
struct AttachButton: View {
    @Environment(AppModel.self) private var app
    let draft: AttachmentDraft
    var size: CGFloat = 36
    @State private var picking = false

    var body: some View {
        Button {
            picking = true
        } label: {
            Image(systemName: MeridianIcon.attachment)
                .font(.system(size: size * 0.45, weight: .semibold))
                .frame(width: size, height: size)
                .foregroundStyle(MeridianColor.textPrimary)
                .background(MeridianColor.surfaceSunken, in: Circle())
                .frame(minWidth: MeridianLayout.minTouchTarget, minHeight: MeridianLayout.minTouchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(draft.remainingSlots == 0 || app.attachmentsUnavailable)
        .accessibilityLabel(Text("Attach files"))
        .accessibilityHint(app.attachmentsUnavailable
            ? Text("File uploads aren't available on this server.")
            : Text("PDF, Word (.docx), text, Markdown or CSV, up to \(AttachmentPolicy.maxSizeText) each"))
        .fileImporter(
            isPresented: $picking,
            allowedContentTypes: PickedFile.contentTypes,
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result, !urls.isEmpty {
                Task { await draft.add(urls, api: app.api) }
            }
        }
    }
}

/// Files attached to a request (task detail, conversation). Tapping one downloads it with the
/// signed-in session (only its owner can) and opens it in Quick Look, which can also share it.
struct AttachedFilesView: View {
    @Environment(AppModel.self) private var app
    let attachments: [Attachment]
    @State private var downloadingId: String?
    @State private var errorMessage: String?
    @State private var previewURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s2) {
            ForEach(attachments) { attachment in
                Button {
                    open(attachment)
                } label: {
                    HStack(spacing: MeridianSpace.s3) {
                        Image(systemName: attachment.mediaType.icon)
                            .foregroundStyle(MeridianColor.textSecondary)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: attachment.filename.bidiIsolated)
                                .meridianFont(.label)
                                .foregroundStyle(MeridianColor.textPrimary)
                                .lineLimit(2)
                                .truncationMode(.middle)
                            Text(verbatim: detail(attachment))
                                .meridianFont(.caption)
                                .foregroundStyle(MeridianColor.textSecondary)
                        }
                        Spacer(minLength: MeridianSpace.s2)
                        if downloadingId == attachment.id {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.down.circle")
                                .foregroundStyle(MeridianColor.accent)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(MeridianSpace.s3)
                    .frame(minHeight: MeridianLayout.minTouchTarget)
                    .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(downloadingId != nil)
                .accessibilityLabel(Text("Download \(attachment.filename.bidiIsolated)"))
            }
            if let errorMessage {
                Text(errorMessage)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.danger)
            }
        }
        .quickLookPreview($previewURL)
        .onChange(of: previewURL) { old, new in
            if new == nil, let old { AttachmentFiles.removeDownloaded(old) }
        }
    }

    private func detail(_ attachment: Attachment) -> String {
        var parts = [
            attachment.mediaType.label,
            ByteCountFormatter.string(fromByteCount: attachment.sizeBytes, countStyle: .file),
        ]
        if let pages = attachment.pageCount, attachment.mediaType == .pdf {
            parts.append(String(localized: "Pages: \(pages.formatted())"))
        }
        return parts.joined(separator: " · ")
    }

    private func open(_ attachment: Attachment) {
        guard downloadingId == nil else { return }
        downloadingId = attachment.id
        errorMessage = nil
        Task {
            defer { downloadingId = nil }
            do {
                let data = try await app.api.downloadAttachment(id: attachment.id)
                previewURL = try AttachmentFiles.writeDownloaded(data, attachment: attachment)
            } catch is CancellationError {
                return
            } catch {
                errorMessage = ErrorText.message(for: error)
            }
        }
    }
}

/// Downloaded files live in a per-file temporary folder, protected while the device is
/// locked, and are deleted when the preview closes.
enum AttachmentFiles {
    static func writeDownloaded(_ data: Data, attachment: Attachment) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachments", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var name = AttachmentPolicy.displayFilename(attachment.filename)
            .replacingOccurrences(of: ":", with: "_")
        if name.hasPrefix(".") { name = "_" + name }
        let file = folder.appendingPathComponent(name, isDirectory: false)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        return file
    }

    static func removeDownloaded(_ file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
}
