/**
 * Generate the per-distro fence fixture used by scripts/distro-matrix.sh.
 *
 * The fixture is the REAL confinement script produced by buildNamespaceScript
 * (workspace-write mode, NO_NEW_PRIVS drop) wrapped in a container preamble
 * that creates the workspace and tester home. Running it as root inside a
 * distro container exercises that distro's userland against the exact fence
 * the plugin ships.
 * Run: node scripts/generate-fence-fixture.mjs  →  tmp-probe/distro-matrix/
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNamespaceScript } from '../lib/wsl/confinement.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'tmp-probe', 'distro-matrix')
await mkdir(outDir, { recursive: true })

const fence = buildNamespaceScript({
  command: 'echo FENCE-OK > /workspace/fence-verification.txt && echo INSIDE-OK > /workspace/inside.txt && (echo ESCAPE-ATTEMPT > /usr/escape-test 2>/dev/null && echo ESCAPED || echo ESCAPE-DENIED) && cat /workspace/fence-verification.txt /workspace/inside.txt && echo "esc: $(cat /usr/escape-test 2>/dev/null || echo DENIED)"',
  linuxCwd: '/workspace',
  mode: 'workspace-write',
  workspaceLinuxRoot: '/workspace',
  identity: { uid: '1000', gid: '1000', name: 'tester', home: '/home/tester' },
  noNewPrivs: true,
})

const preamble = `set -e
# Mirror production: the drop target ALWAYS exists in the distro's passwd
# (resolveIdentity reads it from there via getent). setpriv --init-groups
# requires the uid to resolve.
id tester >/dev/null 2>&1 || useradd -m -u 1000 tester 2>/dev/null || true # uid 1000 may already exist under another name (ubuntu image)
mkdir -p /workspace
echo seed > /workspace/seed.txt
chown -R 1000:1000 /workspace`

await writeFile(join(outDir, 'fence-fixture.sh'), `${preamble}\n${fence}\n`)
await writeFile(
  join(outDir, 'probe-tools.sh'),
  `#!/bin/bash
# Per-distro tool probe: reports the facts the support matrix records.
echo "pm=$([ -x /usr/bin/apt ] && echo apt || [ -x /usr/bin/dnf ] && echo dnf || [ -x /usr/bin/pacman ] && echo pacman || [ -x /sbin/apk ] && echo apk || echo unknown)"
for t in unshare setpriv findmnt mount bash python3 sudo; do
  printf "%s=%s\\n" "$t" "$(command -v $t >/dev/null 2>&1 && echo yes || echo no)"
done
printf "nnp=%s\\n" "$(setpriv --help 2>&1 | grep -q -- --no-new-privs && echo yes || echo no)"
printf "findmnt_version=%s\\n" "$(findmnt --version 2>/dev/null || echo none)"
`,
)
console.log(`fixture written to ${outDir}`)
