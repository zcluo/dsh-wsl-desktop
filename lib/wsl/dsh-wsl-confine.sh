#!/bin/bash
# dsh-wsl-confine v1 — DSH WSL confinement helper.
#
# Root-owned fence executor: the ONLY thing this helper does is apply the
# mount-namespace fence (workspace bind, tmpfs /tmp, read-only /, read-only
# sweep with postconditions) and then drop to the target user and exec their
# command. The sudoers grant is narrowed to this helper alone, so re-invoking
# the privileged primitive from inside a confined command can only re-fence
# from the already-fenced context — the fence is no longer voidable by the
# principal it constrains.
#
# Install (one-time, per distribution, as root):
#   install -m 0755 -o root -g root <this file> /usr/local/sbin/dsh-wsl-confine
#   echo '<session-user> ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wsl-confine *' \
#     > /etc/sudoers.d/dsh-wsl-confine && chmod 0440 /etc/sudoers.d/dsh-wsl-confine
#
# Contract: parameters are strictly validated (numeric uid/gid, absolute
# paths); the caller's command travels as argv after `--` and is executed only
# AFTER the setpriv drop (with NO_NEW_PRIVS) — root never evaluates caller text.
set -euo pipefail
VERSION='dsh-wsl-confine v1'
SETUP_FAILURE_EXIT=97

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
((${#ARGS[@]} >= 1)) || { echo 'dsh-wsl-confine: no command' >&2; exit 2 }
command -v unshare >/dev/null 2>&1 || { echo 'dsh-wsl-confine: unshare not found' >&2; exit 97; }
command -v setpriv >/dev/null 2>&1 || { echo 'dsh-wsl-confine: setpriv not found' >&2; exit 97; }
command -v findmnt >/dev/null 2>&1 || { echo 'dsh-wsl-confine: findmnt not found' >&2; exit 97; }

# The fence script is built HERE from the validated parameters — the caller
# never supplies script text. It is identical in effect to the in-process
# builder (bind workspace before ro, tmpfs /tmp, decoded sweep, postconditions,
# NO_NEW_PRIVS drop).
FENCE='set -euo pipefail
fail() { printf "%s: %s\n" "dsh-wsl-confine" "$1" >&2; exit 97; }
if [[ -n "${WORKSPACE:-}" ]]; then
  mount --bind "$WORKSPACE" "$WORKSPACE"
  KEEP=("/tmp" "$WORKSPACE")
else
  KEEP=("/tmp")
fi
mount -t tmpfs tmpfs /tmp
mount -o remount,ro,bind /
findmnt -rno TARGET | while IFS= read -r raw; do printf "%b\n" "$raw"; done | { grep -Ev "^($(printf "%s|" "${KEEP[@]}" | sed "s/|$//")|/dev$|/proc$|/sys$")$" || fail "exemption grep failed"; } | while IFS= read -r target; do
  mount -o remount,ro,bind "$target" >/dev/null 2>&1 || true
done
mountpoint -q /tmp || fail "/tmp is not a private tmpfs"
findmnt -rno OPTIONS / | grep -q "^ro" || fail "/ is not read-only"
findmnt -rno TARGET | while IFS= read -r raw; do printf "%b\n" "$raw"; done | { grep -Ev "^($(printf "%s|" "${KEEP[@]}" | sed "s/|$//")|/dev$|/proc$|/sys$")$" || fail "exemption grep failed"; } | while IFS= read -r target; do
  [[ -w "$target" ]] && fail "$target is still writable"
  true
done
cd "$CWD"
exec setpriv --no-new-privs --reuid="$UID" --regid="$GID" --init-groups env HOME="$HOME_DIR" USER="$USER_NAME" LOGNAME="$USER_NAME" bash -lc "$COMMAND"'

PID_FLAG=''
[[ "$pidns" = 1 ]] && PID_FLAG='--pid --fork'

exec unshare --mount --propagation private $PID_FLAG bash -c "$FENCE" \
  dsh-wsl-confine \
  UID="$uid" GID="$gid" HOME_DIR="$home" USER_NAME="${SUDO_USER:-user}" \
  CWD="$cwd" WORKSPACE="$workspace" COMMAND="${ARGS[*]}"
