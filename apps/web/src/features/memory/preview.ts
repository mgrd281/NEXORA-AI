/**
 * The first words of a memory, for naming its Edit/Delete buttons ("Delete memory: Prefers
 * aisle seats on…"). Whole words up to `max` characters, then an ellipsis.
 */
export function memoryPreview(content: string, max = 40): string {
  const text = content.replace(/\s+/gu, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** True when the memory was changed after it was created (beyond clock noise). */
export function wasEdited(createdAt: string, updatedAt: string): boolean {
  return new Date(updatedAt).getTime() - new Date(createdAt).getTime() > 1000;
}
