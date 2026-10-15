# Search inside the distribution: grep and glob (WSL workspaces) — dsh-wsl-desktop

This is the full record of search in a WSL workspace: why the host's two names have to be replaced, the two tools and their parameters, the eight semantic differences from the host, the two further boundaries beyond those eight, the limits, what was not measured and which limitations are known, and how to verify it yourself. The README keeps only the conclusion and the entry point.

## Why the host's search tools have to be replaced

Both host names (`tool-fs-search`'s `grep` and `glob`) are **deliberately removed** inside a WSL world, for two measured facts: it is launched via `ctx.subprocess.spawn()` (`search-core.ts:238`), and its `argv[0]` is the **packaged Windows rg.exe** from `@vscode/ripgrep` (`search-core.ts:174-178`) — a Windows executable that **does not exist inside the distribution** and cannot work with Linux arguments; in the other direction, the distribution ships its own `/usr/bin/grep` and `/usr/bin/find` (measured here: `command -v rg` inside the distribution **answers nothing**, while grep 3.11 and findutils 4.10.0 are present). **Both facts together** are the whole reason for this line: that host row has no working backend, and the backend it needs was in the distribution all along.

`wsl-world` therefore removes those two host rows (`WORLD_MODULE_NAMES` in `lib/wsl/preset.js`), and this plugin mounts **the two names** back, the way `bash` and `fs` are re-mounted: two rows, one instance each, both naming `lib/wsl/search-tool.js`, with `config.tool` saying which of the two that instance registers (two rows naming one module would otherwise register the same tool twice; a row without `config.tool` is refused at mount time rather than mounting nothing in silence).

Both tools run the **distribution's own** `/usr/bin/grep -E` and `/usr/bin/find`, and there is **no shell** on that path: pattern, path and include all arrive as **exactly one argv element**, so `a b; rm -rf /` is one argument (shell syntax is inert here); sorting and the caps happen in Node — a realm has no `sort` to pipe into.

So the README's entry is no longer a regression but a **declared, bounded capability**: the names are the host's, the semantics are not — the eight items below are the whole difference.

## The two tools and their parameters

`grep`: `pattern` (required, POSIX ERE — gap 1) · `path` (defaults to the session workspace; a relative path resolves against it) · `include` (one glob, matched against each file's **base name** — gaps 5 and 6). Results are grouped by file, each match carrying `path`, `lineNumber` and `line` (the text prints the path plus `Line N: text`); an empty result prints `No matches found`.

`glob`: `pattern` (required, a glob) · `path` (defaults to the session workspace). The value is `{root, paths}`, where `paths` are **files** (never directories), absolute, ordered by mtime **ascending (oldest first)** — the host's measured direction (`--sort=modified`), not the more natural-looking descending one; an empty result prints `No files found`.

Both names are registered **unconditionally** (following the host's own choice): when the distribution really lacks `grep`/`find`, the call fails with an explicit error rather than silently degrading or quietly switching to the host's tools.

The two shipped vectors (pinned byte-for-byte by the two golden vectors in `scripts/verify-search.mjs`):

```text
/usr/bin/grep -r -n -H -E --binary-files=without-match --exclude-dir=.git … --exclude-dir=.sl [--include=<include>] --regexp <pattern> -- <root>
/usr/bin/find -- <root> -name .git -prune -o … -name .sl -prune -o -path <root>/<tail> -type f -printf '%T@ %p\0'
```

The search root is the **resolved Linux absolute path** (the realm's own `fs` service resolves the model's path — see the paragraph after the eight gaps); that is also why a path beginning with `-` never reaches the vector.

## Semantics and the eight gaps

The tool descriptions (the ones the model reads before calling) are the **authoritative wording** for the same facts; this section gives the full version and its measured basis.

1. **The pattern dialect is POSIX ERE, not ripgrep's**: `\d` and `(?i)` are unavailable (write `[0-9]`, or spell out both cases). A pattern that matches nothing is not an error; it returns an empty result.
2. **`.gitignore` is not parsed**: only the six VCS directories are excluded (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl` — the list is the host's, item for item and in its order, `tool-fs-search/src/glob.ts:37`) — grep through `--exclude-dir=<name>`, find through `-name <name> -prune` (each tool really excludes them with its own mechanism: drop that and the grep vector returns files under `.git` — measured). There is no `.ignore` and no global ignore, so a directory like `node_modules` or a build output is **not silently skipped** — narrow `path` or use `include` to be quiet.
3. **Patterns are interpreted relative to the search root, and `*` and `**/` cross `/` alike**: `src/*.ts` also matches files deeper down; a pattern with no `/` matches at any depth; a leading `/` means the same as none (that is rg's anchored form, and it is not an anchor here). This one is **measured** (findutils 4.10.0: `-path` matches the whole printed path and its `*` crosses `/`), and it is why the translation collapses `**/` to `*` and strips every leading `/`: any one left behind builds a `//`-prefixed `-path` pattern, and **such a pattern matches nothing at all** (one fixture: 2 records for the single-slash form, 0 for the doubled one).
4. **Dotted directories ARE searched**: the host relies on ripgrep skipping **every** hidden entry by default, while the realm excludes only those six VCS names → a directory like `.github` or `.vscode` is **in the results**. A disclosed difference, not a defect.
5. **`include` has no brace expansion**: `*.{ts,tsx}` matches nothing (GNU grep's `--include` goes through fnmatch, which does not expand braces) — write it twice, or narrow with `path`.
6. **`include` matches the base name only**: an include carrying a directory (`src/*.ts`, `*/deep/*.ts`) **returns 0 records** — the opposite of the host (which hands include to ripgrep). Narrow by directory with `path` instead.
7. **A `:` in a path may drop a record or silently mis-attribute it**: grep prints `path:line:text` with **no escaping at all**, so the field boundaries are gone the moment it prints (the host reads ripgrep's JSON; the realm has only this print). When the line-number field does not read as an integer the record is **skipped**: `NaN` is not lossless JSON, the host's value snapshot rejects it (`packages/util/values/src/index.ts:128-129`), and the whole call fails with a `ToolOutputError` that takes every other match in the batch with it while never mentioning a colon — a dropped record is a **recoverable false negative**, so skipping is the chosen failure (a **finite but non-integer** line number like `9.30` is skipped too: `tool-fs-search/src/grep.ts:307` declares that field an integer). But a value that reads as a **finite integer** is invisible to every guard: `/ws/2024:12:00.log:7:needle` mis-reads as line 12 of `/ws/2024` (measured), and `''` and `' 7'` read as 0 and 7 just as silently. **Use `read` for a colon-bearing path** — only the print format could settle this, and the format is the tool's own and cannot be changed.
8. **Binary files are never matched**: the vector carries `--binary-files=without-match`, whose documented meaning is "assume binary files do not match" → binary content **never enters `line`** (safer than the host); the price is that the host's rg **reports a match** for a binary file while the realm reports "no matches".

> **Mechanism note (measured here, GNU grep 3.11, each stream redirected to a file)**: a binary match with the flag → exit 1, stdout 0 bytes, stderr 0 bytes; without it → exit 0, stdout 0 bytes, **stderr 82 bytes** (the `binary file matches` notice). That notice goes to **stderr**, and the tool does not surface stderr on success → removing the flag would not make it fail loudly, it would only give "binary match" one more reason to look exactly like "no matches"; the flag's real value is the documented meaning in the sentence above.

**Beyond the eight, two boundaries belong here too:**

- **Paths are returned exactly as the tool printed them (absolute)**, whereas the host returns workdir-relative ones; `glob`'s `root` is the **resolved Linux absolute path** as well — it agrees with `paths`, and it is **not the caller's spelling** (the host fills the relative path or `.`).
- **`grep`'s exit 2 is classed as an invalid pattern** (`SEARCH_INVALID_PATTERN`), but that code is not only about the pattern: **a missing or unreadable target also exits 2**. The class name is not the conclusion — **the message carries the verbatim stderr**, and the real cause is there (telling them apart would mean parsing stderr's content, the fragile approach this repository avoids). The class is grep's **alone**: find has no such exit, so a 2 from glob is an ordinary `SEARCH_FAILED`. A launch that never happened (a distribution without the tool, a kill, a timeout) and "it printed but nothing could be read as records" are `SEARCH_FAILED` too.

## Limits

| Limit | Value | What happens at the limit |
|---|---|---|
| `grep` matches | 250 | the header says `Found 250 of N matches`; **the rest is not saved to disk** |
| `grep` bytes per line | 2000 | that line is cut and marked `" (line truncated)"` (the host's own marker); the record itself survives |
| `glob` paths | 100 | the footer says `Showing 100 of N paths, oldest first`; **the rest is not saved to disk** |

All three are module constants that **mirror the host's defaults** in `@deepseek-ai/dsh-tool-fs-search`, field for field. A capped result **says it was capped**, and says the complete result was not saved — the host points at the file it saved; this world **spills nothing to disk**, so the honest footer is that sentence rather than a pointer at a file that does not exist. Two more budgets: 20,000,000 bytes of stdout (a print that exceeds it **fails loudly**, because a partially parsed short answer reads exactly like a complete one — the one outcome a search must never report quietly) and a 30-second timeout (3-second grace).

**Cap settings an operator made for the host's search tools do not reach the realm**: that configuration is removed together with the two rows (`prune()` collects it into `toolConfig`, and nobody consumes it), so the realm uses the **host's defaults** above, not that configuration.

## Not measured and known limitations

- **`lib/wsl/search-tool.js`'s runtime behaviour has no offline pin**: it imports harness packages (`defineTool`/`HarnessError`), and this checkout has no `node_modules` — no offline suite can drive it through the registry. Its only observer is the **live pair** (see the next section). That is structure rather than an omission, and the visibility boundary is **measured**: write the record name in the plural, or put the probe token on the wrong line, and `node --check`, the import check under the deployment's resolution tree and `verify-modules` are all **green**.
- **Measured on `debian` only**: this machine also has `debian-dev` and `arch`, which share the same WSL2 kernel and 9P stack, but they were not re-measured one by one.
- **The 9P share can briefly serve a stale view (one-way, measured)**: a file written through `\\wsl.localhost\<distro>` after a host restart may be **invisible** to `wsl.exe -d <distro>` (`cat`/`ls` report No such file or directory), and may even vanish from the share; the other direction (written inside the distribution, read through the share) is fine. **Why this concerns search**: the realm's `fs` service writes **through the share**, while the two tools run `grep`/`find` **through `wsl.exe`** — with a stale share, "I just wrote that file and the search cannot find it" is the environment, not the tool. How to tell: write a file through the share and read it from the distribution immediately; if it is not there, reset the share first (`wsl.exe --shutdown` or a desktop restart).
- **The cost is on the distribution and 9P side, not in this process**: `grep -r` is linear in the files and bytes it reads, `find` in the directory entries it walks. An unbounded `find /` **does not finish** on this machine (the distribution has C:/D:/E: mounted over 9p; the 24,855 records flushed within a 240-second limit prove "more than zero", not a size) — narrowing `path` is the only lever.

## Where the pins are

`scripts/verify-search.mjs` (offline, **with no precondition, so it never skips**; `node scripts/verify-search.mjs` → **32 passed, 0 failed** here) pins five sections: the glob translation (a `**/` collapses to `*`; a leading `/` and `./` are stripped), the argv vectors (every model value exactly one inert element, plus **two golden vectors** — whole-argv literal equality, with all six VCS names, their order, the separator and the output format inside), the properties those vectors stand on (the VCS list is the host's, in the host order; the exclusions must sit before the `--`), the two parsers (the split at the first colon, colons in the text preserved, a `:` path skipped, a non-integer line number skipped, CRLF, the byte cap and the character boundary, the cap versus a damaged record, the NUL separator and a newline inside a path, mtime-ascending with the oldest kept, a record with no space or a non-finite mtime skipped), and the failure vocabulary (grep's 2 is `SEARCH_INVALID_PATTERN` while the same code from find is not; a launch failure is `SEARCH_FAILED`).

The **live pair** lives in `scripts/verify-post-restart.mjs` (`tool.search.grep` and `tool.search.glob`; they need the installed plugin and a running host): they assert a hit on **line 3** of the probe file (the line number, not merely "the file was searched"), a glob listing the probe **and a file nested two directories down**, and **no `.git`** anywhere in the result. They must run on a **development assembly** (`developerTools === true`): under a production assembly the acceptance route answers `HTTP 401` by design, and that **is what it looks like when the two rows never ran** (measured twice here), not a failure of the tools. They are also the only observer of the "no offline pin" item above.

The document itself is pinned too: `docs/SEARCH.md` and `docs/SEARCH.en.md` are checked by `scripts/verify-docs.mjs`'s **declared-pair table** — the two editions must name the same repository artifacts. **That table compares artifact names, not semantics**: whether the two editions state the same gaps and the same numbers is guarded by the writer alone (which is why this section lays the list, the numbers and the boundaries out side by side).
