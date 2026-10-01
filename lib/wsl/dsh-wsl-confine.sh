#!/bin/bash -p
# Privileged mode (-p): this script runs as root via sudo, and without -p bash would
# source a caller-supplied BASH_ENV file BEFORE our first line, as root. The
# startup-defence note below carries the measurement (bash 5.2.37).
# dsh-wsl-confine v1.2 — DSH WSL confinement helper.
#
# Root-owned fence executor: the ONLY thing this helper does is apply the
# mount-namespace fence (workspace bind, tmpfs /tmp, read-only /, read-only
# sweep with postconditions) and then drop to the target user and exec their
# command. The sudoers grant is narrowed to this helper alone, so re-invoking
# the privileged primitive from inside a confined command can only re-fence
# from the already-fenced context — the fence is no longer voidable by the
# principal it constrains.
#
# Install (per distribution, as root; re-run it after every plugin upgrade —
# the detector requires the exact HELPER_VERSION this package ships):
#   install -m 0755 -o root -g root <this file> /usr/local/sbin/dsh-wsl-confine
#   echo '<session-user> ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wsl-confine *' \
#     > /etc/sudoers.d/dsh-wsl-confine && chmod 0440 /etc/sudoers.d/dsh-wsl-confine
#
# Contract: parameters are strictly validated (numeric uid/gid, absolute
# paths); the caller's command travels as argv after `--` and is executed only
# AFTER the setpriv drop (with NO_NEW_PRIVS) — root never evaluates caller text.
# The drop identity is checked against the INVOKING user (SUDO_USER): the
# sudoers grant is argument-wildcarded, and an unchecked --uid would let the
# session user aim it at uid 0 — the fence is a WRITE boundary, so uid 0 inside
# it still reads every root-only file. Root's own direct invocation has no
# SUDO_USER and skips the check.
#
# This script runs as root and calls twelve tools by bare name (getent, cut, sed,
# tr, mount, findmnt, grep, mountpoint, setpriv, env, bash, unshare). sudo's
# env_reset does not save it: an exported PATH is replaced when sudoers sets
# secure_path, but a PATH handed over as a sudo command-line assignment still
# reaches us (measured on debian, debian-dev and arch), and the NOPASSWD grant is
# argument-wildcarded. Every external below would then be resolved from that PATH
# as uid 0 - including getent and cut, whose output the identity gate trusts for
# the --uid/--gid comparison, so a forged answer satisfied --uid 0 --gid 0. Pin it
# here, as the FIRST statement, rather than depending on a deployment option we
# cannot verify.
#
# The pin is unconditional and has NO fallback: the twelve tools must be reachable
# in these six directories. A distribution where one is not fails CLOSED - nothing
# runs: a missing getent leaves the caller record empty and the gate refuses it, a
# missing cut fails the pipeline under pipefail (127) before the fence, and the
# command -v preflights below exit 97 with the setup-failure marker. No branch
# re-widens PATH to the caller's, because a fallback would restore exactly this
# hole.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# CLOSED here: a caller-supplied BASH_ENV was sourced by bash BEFORE line 1, as root
# (measured: `sudo -n BASH_ENV=<file> <this file> --version` ran <file> as uid 0), so
# the caller got unconfined root code execution ahead of every control below - the pin
# included, which is why the pin could not close it. THREE edits in THIS file close it.
# (1) The shebang is `#!/bin/bash -p`. Privileged mode does not process BASH_ENV
# (measured on bash 5.2.37: `bash -p script`, a `#!/bin/bash -p` shebang under exec and
# `bash -p -c` all skip it, while plain `bash script`, a `#!/bin/bash` shebang and
# `bash -c` source it), and it also stops importing functions from the environment into
# THIS shell. (2) -p does not REMOVE the variable, and every descendant inherits it -
# the drop-side `bash -lc "$DROP_COMMAND"` is NOT privileged and does process it
# (measured: it sourced the caller's file as the session user, inside the fence) - so
# the exec tail drops it with `env -u BASH_ENV`: one removal on the one invocation
# every root-phase descendant hangs off. (3) That same fence body is launched
# with `-p`: privileged mode is a property of the SHELL, so (1) protected this shell
# only, and a caller-exported FUNCTION named `mount`, `findmnt` or `mountpoint` was
# imported by the fence body and overrode the tools the fence is built from
# (measured: with all three supplied the fence reported success while /mnt/c stayed
# writable - a silent bypass; with only `mount()` supplied it failed closed at the
# postcondition by luck; and a caller `set()` function disabled the fence body's own
# `set -euo pipefail`, its first line). Measured together on a copy with
# BASH_ENV armed: nothing sourced, `--version` still answers, and a real confined
# command returns its normal result, byte-identical to the pre-change helper's output.
# Severity: this is unconfined root code execution BEFORE the fence, which exceeds the
# root-inside-the-fence read access the pin above closes - but only for a deployment
# whose sudo grant is NARROW (this helper alone); an account holding NOPASSWD: ALL
# already has that ceiling.

set -euo pipefail
VERSION='dsh-wsl-confine v1.2'

