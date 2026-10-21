/**
 * The wire vocabulary shared by the host route, the browser half and the doctor.
 *
 * A browser caller receives a CODE, never the host's message: the message can carry
 * wsl.exe stderr, resolved host paths and a stack. This module is the one place a
 * code's copy, its remedy and the params it may carry are defined, so the route, the
 * dialog and the health strip cannot drift into three different explanations.
 *
 * Pure data: no `node:` imports and no host imports, so every suite can load it and a
 * deployment that cannot resolve the host still knows what its codes mean.
 * @module dsh-wsl-desktop/protocol
 */

/**
 * Freeze a data tree, including the nested objects the route hands out.
 * @template T
 * @param {T} value - the tree.
 * @returns {T} the same tree, frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** The repository's public documentation, where a remedy's link resolves. */
const DOCS = 'https://github.com/zcluo/dsh-wsl-desktop/blob/main/docs'

/**
 * Every browser-visible failure.
 *
 * `zh`/`en` are static sentences: params are rendered separately, never interpolated
 * into copy, so a distro name or a path cannot rewrite the message.
 */
export const ERROR_CODES = deepFreeze({
  'wsl-not-available': {
    zh: '找不到可用的 WSL。',
    en: 'No usable WSL installation was found.',
    remedy: { kind: 'link', href: `${DOCS}/DISTRO-SUPPORT.md` },
    doc: 'DIAGNOSTICS.md#wsl-not-available',
  },
  'distro-unknown': {
    zh: '这个 WSL 发行版不存在或已被移除。',
    en: 'That WSL distribution does not exist or was removed.',
    remedy: { kind: 'text', zh: '刷新发行版列表；如果已经卸载，请重新安装或注册。', en: 'Refresh the distribution list; reinstall or re-register it if it was removed.' },
    doc: 'DIAGNOSTICS.md#distro-unknown',
  },
  'distro-unreachable': {
    zh: '发行版还在，但当前无法访问。',
    en: 'The distribution exists but cannot be reached right now.',
    remedy: { kind: 'text', zh: '先在终端启动这个发行版，然后重试。', en: 'Start the distribution in a terminal, then try again.' },
    doc: 'DIAGNOSTICS.md#distro-unreachable',
  },
  'user-unknown': {
    zh: '这个发行版里没有该用户。',
    en: 'That user does not exist in this distribution.',
    remedy: { kind: 'text', zh: '留空使用发行版默认用户，或输入一个已存在的用户。', en: 'Leave the field empty for the distribution default, or enter an existing user.' },
    doc: 'DIAGNOSTICS.md#user-unknown',
  },
  'path-invalid': {
    zh: '这个路径不是发行版内的绝对路径。',
    en: 'That path is not an absolute path inside the distribution.',
    remedy: { kind: 'text', zh: '输入以 / 开头的 Linux 路径，例如 /home/me/project。', en: 'Enter a Linux path that starts with /, for example /home/me/project.' },
    doc: 'DIAGNOSTICS.md#path-invalid',
  },
  'path-not-found': {
    zh: '这个目录不存在。',
    en: 'That directory does not exist.',
    remedy: { kind: 'text', zh: '检查路径，或在上一级目录里重新选择。', en: 'Check the path, or pick it again from its parent directory.' },
    doc: 'DIAGNOSTICS.md#path-not-found',
  },
  'path-not-directory': {
    zh: '这个路径不是目录。',
    en: 'That path is not a directory.',
    remedy: { kind: 'text', zh: '选择一个目录作为工作区。', en: 'Choose a directory as the workspace.' },
    doc: 'DIAGNOSTICS.md#path-not-directory',
  },
  'path-denied': {
    zh: '当前用户没有读取这个目录的权限。',
    en: 'The current user cannot read that directory.',
    remedy: { kind: 'text', zh: '换一个有权限的目录，或调整该目录的权限。', en: 'Choose a directory the user can read, or fix its permissions.' },
    doc: 'DIAGNOSTICS.md#path-denied',
  },
  'preset-not-ready': {
    zh: 'WSL 会话预设尚未生成，或暂时无法挂载。',
    en: 'The WSL session preset has not been generated or cannot be mounted.',
    remedy: { kind: 'text', zh: '重启桌面后重试；如果仍然失败，运行一次自检。', en: 'Restart the desktop and retry; run the self-check if it still fails.' },
    doc: 'DIAGNOSTICS.md#preset-not-ready',
  },
  'host-capability-missing': {
    zh: '当前桌面版本缺少插件依赖的宿主能力。',
    en: 'This desktop version lacks a host capability the plugin depends on.',
    remedy: { kind: 'link', href: `${DOCS}/DIAGNOSTICS.md#host-capability-missing` },
    doc: 'DIAGNOSTICS.md#host-capability-missing',
  },
  'host-plugin-stale': {
    zh: '宿主半边还是旧版本，浏览器半边已经更新。',
    en: 'The host half is older than the browser half.',
    remedy: { kind: 'text', zh: '重启桌面，让新的宿主半边加载。', en: 'Restart the desktop so the new host half loads.' },
    doc: 'DIAGNOSTICS.md#host-plugin-stale',
  },
  'too-busy': {
    zh: '请求太多，请稍后重试。',
    en: 'Too many requests; try again shortly.',
    remedy: { kind: 'text', zh: '等一秒再试。', en: 'Wait a second and retry.' },
    doc: 'DIAGNOSTICS.md#too-busy',
  },
  internal: {
    zh: '插件内部错误。',
    en: 'The plugin hit an internal error.',
    remedy: { kind: 'text', zh: '复制 ref 附在问题报告里，宿主日志里有对应的堆栈。', en: 'Copy the ref into the issue report; the host log has the matching stack.' },
    doc: 'DIAGNOSTICS.md#internal',
  },
  transport: {
    zh: '连不上插件的本地路由。',
    en: 'The plugin route could not be reached.',
    remedy: { kind: 'text', zh: '刷新页面；如果仍然失败，重启桌面。', en: 'Refresh the page; restart the desktop if it still fails.' },
    doc: 'DIAGNOSTICS.md#transport',
  },
  'catalog-unavailable': {
    zh: '诊断目录暂时不可用，错误码仍然会显示。',
    en: 'The diagnostic catalog is unavailable; the code is still shown.',
    remedy: { kind: 'text', zh: '重试；把显示的错误码附在问题报告里。', en: 'Retry; include the displayed code in the issue report.' },
    doc: 'DIAGNOSTICS.md#catalog-unavailable',
  },
})

