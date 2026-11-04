import Foundation

// Mirrors `Attachment` and `ATTACHMENT_LIMITS` / `ATTACHMENT_EXTENSIONS` in packages/contracts.

/// A file the user uploaded. Only its owner can read or download it.
struct Attachment: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    /// As uploaded (sanitised by the server). User content: display it bidi-isolated.
    let filename: String
    /// Identified by the server from the content, not the extension.
    let mediaType: AttachmentMediaType
    let sizeBytes: Int64
    /// Hex SHA-256 of the stored bytes.
    let sha256: String
    /// Nil until a request uses the file.
    let conversationId: String?
    /// Known once JARVIS has read the document.
    let pageCount: Int?
    let textChars: Int?
    /// API path that streams the file to its owner. The app builds the path from `id`.
    let downloadPath: String
    /// When an unattached upload is deleted; nil once attached.
    let expiresAt: Date?
    let createdAt: Date
}

/// Client-side checks before an upload. The server is authoritative (it sniffs the content
/// again and enforces every limit); these give an immediate, specific answer instead of a
/// wasted upload.
enum AttachmentPolicy {
    /// `ATTACHMENT_LIMITS.maxBytes` (10 MiB).
    static let maxBytes: Int64 = 10 * 1024 * 1024
    /// `ATTACHMENT_LIMITS.maxPerRequest`.
    static let maxPerRequest = 5
    /// `ATTACHMENT_LIMITS.maxFilenameChars`.
    static let maxFilenameChars = 255
    /// The multipart field that carries the file (`ATTACHMENT_UPLOAD_FIELD`).
    static let uploadField = "file"

    /// The size limit for display ("10 MB"), binary units as the server counts them.
    static var maxSizeText: String {
        ByteCountFormatter.string(fromByteCount: maxBytes, countStyle: .memory)
    }

    enum Problem: Error, Equatable, Sendable {
        case empty
        case tooLarge
        case unsupportedType
        case contentMismatch
        case unreadable
    }

    /// The media type a file name's extension stands for, or nil when JARVIS doesn't take it.
    static func mediaType(forFilename filename: String) -> AttachmentMediaType? {
        let lower = filename.lowercased()
        return AttachmentMediaType.uploadable.first { type in
            type.extensions.contains { lower.hasSuffix($0) }
        }
    }

    /// Checks size, extension and content (the same rules the server applies, simplified).
    static func check(filename: String, data: Data) -> Result<AttachmentMediaType, Problem> {
        guard let type = mediaType(forFilename: filename) else { return .failure(.unsupportedType) }
        if data.isEmpty { return .failure(.empty) }
        if Int64(data.count) > maxBytes { return .failure(.tooLarge) }
        return contentMatches(data, type: type) ? .success(type) : .failure(.contentMismatch)
    }

    /// Content sniffing: PDF magic within the first 1 KiB; DOCX is a ZIP that names
    /// word/document.xml; text types are valid UTF-8 without NUL and almost no control characters.
    static func contentMatches(_ data: Data, type: AttachmentMediaType) -> Bool {
        switch type {
        case .pdf:
            return data.prefix(1024).range(of: Data("%PDF-".utf8)) != nil
        case .docx:
            let zipHeader = Data([0x50, 0x4B, 0x03, 0x04])
            return data.prefix(4) == zipHeader && data.range(of: Data("word/document.xml".utf8)) != nil
        case .plainText, .markdown, .csv:
            return isPlainText(data)
        case .unknown:
            return false
        }
    }

    static func isPlainText(_ data: Data) -> Bool {
        var bytes = data
        let bom = Data([0xEF, 0xBB, 0xBF])
        if bytes.starts(with: bom) { bytes = bytes.dropFirst(3) }
        guard !bytes.isEmpty, String(data: bytes, encoding: .utf8) != nil else { return false }
        var controls = 0
        for byte in bytes {
            if byte == 0 { return false }
            if byte < 0x20, byte != 0x09, byte != 0x0A, byte != 0x0D { controls += 1 }
        }
        // At most 0.5 % control characters, as the server allows.
        return controls * 200 <= bytes.count
    }

    /// The basename of a picked file without control and bidi-override characters
    /// (U+202A–202E, U+2066–2069), as the server sanitises it.
    static func displayFilename(_ raw: String) -> String {
        let base = raw.split(separator: "/").last.map(String.init) ?? raw
        var scalars = String.UnicodeScalarView()
        for scalar in base.unicodeScalars {
            let value = scalar.value
            let isControl = value < 0x20 || (0x7F...0x9F).contains(value)
            let isBidiOverride = (0x202A...0x202E).contains(value) || (0x2066...0x2069).contains(value)
            if !isControl, !isBidiOverride { scalars.append(scalar) }
        }
        let trimmed = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "document" : trimmed
    }

    /// A multipart/form-data body with the single file part the upload route expects.
    /// The file name is sent as raw UTF-8 (as browsers do); quotes and line breaks are
    /// percent-escaped so they cannot break out of the header.
    static func multipartBody(boundary: String, filename: String, mediaType: AttachmentMediaType, data: Data) -> Data {
        let escaped = filename
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
            .replacingOccurrences(of: "\"", with: "%22")
        let contentType = mediaType == .unknown ? "application/octet-stream" : mediaType.rawValue
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"\(uploadField)\"; filename=\"\(escaped)\"\r\n".utf8))
        body.append(Data("Content-Type: \(contentType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }
}
