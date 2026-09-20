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
$dest = Join-Path $plugins "dsh-wsl-desktop-$stamp"

# Drop every earlier staging directory EXCEPT the one the profile currently
# resolves. The running host writes generated presets that name absolute module
# paths inside its own directory, so deleting that directory breaks every WSL
# session until the next restart. Keeping two generations bounds the cost of the
# retained copy to one stale bundle.
if (Test-Path $plugins) {
  $link = Join-Path $dshHome "profiles\$Profile\node_modules\dsh-wsl-desktop"
  $linked = $null
  if (Test-Path $link) {
    $item = Get-Item $link -Force
    # Any reparse point counts, not just a symbolic link: without Windows
    # symlink privilege the profile link is a junction, and treating that as
    # "no link" would delete EVERY generation here - including the one the
    # running host resolves, dangling the absolute module paths in generated
    # presets until the next restart.
    if ($item.LinkType -and $item.Target) {
      $linked = (Resolve-Path (Join-Path (Split-Path -Parent $link) $item.Target)).Path
    }
  }
  Get-ChildItem $plugins -Directory -Filter 'dsh-wsl-desktop*' |
    Where-Object { $_.FullName -ne $linked } |
    Remove-Item -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src 'package.json') $dest
Copy-Item (Join-Path $src 'cordis.patch.yml') $dest
Copy-Item (Join-Path $src 'lib') $dest -Recurse

# Only the row id is stamped; the `name:` value must stay the package name.
$patchPath = Join-Path $dest 'cordis.patch.yml'
(Get-Content $patchPath -Raw) -replace '(?m)^(\s*- id: )wsl-desktop\s*$', "`${1}wsl-desktop-$stamp" |
  Set-Content $patchPath -NoNewline

# This installer exists to exercise the plugin on a development machine, so it
# turns the acceptance surface on. The shipped patch leaves it off: that surface
# can run commands, and a real install does not need it. The transport fence
# still applies to every caller; the token only decides which methods a
# non-browser caller may reach.
$patch = Get-Content $patchPath -Raw
$patch = $patch -replace "(?m)^(\s*name: 'dsh-wsl-desktop')\s*$", "`${1}`n      config:`n        developerTools: true"
Set-Content $patchPath $patch -NoNewline

Write-Output $dest