/** Feature ids the contract probe and the degraded dialog share. */
export const FEATURE_IDS = deepFreeze([
  'picker', 'preset-generation', 'session-create', 'terminal', 'search', 'selftest',
])

/** Human-readable feature names, in both languages the product ships. */
export const FEATURE_LABELS = deepFreeze({
  picker: { zh: '工作区选择', en: 'Workspace picker' },
  'preset-generation': { zh: '会话预设', en: 'Session presets' },
  'session-create': { zh: '会话创建', en: 'Session creation' },
  terminal: { zh: '终端', en: 'Terminal' },
  search: { zh: '搜索工具', en: 'Search tools' },
  selftest: { zh: '自检', en: 'Self-test' },
})

/** Health-check ids, in display order. */
export const CHECK_IDS = deepFreeze(['bash', 'python3', 'util-linux', 'getent', 'runner', 'helper', 'nnp'])

/** Human-readable check names. */
export const CHECK_LABELS = deepFreeze({
  bash: { zh: 'bash', en: 'bash' },
  python3: { zh: 'Python 3', en: 'Python 3' },
  'util-linux': { zh: 'util-linux', en: 'util-linux' },
  getent: { zh: 'getent', en: 'getent' },
  runner: { zh: '受限模式 runner', en: 'Confinement runner' },
  helper: { zh: 'dsh-wsl-confine helper', en: 'dsh-wsl-confine helper' },
  nnp: { zh: 'NO_NEW_PRIVS', en: 'NO_NEW_PRIVS' },
})

/** The fix for one failed check, keyed by check id. */
export const CHECK_REMEDIES = deepFreeze({
  bash: {
    kind: 'command',
    value: 'sudo apt-get install -y bash',
    families: {
      debian: 'sudo apt-get install -y bash',
      fedora: 'sudo dnf install -y bash',
      arch: 'sudo pacman -S --noconfirm bash',
      alpine: 'sudo apk add bash',
      suse: 'sudo zypper install -y bash',
    },
  },
  python3: {
    kind: 'command',
    value: 'sudo apt-get install -y python3',
    families: {
      debian: 'sudo apt-get install -y python3',
      fedora: 'sudo dnf install -y python3',
      arch: 'sudo pacman -S --noconfirm python3',
      alpine: 'sudo apk add python3',
      suse: 'sudo zypper install -y python3',
    },
  },
  'util-linux': {
    kind: 'command',
    value: 'sudo apt-get install -y util-linux',
    families: {
      debian: 'sudo apt-get install -y util-linux',
      fedora: 'sudo dnf install -y util-linux',
      arch: 'sudo pacman -S --noconfirm util-linux',
      alpine: 'sudo apk add util-linux-misc findutils',
      suse: 'sudo zypper install -y util-linux',
    },
  },
  getent: {
    kind: 'text',
    zh: '缺少 getent 时，插件会回落到 provider 的默认 shell；安装 libc-bin（Debian/Ubuntu）或 util-linux 可恢复。',
    en: 'Without getent the plugin falls back to the provider default shell; install libc-bin (Debian/Ubuntu) or util-linux to restore it.',
  },
  runner: {
    kind: 'text',
    zh: '受限模式需要免密 sudo + unshare/setpriv，或安装 dsh-wsl-confine helper；danger-full-access 不受影响。',
    en: 'Restricted mode needs passwordless sudo plus unshare/setpriv, or the dsh-wsl-confine helper; danger-full-access is unaffected.',
  },
  helper: {
    kind: 'text',
    zh: 'helper 未安装或版本不是 v1.2；安装说明见 docs/CONFINEMENT.md。',
    en: 'The helper is missing or not v1.2; see docs/CONFINEMENT.md for the install command.',
  },
  nnp: {
    kind: 'text',
    zh: 'setpriv 不支持 --no-new-privs，受限模式不会运行；升级发行版的 util-linux。',
    en: 'setpriv lacks --no-new-privs, so restricted mode refuses to run; upgrade the distribution util-linux.',
  },
})

/**
 * The only params a browser may receive, per code.
 *
 * A code absent from this map still gets an empty allowlist; a new param has to be
 * added here AND covered by `verify-protocol`, which is deliberate friction.
 */
export const SAFE_PARAMS = deepFreeze({
  'wsl-not-available': [],
  'distro-unknown': ['distro'],
  'distro-unreachable': ['distro'],
  'user-unknown': ['user'],
  'path-invalid': ['path'],
  'path-not-found': ['path'],
  'path-not-directory': ['path'],
  'path-denied': ['path'],
  'preset-not-ready': ['preset'],
  'host-capability-missing': ['feature'],
  'host-plugin-stale': ['method'],
  'too-busy': [],
  internal: ['ref'],
  transport: [],
  'catalog-unavailable': [],
})
