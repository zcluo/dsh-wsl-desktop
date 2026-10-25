/**
 * Process-level helpers shared by the two halves of the WSL seam.
 *
 * `world.js` is split into "how a distribution is discovered" and "how a command
 * runs in it", but both halves decode `wsl.exe` output and validate distro names,
 * and the suites import the decoder from `world.js` directly. Putting those two
 * in either half would make the halves import each other; they live here instead,
 * and `world.js` re-exports the decoder so its public surface does not change.
 *
 * Extracted verbatim from `lib/wsl/world.js` (C3).
 * @module dsh-wsl-desktop/wsl/proc
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DISTRO_NAME } from './paths.js'

/** Promise-returning `execFile`, used by every discovery call. */
export const execFileAsync = promisify(execFile)

/**
 * Refuse option values that cannot be safe single argv tokens for wsl.exe
 * (-d/-u), independent of wsl.exe's external tokenization rules.
 * @param {string} distro - the distribution name about to be spawned with.
 */
export function assertDistroName(distro) {
  if (typeof distro !== 'string' || !DISTRO_NAME.test(distro)) {
    throw new Error(`wsl: 非法的发行版名 ${JSON.stringify(distro ?? null)}`)
  }
}

/**
 * Decode `wsl.exe` output.
 *
 * Every `wsl.exe` this plugin spawns is asked for UTF-8 (`WSL_UTF8`, see
 * {@link ENV_OVERRIDES}), so this is normally a plain UTF-8 decode — including the
 * diagnostics wsl.exe prints for its OWN failures, which are UTF-16LE without that
 * variable and were the whole reason this decoder used to guess between encodings.
 *
 * The fallback covers two things a WSL build that ignores the variable can send:
 * an explicit UTF-16LE BOM, and UTF-16LE whose code units are below U+0100 (their
 * high bytes are NUL — Latin-1 counts, not only ASCII).
 *
 * NUL-framed DATA is the awkward case, and a RATIO alone cannot settle it:
 * measured, `find . -print0` scores 0.500, the real Chinese diagnostic 0.636, and
 * `ls --zero` with single-character names reaches 1.000 — where the bytes ARE
 * `Buffer.from('abc', 'utf16le')`, byte for byte. Hence the layering above: a
 * partial interleave must also fail UTF-8 validity, which drops the framing
 * payloads (valid UTF-8) and keeps the diagnostic (invalid); an all-odd
 * interleave is honoured regardless, because that is the shape `listDistros`
 * depends on when a build ignores the switch.
 *
 * The irreducible residue is exactly that byte-identical pair: no test can
 * separate two readings of the same bytes. A consumer whose protocol frames with
 * NUL must therefore opt out with `raw` — `listLinuxDir` does, and `execInWsl`,
 * the only consumer of ARBITRARY command output, takes `raw` for the same reason.
 *
 * Three attempts at a smarter heuristic (interleave ratios, replacement-character
 * densities, UTF-8 validity) each traded one failure class for another: every
 * listing empty, then a >1 MiB CJK stream mojibake, then valid buffers flipped.
 * Guessing between encodings was the wrong shape; asking for UTF-8 removed the
 * need to guess, and this fallback covers the builds that predate the variable.
 * @param {Buffer} buffer - raw captured stream.
 * @returns {string} the decoded text.
 */
export function decodeWslOutput(buffer) {
  return looksUtf16le(buffer) ? buffer.toString('utf16le') : buffer.toString('utf8')
}

/**
 * Whether a buffer is UTF-16LE whose code units are mostly below U+0100 — the
 * fallback shape.
 *
 * The class counted is NOT "ASCII": the pick is `oddNuls * 2 >= pairs`, i.e. at
 * least half the CODE UNITS must have a NUL high byte, and EVERY code unit below
 * U+0100 encodes with one — Latin-1 included. Measured: a UTF-16LE buffer of
 * U+00E9 and U+00FF (e-acute, y-diaeresis) is counted exactly like ASCII and
 * decodes as UTF-16LE. For a pure-ASCII text the two readings coincide, which is
 * why this used to be described as an "ASCII share"; for a Latin-1 text they do
 * not, and the rate below is the binomial tail of the share of code units BELOW
 * U+0100 — 100% for a text entirely below it, about 60% at half, about 8% at 35%
 * (two independent generators measured 62.2%/52.8% and 8.0%/6.8% on those same
 * anchors, which is the point: quote the mechanism, not a rate). The real wsl.exe
 * diagnostics captured here happen to be majority-ASCII (0.636-0.662) and are
 * caught; a message that is mostly CJK is not, and no threshold fixes that
 * without also admitting NUL-framed data. That is why the switch is requested at
 * the source instead.
 *
 * The test is the INTERLEAVED NUL pattern, not "contains a NUL": a Linux-side
 * producer may emit NUL bytes as DATA (`printf 'a\\0b'`), and a bare NUL test
 * decoded that as UTF-16LE and silently dropped the byte after it. Three code
 * units minimum, or the pattern is a coincidence — `'a\\0b'` is one pair and
 * satisfies any ratio.
 *
 * This deliberately does NOT try to recognise UTF-16LE whose code units are
 * ABOVE U+00FF (there the high byte is not NUL, so nothing distinguishes it from
 * text) — with ONE exception, the explicit BOM below, which is a declaration
 * rather than a statistic. Everything else is handled at the SOURCE instead: every spawn asks
 * wsl.exe for UTF-8 (WSL_UTF8), so a Chinese-locale diagnostic arrives as UTF-8
 * rather than as UTF-16LE whose only distinguishing feature is a
 * replacement-character count. Three heuristics were written for that case and
 * each traded one failure class for another.
 * @param {Buffer} buffer - raw captured stream.
 * @returns {boolean} true when the buffer looks like ASCII-heavy UTF-16LE.
 */
