/**
 * Render one check's evidence for the console.
 *
 * Every suite reports evidence the same way, so the rule lives here instead of
 * as the same 120-character nested ternary in twelve files. The original
 * spelling was `String(detail)`, which printed `[object Object]` — that is how
 * a failing live run lost the very detail it was reporting.
 * @param {unknown} detail - the evidence value.
 * @returns {string} printable evidence.
 */
export function detailText(detail) {
  if (typeof detail === 'string') return detail
  if (detail instanceof Error) return detail.name + ': ' + detail.message
  try {
    return JSON.stringify(detail) ?? String(detail)
  } catch {
    // A circular or otherwise unserializable value must not crash the suite
    // that is already reporting a failure.
    return String(detail)
  }
}
