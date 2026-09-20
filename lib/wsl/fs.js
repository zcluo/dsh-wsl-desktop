/**
 * `ctx.fs` provider for a WSL distribution.
 *
 * File I/O runs on the Windows side against the distribution's 9P share
 * (`\\wsl.localhost\<distro>\…`) because that share needs no helper installed
 * inside the distribution and keeps the harness's own read-before-edit,
 * version-guard and atomic-write semantics. The provider's job is to make that
 * share present one path dialect: everything the model and a WSL subprocess
 * see is a Linux path, while the opaque target key stays a host path.
 *
 * The share does not implement three primitives `LocalFileSystem` relies on, so
 * the constructor replaces them:
 * - hard links fail with `ENOTSUP`, which breaks create-if-absent publication;
 * - `ReplaceFileW` and `SetFileSecurityW` are local-volume Win32 APIs with no
 *   meaning on a network share.
 * @module dsh-wsl-desktop/wsl/fs
 */

import { copyFile, link, rename } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import { isUnderHost, writableHostRootsFor } from './fence.js'
import { isWindowsPathShaped, joinWslUnc, mntToWindowsPath, parseWslUnc, windowsToMntPath } from './paths.js'

/** Share-level errors that mean "this primitive is unavailable", not "the operation failed". */
const PRIMITIVE_UNAVAILABLE = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EINVAL'])

/** Default diff-basis ceiling, mirroring the local backend. */
const DEFAULT_DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

/** Plugin config: the local backend's knobs plus the distribution choice. */
export const Config = z.object({
  cwd: z.string().default(process.cwd()),
  diffBasisMaxBytes: z.number().default(DEFAULT_DIFF_BASIS_MAX_BYTES),
  /** Distribution used when a path does not already name one. */
  distro: z.string(),
})

/**
 * Resolve a caller-supplied path to a host path on the 9P share.
 * @param {string} value - the path as the caller spelled it.
 * @param {string | undefined} cwd - the caller's working directory.
 * @param {string | undefined} fallbackDistro - distribution for a Linux path with no UNC context.
 * @returns {string} an absolute Windows path the local backend can open.
 * @throws Error when the path belongs to neither world.
 */
export function toHostPath(value, cwd, fallbackDistro) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('fs-wsl: 路径不能为空')
  const unc = parseWslUnc(value)
  if (unc !== null) return joinWslUnc(unc.distro, posix.normalize(unc.linuxPath))
  if (value.startsWith('/')) {
    const drive = mntToWindowsPath(value)
    if (drive !== null) return drive
    const owner = parseWslUnc(cwd ?? '')
    const distro = owner?.distro ?? fallbackDistro
    if (distro === undefined) {
      throw new Error(`fs-wsl: 无法确定 "${value}" 所属的发行版，请配置 distro`)
    }
    return joinWslUnc(distro, posix.normalize(value))
  }
  if (isWindowsPathShaped(value)) return value
  // A relative path only has meaning inside the world its cwd names.
  const owner = parseWslUnc(cwd ?? '')
  if (owner !== null) return joinWslUnc(owner.distro, posix.join(owner.linuxPath, value))
  if ((cwd ?? '').startsWith('/')) {
    if (fallbackDistro === undefined) {
      throw new Error(`fs-wsl: 无法确定相对路径 "${value}" 所属的发行版，请配置 distro`)
    }
    return joinWslUnc(fallbackDistro, posix.join(cwd, value))
  }
  if (isWindowsPathShaped(cwd ?? '')) return win32.join(cwd, value)
  throw new Error(`fs-wsl: 既没有工作目录也没有发行版可以解析 "${value}"`)
}

/**
 * Project a host path back into the Linux dialect the execution world uses.
 * @param {string} value - a host path on the share or a drive path.
 * @returns {string} the Linux spelling when one exists, else the input.
 */
export function toLinuxPath(value) {
  const unc = parseWslUnc(value)
  if (unc !== null) return posix.normalize(unc.linuxPath)
  const drive = windowsToMntPath(value)
  if (drive !== null) return posix.normalize(drive)
  return value
}