uid=; gid=; home=; cwd=; workspace=; pidns=1
ARGS=()
while (($#)); do
  case "$1" in
    --uid) uid="${2:-}"; shift 2 ;;
    --gid) gid="${2:-}"; shift 2 ;;
    --home) home="${2:-}"; shift 2 ;;
    --cwd) cwd="${2:-}"; shift 2 ;;
    --workspace) workspace="${2:-}"; shift 2 ;;
    --no-pidns) pidns=0; shift ;;
    --version) echo "$VERSION"; exit 0 ;;
    --) shift; ARGS=("$@"); break ;;
    *) echo "dsh-wsl-confine: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || { echo 'dsh-wsl-confine: uid/gid must be numeric' >&2; exit 2; }
[[ -n "$cwd" && "$cwd" = /* && -n "$home" && "$home" = /* ]] || { echo 'dsh-wsl-confine: --cwd/--home must be absolute Linux paths' >&2; exit 2; }
[[ -z "$workspace" || "$workspace" = /* ]] || { echo 'dsh-wsl-confine: --workspace must be absolute' >&2; exit 2; }
# The exemption pattern is built from the workspace value, so a control character
# in it was fence SYNTAX: the builder printed one entry per line and turned every
# LF into '|', which made '/home/u/proj/x<LF>/mnt/c' an alternation that exempted
# /mnt/c from BOTH the read-only sweep and the writability postcondition — the
# fence reported success while the Windows filesystem stayed writable. Refuse the
# spelling here as well: the JS side refuses it too, and the helper must not
# depend on its caller for its own pattern syntax. The class is the whole C0 range
# plus DEL — the one lib/wsl/confinement.js applies in assertWorkspaceSpelling() —
# so the two fences agree on what a workspace may be. LF is the member that
# mattered; a NUL cannot reach a shell variable at all.
[[ "$workspace" != *[[:cntrl:]]* ]] || { echo 'dsh-wsl-confine: --workspace must not contain control characters' >&2; exit 2; }
# The fence mounts a private tmpfs over /tmp AFTER binding the workspace, so a
# workspace at or below /tmp would be covered by it: the bind disappears, "cd
# /tmp/proj" fails, and with the workspace exactly /tmp the writes would land in
# the ephemeral tmpfs and vanish. Refuse instead of building a fence that lies.
# Exit 97 WITH the setup-failure marker, unlike the exit-2 usage refusals above:
# this is not a malformed argument, it is a fence that cannot be established for
# the requested workspace, and the executor classifies that on code AND marker
# (shell.js runnerFailed). A caller that ignores it would otherwise read a
# fence that never ran as an ordinary command failure.
[[ -z "$workspace" || ( "$workspace" != /tmp && "$workspace" != /tmp/* ) ]] || { echo 'dsh-wsl-sandbox: setup failed: --workspace must not be /tmp or below it (the private tmpfs would cover it)' >&2; exit 97; }
((${#ARGS[@]} >= 1)) || { echo 'dsh-wsl-confine: no command' >&2; exit 2; }

# Identity gate: the caller may only drop to the user sudo says is invoking.
if [[ -n "${SUDO_USER:-}" ]]; then
  CALLER_RECORD=$(getent passwd "$SUDO_USER" || true)
  CALLER_UID=$(printf '%s' "$CALLER_RECORD" | cut -d: -f3)
  CALLER_GID=$(printf '%s' "$CALLER_RECORD" | cut -d: -f4)
  if [[ -z "$CALLER_UID" || "$uid" != "$CALLER_UID" || "$gid" != "$CALLER_GID" ]]; then
    echo "dsh-wsl-confine: identity mismatch (refusing --uid/--gid for ${SUDO_USER})" >&2
    exit 2
  fi
fi

# These pre-flight refusals carry the SAME setup-failure marker the fence's own
# fail() prints: exit 97 alone is indistinguishable from a command that failed
# with 97, and the executor classifies on code AND marker (shell.js
# runnerFailed), so without it a fence that never ran reads as a command failure.
command -v unshare >/dev/null 2>&1 || { echo 'dsh-wsl-sandbox: setup failed: unshare not found' >&2; exit 97; }
command -v setpriv >/dev/null 2>&1 || { echo 'dsh-wsl-sandbox: setup failed: setpriv not found' >&2; exit 97; }
command -v findmnt >/dev/null 2>&1 || { echo 'dsh-wsl-sandbox: setup failed: findmnt not found' >&2; exit 97; }

# The allow-list pattern is built HERE, from the validated parameters, with every
# entry escaped so a PATH stays data and never becomes regex syntax. Unescaped,
# a workspace like "/home/u/My Project (v2)" turned its own parentheses into an
# ERE group: the real workspace stopped matching, so the sweep remounted it
# READ-ONLY and every write inside it failed with EROFS. Worse, an unescaped "|"
# became alternation — a workspace "/home/u/x|/mnt/c" made /mnt/c an EXEMPT
# target, leaving the Windows filesystem WRITABLE inside a confined session,
# which is the exact hole this fence exists to close. The escape set is the one
# lib/wsl/confinement.js applies in escapeEre(), and the exempt entries are the
# union it builds from KERNEL_SURFACES — the two fences must agree.
#
# The SEPARATOR is the one hole the escape set cannot close: the entries are joined
# line-wise, so an LF inside the workspace value was indistinguishable from an entry
# boundary — '/home/u/proj/x<LF>/mnt/c' exempted /mnt/c from both the sweep and the
# postcondition. That is closed ABOVE, not here: the refusal before this builder
# makes a control character in the value impossible, so no separator can be injected.
# (Delimiting the pipeline with NULs instead — printf '%s\0' | sed -z | tr '\0' '|' —
# would make the builder lossless by itself, but that is GNU sed only: BusyBox sed
# 1.36 rejects -z, and Alpine 3.20 is a distribution docs/DISTRO-SUPPORT.md lists as
# supported. The builder would fail there for EVERY confined command, so the lossless
# form is not portable and the refusal above is what the fence relies on.)
KEEP_ENTRIES=(/tmp /dev /dev/pts /dev/mqueue /proc /sys)
[[ -z "$workspace" ]] || KEEP_ENTRIES+=("$workspace")
EXEMPT_PATTERN=$(printf '%s\n' "${KEEP_ENTRIES[@]}" | sed 's/[][\\^$.*+?(){}|]/\\&/g' | tr '\n' '|')
EXEMPT_PATTERN="${EXEMPT_PATTERN%|}"

# The fence script is built HERE from the validated parameters — the caller
# never supplies script text. It is identical in effect to the in-process
# builder (bind workspace before ro, tmpfs /tmp, decoded sweep, postconditions,
# NO_NEW_PRIVS drop). Parameters cross into `bash -c` as ENVIRONMENT
# VARIABLES via env(1): bare KEY=VALUE words after the script name would be
# positional parameters no variable reference can read, and $UID/$GID are
# bash built-ins that would silently resolve to root's ids under sudo. The
# exemption pattern crosses pre-built and already escaped (DROP_EXEMPT above),
# so no path is ever interpolated into regex syntax here, and it is anchored at
# BOTH ends — the trailing `$` is what stops the entry "/tmp" from matching a
# sibling like "/tmp/x".
FENCE='set -euo pipefail
fail() { printf "%s: %s\n" "dsh-wsl-sandbox: setup failed" "$1" >&2; exit 97; }
[[ -z "${DROP_WORKSPACE:-}" ]] || mount --bind "$DROP_WORKSPACE" "$DROP_WORKSPACE"
mount -t tmpfs tmpfs /tmp
mount -o remount,ro,bind /
findmnt -rno TARGET | while IFS= read -r raw; do printf "%b\n" "$raw"; done | { grep -Ev "^(${DROP_EXEMPT})\$" || fail "exemption grep failed"; } | while IFS= read -r target; do
  mount -o remount,ro,bind "$target" >/dev/null 2>&1 || true
done
mountpoint -q /tmp || fail "/tmp is not a private tmpfs"
findmnt -rno OPTIONS / | grep -q "^ro" || fail "/ is not read-only"
findmnt -rno TARGET | while IFS= read -r raw; do printf "%b\n" "$raw"; done | { grep -Ev "^(${DROP_EXEMPT})\$" || fail "exemption grep failed"; } | while IFS= read -r target; do
  [[ -w "$target" ]] && fail "$target is still writable"
  true
done
cd "$DROP_CWD"
exec setpriv --no-new-privs --reuid="$DROP_UID" --regid="$DROP_GID" --init-groups env HOME="$DROP_HOME" USER="$DROP_USER" LOGNAME="$DROP_USER" bash -lc "$DROP_COMMAND"'

PID_FLAG=''
[[ "$pidns" = 1 ]] && PID_FLAG='--pid --fork'

# -p stops OUR bash from processing BASH_ENV, but it does NOT remove the variable from
# the environment, and every descendant inherits it. The drop-side `bash -lc
# "$DROP_COMMAND"` is NOT privileged and does process it (measured: it sourced the
# caller's file as the session user, inside the fence). Drop it HERE, on the one
# invocation every root-phase descendant hangs off, so no descendant can be made to
# source a caller's file.
#
# -p on THIS file's bash also stops the import of functions from the environment
# into THIS shell only. The fence body is a separate `bash -c`, so without -p there a
# caller-exported BASH_FUNC_* function overrides the very tools the fence is built
# from (measured: a coordinated mount/findmnt/mountpoint override made the sweep
# report a confined system while /mnt/c stayed writable - a silent bypass). It is
# therefore launched with -p as well: the same privileged-mode rule that skips
# BASH_ENV skips the function import, so a coordinated override becomes a no-op
# instead of a fence that lies.
exec unshare --mount --propagation private $PID_FLAG env -u BASH_ENV \
  DROP_UID="$uid" DROP_GID="$gid" DROP_HOME="$home" DROP_USER="${SUDO_USER:-root}" \
  DROP_CWD="$cwd" DROP_WORKSPACE="$workspace" DROP_COMMAND="${ARGS[*]}" \
  DROP_EXEMPT="$EXEMPT_PATTERN" \
  bash -p -c "$FENCE" dsh-wsl-confine
