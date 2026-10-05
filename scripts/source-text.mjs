/**
 * Source text with comments and string bodies blanked, for structural checks.
 *
 * A structural pin reads code as TEXT, so a doc comment that names the call it is
 * looking for satisfies a naive search. Blanking the comment and string bodies
 * first is what makes such a pin assert a SHAPE rather than a spelling.
 * @module dsh-wsl-desktop/scripts/source-text
 */

/**
 * Source with comment bodies and string bodies blanked, for structural checks.
 *
 * ONE pass, because the obvious pass-per-syntax spelling is wrong in either
 * order. Stripping `//` first reads the `//` inside a URL literal as a line
 * comment — it swallowed the rest of that line together with the closing quote,
 * left an unmatched quote behind, and the following quote pass then ate the
 * code after it, turning seven assertions into false failures. Stripping quotes
 * first instead reads an apostrophe in a comment as an opening quote. A scanner
 * that walks the source once cannot do either. Regex literals are not parsed:
 * a quote inside one would still be read as a string.
 * @param {string} text - the source text.
 * @returns {string} the same text with comment and string bodies removed.
 */
export function blankLiterals(text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      out += ' '
      continue
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
      out += ' '
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index] === char) { index += 1; break }
        index += 1
      }
      out += char === '`' ? '``' : "''"
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Whether a declaration's branch citation still resolves in the file it cites.
 *
 * Two arms, because a citation legitimately lives in either place: the BLANKED arm
 * compares code against code, blanking both sides so a citation that carries a
 * string literal still matches (a citation of a command the suite runs lives inside
 * a literal, and blanking the file removes that body), and the RAW arm covers
 * exactly that case. The raw arm can also be satisfied by prose, which is the
 * honest limit of a text citation: it proves the entry points at text the file
 * carries, not that the text sits on the skip path.
 *
 * ONE owner, because the declaration auditors in two suites were carrying
 * byte-identical copies that had to be kept in sync by hand.
 * @param {string} source - the cited file's source, raw.
 * @param {string} citation - the cited text.
 * @returns {boolean} whether it resolves.
 */
export function citationResolves(source, citation) {
  return blankLiterals(source).includes(blankLiterals(citation)) || source.includes(citation)
}
