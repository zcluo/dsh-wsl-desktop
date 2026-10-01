#!/bin/bash
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

exec unshare --mount --propagation private $PID_FLAG env \
  DROP_UID="$uid" DROP_GID="$gid" DROP_HOME="$home" DROP_USER="${SUDO_USER:-root}" \
  DROP_CWD="$cwd" DROP_WORKSPACE="$workspace" DROP_COMMAND="${ARGS[*]}" \
  DROP_EXEMPT="$EXEMPT_PATTERN" \
  bash -c "$FENCE" dsh-wsl-confine
