import Observation
import QuickLook
import SwiftUI
import UIKit

/// Evidence files downloaded for viewing live in a per-file temporary folder, protected
/// while the device is locked, and are deleted when the preview closes.
enum EvidenceFiles {
    static func write(_ data: Data, id: String, mediaType: EvidenceMediaType) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("evidence", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safeId = id.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        let file = folder.appendingPathComponent("evidence-\(safeId.prefix(36)).\(mediaType.fileExtension)", isDirectory: false)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        return file
    }

    static func remove(_ file: URL) {
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
}

/// Screenshots already shown, so a refreshed screen doesn't download them again.
@MainActor
final class EvidenceImageCache {
    static let shared = EvidenceImageCache()
    private var images: [String: UIImage] = [:]
    private var order: [String] = []
    private let capacity = 24

    func image(_ id: String) -> UIImage? { images[id] }

    func store(_ image: UIImage, for id: String) {
        if images[id] == nil { order.append(id) }
        images[id] = image
        while order.count > capacity {
            images[order.removeFirst()] = nil
        }
    }

    func removeAll() {
        images.removeAll()
        order.removeAll()
    }
}

/// Downloads an evidence file with the signed-in session (only its owner can) and opens it
/// in Quick Look, which can also share it.
@MainActor
@Observable
final class EvidencePreviewModel {
    private(set) var loadingId: String?
    private(set) var errorMessage: String?
    var previewURL: URL?

    func open(_ id: String, api: APIClient) async {
        guard loadingId == nil else { return }
        loadingId = id
        errorMessage = nil
        defer { loadingId = nil }
        do {
            let file = try await api.downloadEvidence(id: id)
            previewURL = try EvidenceFiles.write(file.data, id: id, mediaType: file.mediaType)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = ErrorText.message(for: error)
        }
    }

    func closed(_ old: URL?) {
        if let old { EvidenceFiles.remove(old) }
    }
}

/// A button that opens one evidence file (e.g. the screenshot an approval relies on).
struct EvidenceFileButton: View {
    @Environment(AppModel.self) private var app
    @State private var model = EvidencePreviewModel()
    let artifactId: String
    let title: String
    var systemImage = "photo"

    var body: some View {
        VStack(alignment: .leading, spacing: MeridianSpace.s1) {
            Button {
                Task { await model.open(artifactId, api: app.api) }
            } label: {
                HStack(spacing: MeridianSpace.s2) {
                    Label(title, systemImage: systemImage)
                    Spacer(minLength: 0)
                    if model.loadingId != nil {
                        ProgressView()
                    }
                }
            }
            .buttonStyle(.meridianSecondary)
            .disabled(model.loadingId != nil)
            if let error = model.errorMessage {
                Text(error)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.danger)
            }
        }
        .quickLookPreview($model.previewURL)
        .onChange(of: model.previewURL) { old, new in
            if new == nil { model.closed(old) }
        }
    }
}

/// An evidence artifact: screenshots as a thumbnail (tap for full size), other files as a
/// row that opens in Quick Look.
struct EvidenceArtifactView: View {
    @Environment(AppModel.self) private var app
    @State private var preview = EvidencePreviewModel()
    @State private var thumbnail: UIImage?
    @State private var thumbnailFailed = false
    let artifact: EvidenceArtifact

    var body: some View {
        Button {
            Task { await preview.open(artifact.id, api: app.api) }
        } label: {
            VStack(alignment: .leading, spacing: MeridianSpace.s2) {
                if artifact.kind == .screenshot, artifact.mediaType == .png {
                    screenshot
                }
                HStack(spacing: MeridianSpace.s2) {
                    Image(systemName: artifact.kind.icon)
                        .foregroundStyle(MeridianColor.textSecondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(artifact.kind.label)
                            .meridianFont(.label)
                            .foregroundStyle(MeridianColor.textPrimary)
                        Text(verbatim: caption)
                            .meridianFont(.caption)
                            .foregroundStyle(MeridianColor.textSecondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    if preview.loadingId != nil {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .foregroundStyle(MeridianColor.accent)
                            .accessibilityHidden(true)
                    }
                }
            }
            .padding(MeridianSpace.s3)
            .frame(maxWidth: .infinity, minHeight: MeridianLayout.minTouchTarget, alignment: .leading)
            .background(MeridianColor.surfaceSunken, in: RoundedRectangle(cornerRadius: MeridianRadius.md, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(preview.loadingId != nil)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Opens the file JARVIS kept as evidence"))
        .quickLookPreview($preview.previewURL)
        .onChange(of: preview.previewURL) { old, new in
            if new == nil { preview.closed(old) }
        }
        .task(id: artifact.id) { await loadThumbnail() }
        .overlay(alignment: .bottomLeading) {
            if let error = preview.errorMessage {
                Text(error)
                    .meridianFont(.caption)
                    .foregroundStyle(MeridianColor.danger)
                    .padding(MeridianSpace.s1)
            }
        }
    }

    @ViewBuilder
    private var screenshot: some View {
        if let thumbnail {
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: 220, alignment: .top)
                .clipShape(RoundedRectangle(cornerRadius: MeridianRadius.sm, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: MeridianRadius.sm, style: .continuous)
                        .strokeBorder(MeridianColor.border, lineWidth: 1)
                }
                .accessibilityHidden(true)
        } else if !thumbnailFailed {
            RoundedRectangle(cornerRadius: MeridianRadius.sm, style: .continuous)
                .fill(MeridianColor.surface)
                .frame(height: 120)
                .overlay { ProgressView() }
                .accessibilityHidden(true)
        }
    }

    /// Where it was captured and when (the page address is the site's, shown as written).
    private var caption: String {
        let when = MeridianFormat.dateTime(artifact.createdAt)
        guard let page = artifact.pageUrl, let host = URLComponents(string: page)?.host, !host.isEmpty else {
            return when
        }
        return "\(host.bidiIsolated) · \(when)"
    }

    private func loadThumbnail() async {
        guard artifact.kind == .screenshot, artifact.mediaType == .png, thumbnail == nil else { return }
        if let cached = EvidenceImageCache.shared.image(artifact.id) {
            thumbnail = cached
            return
        }
        do {
            let file = try await app.api.downloadEvidence(id: artifact.id)
            guard file.mediaType == .png, let image = UIImage(data: file.data) else {
                thumbnailFailed = true
                return
            }
            let small = image.preparingThumbnail(of: CGSize(width: 720, height: 720 * image.size.height / max(image.size.width, 1))) ?? image
            EvidenceImageCache.shared.store(small, for: artifact.id)
            thumbnail = small
        } catch {
            thumbnailFailed = true
        }
    }
}

/// Opens an https link from the server (a provider's event page, a shop's cart, a site to
/// continue on). Plain http is accepted only for this device's loopback address (dev fixtures).
enum ExternalLink {
    static func url(_ raw: String?) -> URL? {
        guard let raw, let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil,
              let url = components.url
        else { return nil }
        if scheme == "https" { return url }
        if scheme == "http", ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) { return url }
        return nil
    }

    static func host(_ raw: String?) -> String? {
        guard let raw, let host = URLComponents(string: raw)?.host, !host.isEmpty else { return nil }
        return host
    }
}