/**
 * The WSL filesystem backend.
 *
 * It extends `LocalFileSystem` — so the atomic-write and read-match-write
 * mechanics, the read-before-edit guard and the version basis are the local
 * implementation's verbatim, plus this backend's replacements for the three
 * primitives the 9P share does not implement — and adds the fence the tool
 * layer reads, mirroring `@deepseek-ai/dsh-fs-sandbox` without inheriting it.
 * (Inheriting it would wrap this class in a second backend whose row then
 * depends on two realms' worth of services for no additional isolation: the
 * fence is a policy check in trusted code, and it lives here.)
 *
 * The fence exists because `LocalFileSystem` never overrides
 * `FileSystem.sandboxMode`: a backend that advertises nothing makes the tool
 * layer's `FsSandboxController` resolve no policy for any call
 * (`tool-fs/src/sandbox.ts:43-50`), so the `write` and `edit` tools ran
 * unfenced and could write anywhere the share reaches, including `/mnt/c`.
 *
 * The rule mirrors the shipped backend: the per-call policy is what carries the
 * workspace root (`resolvePolicy` always stamps the calling session's cwd), and
 * containment is checked on the freshly canonical target so a concurrently
 * swapped symlink ancestor cannot move the write outside it. The comparison
 * itself lives in `./fence.js`, in the host namespace — a targetKey's UNC
 * prefix carries the distribution — and is verified offline by
 * `scripts/verify-fs-fence.mjs`.
 */
export class WslFileSystem extends LocalFileSystem {
  /** The realm inherits the host's policy service; the fence reads it per call. */
  static inject = ['sandboxPolicy']

  /** Declared so the fs row's `distro` pin survives schema validation. */
  static Config = Config

  /** The deployment default mode, captured for the sandboxMode capability fact. */
  defaultMode

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the preset realm context.
   * @param {object} config - resolved plugin config.
   */
  constructor(ctx, config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
    this.internals = {
      ...this.internals,
      // 9P has no hard links; an exclusive copy keeps the same no-replace contract.
      linkFile: async (existingPath, newPath) => {
        try {
          await link(existingPath, newPath)
        } catch (error) {
          if (!PRIMITIVE_UNAVAILABLE.has(error?.code)) throw error
          await copyFile(existingPath, newPath, fsConstants.COPYFILE_EXCL)
        }
      },
      // ReplaceFileW cannot address a share; a rename replaces in one step.
      replaceFile: async (replaced, replacement) => {
        await rename(replacement, replaced)
      },
      // The share exposes no settable DACL, and staging is already private.
      copyFileDacl: async () => {},
    }
  }

  /**
   * The deployment default mode — the capability fact the tool layer reads to
   * decide that this backend confines and to advertise escalation. Declaring
   * it is what makes `tool-fs` resolve a per-call policy at all
   * (`tool-fs/src/sandbox.ts:43-50`).
   * @returns {string} the default sandbox mode.
   */
  get sandboxMode() {
    return this.defaultMode
  }

