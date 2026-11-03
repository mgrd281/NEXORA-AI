/** jarvis-export-YYYY-MM-DD.json for the given day in local time (matches the API's name). */
export function exportFileName(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `jarvis-export-${y}-${m}-${d}.json`;
}