export function looksUtf16le(buffer) {
  // An explicit BOM is a DECLARATION, not a guess: a file saved by a Windows
  // editor starts FF FE, and decoding it as UTF-8 is mojibake for certain. It is
  // checked BEFORE the parity guard on purpose, so a truncated BOM'd buffer
  // (FF FE 41) is still read as UTF-16LE and loses its trailing byte, rather than
  // being read as UTF-8 — the declaration wins over the shape.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true
  // A UTF-16LE stream is always an EVEN number of bytes, so an odd-length buffer
  // cannot be one — and `toString('utf16le')` would silently DROP the trailing byte
  // (measured: `printf 'a\\0b\\0c\\0d'` is 7 bytes and decoded to "abc").
  if (buffer.length % 2 !== 0) return false
  const pairs = Math.floor(buffer.length / 2)
  if (pairs < 3) return false
  let oddNuls = 0
  let evenNuls = 0
  for (let index = 0; index < pairs * 2; index += 2) {
    if (buffer[index] === 0) evenNuls += 1
    if (buffer[index + 1] === 0) oddNuls += 1
  }
  // The predicate is EXACTLY `oddNuls > evenNuls && oddNuls * 2 >= pairs`. An
  // earlier version of this comment called it "a majority of the odd positions and
  // nothing else", which was wrong twice: the first conjunct is real — a buffer
  // whose code units are mostly U+xx00 has as many even NULs as odd ones and is
  // rejected, e.g. Buffer.from([0,0,0,0,0,1,0,2,0x61,0,0x62,0]) — and where
  // evenNuls is 0 it fires at EXACTLY one half, not a majority.
  //
  // The populations OVERLAP, so this is a heuristic and not a proof — measured:
  //   real UTF-16LE diagnostics              0.636 - 0.662   -> fires, correctly
  //   real 'wsl.exe -l -q' UTF-16LE          1.000           -> fires (listDistros needs it)
  //   real 'find . -print0', long names      0.026 - 0.415   -> does not fire, correctly
  //   one-char entries './a\0./b\0./c\0'   0.500 EXACTLY   -> FIRES, WRONGLY
  //   'ls --zero', one-char names            1.000           -> fires; byte-identical
  //                                                             to UTF-16LE, inherent
  // (A real capture scored 0.529 on that one-char shape only because UTF-16LE text
  // was mixed into the stream; the pure listing is 0.5000 and still fires.)
  // That shape is the one that breaks: it puts a NUL on most odd byte positions, and
  // no threshold separates it from a diagnostic at 0.636 without dropping the
  // diagnostics that score below it. Three refinements
  // were tried and ALL were falsified, so none is kept:
  //   - a 0.75 threshold excluded the real diagnostics themselves;
  //   - "a partial interleave must also fail UTF-8 validity" excluded UTF-16LE whose
  //     bytes ARE valid UTF-8 (Buffer.from('abc不','utf16le')) while still admitting
  //     NUL-framed bytes that are not (printf 'a\\0b\\0c\\xff');
  //   - a 0.6 threshold fits exactly the sample above — which is the sample it was
  //     measured on, while a diagnostic that is mostly non-ASCII scores lower.
  // A ratio cannot prove an encoding. The OPT-OUTS can, and they are the answer:
  // listLinuxDir and execInWsl(raw:true) never reach this test at all.
  return oddNuls > evenNuls && oddNuls * 2 >= pairs
}

/**
 * The environment every `wsl.exe` child must be started with, wherever it is
 * spawned from.
 *
 * `WSL_UTF8` is load-bearing, not cosmetic: wsl.exe reads it from its OWN
 * environment to decide the encoding of its diagnostics. Without it a missing
 * distribution emits 258 bytes of UTF-16LE, which is what forced the decoder to
 * guess between encodings — and every guess traded one failure class for another.
 * With it the same message arrives as 223 bytes of UTF-8.
 *
 * It lives here, as one exported constant, because there are four spawn sites
 * (the probe path, the shell executor, the subprocess provider's spawn and its
 * terminal allocation) and a site that forgets it silently gets unreadable
 * messages again. Linux-side output is unaffected; only wsl.exe's own text changes.
 */
export const WSL_CHILD_ENV = { WSL_UTF8: '1' }

/**
 * Environment overrides that keep command output model-readable.
 *
 * ONE owner, shared with the shell executor (which spreads it into every
 * command it runs) — an override added to one copy and not the other used to be
 * a silent divergence two modules could not see. Frozen so a shared object stays
 * shared on purpose: an accidental write now throws instead of leaking into the
 * other consumer's environment.
 */
export const ENV_OVERRIDES = Object.freeze({ ...WSL_CHILD_ENV, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' })
