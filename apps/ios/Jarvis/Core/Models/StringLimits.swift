import Foundation

/// The contracts limit string lengths with Zod, which counts UTF-16 code units
/// (JavaScript `length`), not grapheme clusters like `String.count`.
extension String {
    /// Length as the server's validation measures it.
    var contractLength: Int { utf16.count }

    /// The longest prefix of whole characters that fits in `limit` UTF-16 code units.
    func prefix(contractLength limit: Int) -> String {
        var result = ""
        var used = 0
        for character in self {
            let size = character.utf16.count
            if used + size > limit { break }
            result.append(character)
            used += size
        }
        return result
    }
}