  /**
   * The roots a workspace-write mutation may land under. Delegates to the pure
   * {@link writableHostRootsFor} with this backend's distribution.
   * @param {{ mode?: string, workspaceRoot?: string }} policy - the per-call policy.
   * @returns {string[]} canonical host paths; empty unless workspace-write.
   */
  writableHostRoots(policy) {
    return writableHostRootsFor(policy, this.config.distro)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target
   * the mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes NOW (`resolve` realpaths the deepest existing ancestor,
   * reflecting a concurrently swapped symlink), requires containment under a
   * writable root, and returns THAT fresh target; `danger-full-access` returns
   * the caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint. A call that carries no policy resolves the
   * session-less default, which carries no workspace root and so fails closed
   * outside the temp areas — exactly how the shipped backend behaves.
   * @param {{ targetKey: string, displayPath: string }} target - the resolved target to check.
   * @param {{ mode?: string, workspaceRoot?: string }} [sandboxPolicy] - the per-call mode and workspace root.
   * @returns {Promise<{ targetKey: string, displayPath: string }>} the fresh target to mutate.
   */
  async checkedTarget(target, sandboxPolicy) {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    const fresh = await this.resolve(target.displayPath)
    for (const root of this.writableHostRoots(policy)) {
      if (await isUnderHost(fresh.targetKey, root)) return fresh
    }
    throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write with the checked target.
   * @param {{ targetKey: string, displayPath: string }} target - the resolved target to write.
   * @param {string} content - the full new file content.
   * @param {object} [expected] - the write intent guarding the write; omit for unconditional.
   * @param {AbortSignal} [signal] - aborts before atomic publication takes effect.
   * @param {{ mode?: string, workspaceRoot?: string }} [sandboxPolicy] - the per-call policy.
   * @returns {Promise<object>} the write outcome from the inherited backend.
   */
  async writeText(target, content, expected, signal, sandboxPolicy) {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit with the checked target.
   * @param {{ targetKey: string, displayPath: string }} target - the resolved target to edit.
   * @param {object} edit - the literal search/replace request.
   * @param {{ version: object }} [expected] - the version guard; omit for an unconditional edit.
   * @param {AbortSignal} [signal] - aborts before atomic publication takes effect.
   * @param {{ mode?: string, workspaceRoot?: string }} [sandboxPolicy] - the per-call policy.
   * @returns {Promise<object>} the edit outcome from the inherited backend.
   */
  async editText(target, edit, expected, signal, sandboxPolicy) {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * Resolve a path to a target whose display spelling is a Linux path.
   * @param {string} path - caller-supplied path.
   * @param {{ cwd?: string, signal?: AbortSignal }} [opts] - cwd override and cancellation.
   * @returns {Promise<{ targetKey: string, displayPath: string }>} the resolved target.
   */
  async resolve(path, opts) {
    const host = toHostPath(path, opts?.cwd ?? this.config.cwd, this.config.distro)
    const target = await super.resolve(host, opts?.signal ? { signal: opts.signal } : undefined)
    return { targetKey: target.targetKey, displayPath: toLinuxPath(host) }
  }

  /**
   * Inspect a path without following its final symlink.
   * @param {string} path - caller-supplied path.
   * @param {{ cwd?: string }} [opts] - cwd override.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object | undefined>} path metadata.
   */
  async lstat(path, opts, signal) {
    const host = toHostPath(path, opts?.cwd ?? this.config.cwd, this.config.distro)
    return super.lstat(host, undefined, signal)
  }

  /**
   * Return the Linux path a subprocess in this execution world can open.
   * @param {{ targetKey: string }} target - a resolved target.
   * @returns {string} the Linux path.
   */
  processPath(target) {
    return toLinuxPath(String(target.targetKey))
  }

  /**
   * Map a harness-host path into this execution world.
   * @param {string} hostPath - absolute host path.
   * @returns {string | undefined} the Linux path, or undefined when the file is not shared.
   */
  processPathFromHostPath(hostPath) {
    if (typeof hostPath !== 'string' || hostPath.length === 0) return undefined
    const unc = parseWslUnc(hostPath)
    if (unc !== null) return posix.normalize(unc.linuxPath)
    const drive = windowsToMntPath(hostPath)
    return drive === null ? undefined : posix.normalize(drive)
  }

  /**
   * Return the canonical file URI in the execution world.
   *
   * Built from the Linux path by hand: `pathToFileURL` applies the *host*
   * platform's rules, so on Windows a Linux absolute path would gain a drive
   * letter and produce `file:///C:/tmp/x` for `/tmp/x`.
   * @param {{ targetKey: string }} target - a resolved target.
   * @returns {string} the `file:` URI.
   */
  fileUrl(target) {
    const path = this.processPath(target)
    if (!path.startsWith('/')) return pathToFileURL(path).href
    return `file://${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`
  }

  /**
   * Test containment in the execution world's namespace.
   * @param {{ targetKey: string }} parent - canonical directory target.
   * @param {{ targetKey: string }} child - candidate target.
   * @returns {boolean} true when child is parent or below it.
   */
  contains(parent, child) {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../'))
  }
}

export default WslFileSystem
