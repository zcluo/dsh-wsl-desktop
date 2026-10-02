# Stage the plugin inside the profile and install it.
#
# Two constraints shape this script:
#
#  1. The plugin's real files must live INSIDE the profile directory. The
#     profile's module resolver only routes bare `@deepseek-ai/*` imports for
#     modules under the profile prefix; a `link:` target outside it fails every
#     harness import with "Cannot find package".
#  2. Node caches a module by URL. Re-installing the same directory therefore
#     keeps serving the previously imported code, so each run stages a NEW
#     versioned directory; only the package name (the bundle identity in
#     `dsh.profile.bundles`) stays stable.
#
# The row id is stamped too: the loader does not re-apply a row id it has
# already mounted.

param(
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$plugins = Join-Path $dshHome "profiles\$Profile\plugins"
$stamp = Get-Date -Format 'MMddHHmmss'
# The stamp is second-resolution, so two runs inside one second would otherwise
# share a directory AND a row id. The loader refuses a row id it has already
# mounted, so the second stage would be ignored in silence rather than fail —
# and the copy into an existing directory fails loudly first. Bump until both
# are free.
$baseStamp = $stamp
$bump = 1
while (Test-Path (Join-Path $plugins "dsh-wsl-desktop-$stamp")) {
  $bump += 1
  $stamp = "$baseStamp-$bump"
}
$dest = Join-Path $plugins "dsh-wsl-desktop-$stamp"

# Drop every earlier staging directory EXCEPT the one the profile currently
# resolves. The running host writes generated presets that name absolute module
# paths inside its own directory, so deleting that directory breaks every WSL
# session until the next restart. Keeping two generations bounds the cost of the
# retained copy to one stale bundle.
# Resolved BEFORE the plugins directory is tested. A profile that has never been
# staged into has no `plugins/` at all, and the warning about an unresolvable
# stage still has to name the link it is talking about — an empty path there is
# the one fact the reader needs. (Measured on the real profile: the message read
# "profile link  does not exist".)
$link = Join-Path $dshHome "profiles\$Profile\node_modules\dsh-wsl-desktop"
$linked = $null
if (Test-Path $plugins) {
  if (Test-Path $link) {
    $item = Get-Item $link -Force
    # Any reparse point counts, not just a symbolic link: without Windows
    # symlink privilege the profile link is a junction, and treating that as
    # "no link" would delete EVERY generation here - including the one the
    # running host resolves, dangling the absolute module paths in generated
    # presets until the next restart.
    if ($item.LinkType -and $item.Target) {
      # Windows PowerShell 5.1 reports a reparse point's Target as a STRING
      # ARRAY while PowerShell 7 reports a scalar, and Join-Path refuses the
      # array outright ("Cannot convert 'System.String[]'"). Take the single
      # entry in both hosts so this script runs under the default
      # `powershell.exe` as well as `pwsh`.
      $target = @($item.Target)[0]
      # The target is ABSOLUTE for a link made with an absolute path, and
      # relative to the link's own directory otherwise. Joining an absolute
      # child onto the parent yields a path that resolves nowhere, so the
      # comparison below matched NO generation and this script deleted the very
      # directory the running host served — the failure its own comment above
      # warns about. Resolve each spelling on its own terms.
      $candidate = if ($target -match '^([A-Za-z]:[\\/]|\\\\)') {
        $target
      } else {
        Join-Path (Split-Path -Parent $link) $target
      }
      # Resolve-Path THROWS when the target no longer exists (a dangling link
      # left behind by a manual cleanup), and an abort here would leave the
      # staging half-done. The joined path is still this profile's generation
      # identity, so keep it: the deletion filter below compares against it and
      # therefore cannot take out the directory the running host resolves.
      try { $linked = (Resolve-Path $candidate).Path } catch { $linked = $candidate }
    }
  }
  # Neither spelling identifies the generation the running host serves: the
  # profile may have NO link at all, or its target may already be gone. The
  # filter below compares against $linked, and a $null there matches EVERY
  # generation — so an unguarded run deletes the directory the running host
  # resolves, which is the failure this block exists to prevent. Deleting the
  # rest would be a guess with the same blast radius either way.
  if ($null -eq $linked -or -not (Test-Path $linked)) {
    Write-Warning "cannot identify the generation the profile serves (link=$link resolved=$linked); keeping every staged generation"
  } else {
    # Keep the two newest, not merely the linked one. This run is about to point
    # the link at a generation nothing has loaded yet, so from the next run on
    # the linked generation is the one NOBODY is running — the generation the
    # running host resolves is the one staged before it. Deleting that one breaks
    # every WSL session until the next restart, which is the failure the comment
    # above warns about.
    $keep = @(Get-ChildItem $plugins -Directory -Filter 'dsh-wsl-desktop*' |
      Sort-Object -Property Name -Descending |
      Select-Object -First 2 -ExpandProperty FullName)
    $keep = @($keep + $linked | Select-Object -Unique)
    Get-ChildItem $plugins -Directory -Filter 'dsh-wsl-desktop*' |
      Where-Object { $keep -notcontains $_.FullName } |
      Remove-Item -Recurse -Force
  }
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src 'package.json') $dest
Copy-Item (Join-Path $src 'cordis.patch.yml') $dest
Copy-Item (Join-Path $src 'lib') $dest -Recurse

# Both rewrites below are LOAD-BEARING, and `-replace` reports NOTHING when its
# pattern does not match: it returns its input unchanged, the file was written back
# unchanged, and the run still exited 0. The row id is what makes the loader mount a
# NEW generation (it refuses one it has already mounted) and the config is what turns
# the acceptance surface on — so a miss surfaced much later, as a stage that was
# ignored in silence or as a string of 401s, with nothing in the run saying so.
#
# Each substitution is therefore CHECKED before anything is written, and a miss stops
# the run. The directory this run staged is removed again first, so a failure leaves
# the profile exactly as it was rather than holding a half-configured generation that
# the next run's filter would keep. Only the row id is stamped; the `name:` value must
# stay the package name.
$patchPath = Join-Path $dest 'cordis.patch.yml'
$original = Get-Content $patchPath -Raw

$rowIdPattern = '(?m)^(\s*- id: )wsl-desktop\s*$'
$stamped = $original -replace $rowIdPattern, "`${1}wsl-desktop-$stamp"
# The positive form is the assertion: the stamped text must CARRY the stamped id. A
# "did the text change" test alone accepted an empty source (an empty file returns
# $null, and $null -replace … is '' — also "unchanged" by comparison but written back).
if (-not $stamped.Contains("wsl-desktop-$stamp")) {
  Remove-Item $dest -Recurse -Force
  throw "cordis.patch.yml carries no 'wsl-desktop' row id to stamp (pattern: $rowIdPattern); nothing was staged"
}

# This installer exists to exercise the plugin on a development machine, so it
# turns the acceptance surface on. The shipped patch leaves it off: that surface
# can run commands, and a real install does not need it. The transport fence
# still applies to every caller — a foreign Host/Origin is refused for token
# holders too: a development token replaces only the browser-authentication arm
# (401), never the rebinding arm (403). The token decides which methods a
# non-browser caller may reach, not whether the fence runs.
$configPattern = "(?m)^(\s*name: 'dsh-wsl-desktop')\s*$"
$configured = $stamped -replace $configPattern, "`${1}`n      config:`n        developerTools: true"
# Both halves are required here: the text must have CHANGED (a patch that already
# carried the config would otherwise pass on a miss) and it must carry the key.
if ($configured -ceq $stamped -or -not $configured.Contains('developerTools: true')) {
  Remove-Item $dest -Recurse -Force
  throw "cordis.patch.yml carries no 'dsh-wsl-desktop' name line to configure (pattern: $configPattern); nothing was staged"
}

# One write, after both substitutions have been shown to apply.
Set-Content $patchPath $configured -NoNewline

# Point the profile at the generation just staged.
#
# Staging alone deploys nothing: the host resolves whatever the profile link
# points at, so a run that only copies a directory leaves the previous generation
# loaded, and "stage then restart" silently loads old code while both the source
# tree and the staged copy say otherwise. The profile's manifest and lockfile are
# updated with it, because a later `pnpm install` reconciles the link to the
# manifest and would otherwise undo this.
if ($null -eq $linked -or -not (Test-Path $link)) {
  Write-Warning "profile link $link does not exist; staged $dest but nothing will resolve it until the profile is installed"
} else {
  $oldName = Split-Path -Leaf $linked
  $newName = Split-Path -Leaf $dest
  # `Remove-Item` on a directory reparse point is not reliable: Windows
  # PowerShell 5.1 throws NullReferenceException for a junction, which aborts the
  # re-point so the run fails loudly with the OLD generation still linked — and
  # the very next run under pwsh would then delete a generation that is still
  # named nowhere. Deleting the reparse point through .NET takes the LINK only,
  # never its target, for a junction and for a symbolic link alike.
  [System.IO.Directory]::Delete($link, $false)
  try {
    New-Item -ItemType SymbolicLink -Path $link -Target $dest | Out-Null
  } catch {
    # Without the symlink privilege the profile falls back to a junction, which
    # this script already reads on the next run.
    New-Item -ItemType Junction -Path $link -Target $dest | Out-Null
  }
  $profileRoot = Split-Path -Parent (Split-Path -Parent $link)
  foreach ($name in @('package.json', 'pnpm-lock.yaml')) {
    $file = Join-Path $profileRoot $name
    if (-not (Test-Path $file)) { continue }
    $text = Get-Content $file -Raw
    if ($text -notlike "*$oldName*") { continue }
    Set-Content $file -NoNewline ($text.Replace($oldName, $newName))
  }
}

Write-Output $dest
