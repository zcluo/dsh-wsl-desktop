#!/bin/bash
# Distro matrix driver — runs INSIDE debian-dev (has docker).
# For each distro family image: install the plugin's runtime prerequisites,
# run the shipped fence fixture (the real confinement script), and run the
# tool probe. Emits one matrix row per image.
#
# Usage: bash /mnt/e/projects/dsh-wsl-desktop/scripts/distro-matrix.sh
set -uo pipefail

REPO=/mnt/e/projects/dsh-wsl-desktop
FIXTURE_DIR="$REPO/tmp-probe/distro-matrix"

IMAGES=(
  "debian:12|apt"
  "ubuntu:24.04|apt"
  "fedora:41|dnf"
  "archlinux|pacman"
  "opensuse/leap:15.6|zypper"
  "alpine:3.20|apk"
)

row() { printf "%-22s %-8s %-42s %s\n" "$1" "$2" "$3" "$4"; }

echo "==================== DISTRO MATRIX (userland fence compatibility) =================="
row "IMAGE" "PM" "TOOLS (unshare/setpriv/findmnt/python3/NNP)" "FENCE RESULT"

for entry in "${IMAGES[@]}"; do
  image="${entry%%|*}"; pm="${entry##*|}"
  echo "--- $image ---" >&2
  docker pull -q "$image" >/dev/null 2>&1

  # Per-family prerequisite install: bash, python3, util-linux (unshare/
  # setpriv/findmnt), sudo. Best-effort; failures show up in the tool probe.
  setup=''
  case "$pm" in
    apt)    setup='apt-get update -qq && apt-get install -y -qq util-linux python3 sudo findutils >/dev/null 2>&1 || true' ;;
    dnf)    setup='dnf install -y util-linux python3 sudo findutils >/dev/null 2>&1 || true' ;;
    pacman) setup='pacman -Sy --noconfirm util-linux python3 sudo findutils >/dev/null 2>&1 || true' ;;
    zypper) setup='zypper --non-interactive install util-linux python3 sudo findutils >/dev/null 2>&1 || true' ;;
    apk)    setup='apk add --no-cache util-linux-misc python3 sudo findutils bash >/dev/null 2>&1 || true' ;;
  esac

  # Run: setup deps (alpine: /bin/sh init — no bash until installed), then the
  # tool probe, then the shipped fence fixture.
  initsh='/bin/bash'
  [ "$pm" = apk ] && initsh='/bin/sh'
  result=$(timeout 300 docker run --rm --privileged -v "$FIXTURE_DIR":/fixture:ro "$image" \
    "$initsh" -c "
      export DEBIAN_FRONTEND=noninteractive
      $setup
      echo '---TOOLS---'
      bash /fixture/probe-tools.sh 2>&1
      echo '---FENCE---'
      if [ -x /usr/bin/bash ] || command -v bash >/dev/null 2>&1; then
        bash /fixture/fence-fixture.sh 2>&1
        echo \"FENCE-EXIT=\$?\"
      else
        echo 'FENCE-SKIPPED: no bash'
      fi
    " 2>&1)

  tools_line=$(echo "$result" | grep -E '^(unshare|setpriv|findmnt|mount|bash|python3|sudo|nnp)=' | tr '\n' ' ')
  fence_out=$(echo "$result" | sed -n '/---FENCE---/,$p' | grep -vE '^---FENCE---|^FENCE-EXIT=' | tr '\n' ' ')
  fence_exit=$(echo "$result" | grep -oE 'FENCE-EXIT=[0-9]+' | head -1)
  escaped=$(echo "$fence_out" | grep -o 'esc: ESCAPED' | head -1)
  inside=$(echo "$fence_out" | grep -o 'INSIDE-OK' | head -1)
  fenceverif=$(echo "$fence_out" | grep -o 'FENCE-OK' | head -1)

  fence_verdict='PASS'
  [ "$fence_exit" = 'FENCE-EXIT=0' ] || fence_verdict='FAIL (exit != 0)'
  [ -n "$fenceverif" ] || fence_verdict='FAIL (no /tmp verification)'
  [ -n "$inside" ] || fence_verdict='FAIL (workspace not writable)'
  [ -n "$escaped" ] && fence_verdict='FAIL (ESCAPED /usr writable!)'

  row "$image" "$pm" "${tools_line:-$result}" "$fence_verdict"
done
echo "==================== END MATRIX ===================="
