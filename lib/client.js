/**
 * Browser half of `dsh-wsl-desktop`.
 *
 * Adds one control beside the shipped "add workspace" button in the sidebar
 * section header: a `W` button opening this plugin's WSL workspace picker.
 *
 * The shipped button keeps its own behaviour: this half registers no slot
 * occupant, because `sidebar.workspaces.directoryFlow` is `kind: 'single'` and
 * any occupant shadows the deployment's host folder chooser. The header itself
 * declares no extension point, so the companion button is attached to the
 * shipped trigger's node and re-attached when React replaces that subtree.
 * Discovery matches the trigger icon's path data, which is locale-independent.
 *
 * The harness fixes a session's agent preset at creation, so this half names
 * the WSL preset IN the create request it sends: it asks the host's
 * `wslPresetFor` for the variant id and passes `agentPreset` to
 * `ctx.sessions.create`. A preset cannot be selected afterwards on a session
 * that has already taken a turn, so there is no other race-free seam.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wsl-desktop',
  factory() {
    // MUST stay equal to the host half's Config.routePath default (lib/index.js).
    /*
     * Section index. This file is ONE loader module: `window.__ModuleLoader__`
     * evaluates a single factory, and splitting it across files would need a
     * loader capability that has not been measured. The boundaries below are
     * therefore comments, not files — they exist so a reader can hold one
     * section at a time, and so a future split has its seams already named.
     *   1. endpoint, trigger geometry and locale
     *   2. copy, theme and shared node helpers
     *   3. route calls and failure rendering
     *   4. the W workspace picker dialog
     *   5. the companion button and workspace rows
     *   6. module registration and dispose
     */

    // Nothing derives one from the other: a deployment that mounts the route
    // elsewhere loses the picker silently.
    // ── 1. endpoint, trigger geometry and locale ─────────────────────────────
    const ENDPOINT = '/wsl-desktop/api'

    /**
     * Known first path commands of the shipped "add workspace" icon across
     * desktop generations — the only places the app renders it. The trigger
     * matches by prefix, so the list covers the pre-refactor
     * `IconProjectAddOutline16` geometry and the post-refactor
     * `ProjectAddOutlineArtwork` geometry; a desktop running either
     * generation keeps the W button alive.
     */
    const TRIGGER_ICON_PATHS = [
      'M3.55246 0L3.55246 2.44252', // pre-refactor IconProjectAddOutline16
      'M5.54492 2.06738',           // post-refactor ProjectAddOutlineArtwork
    ]

    /**
     * The same trigger, named by sprite symbol instead of path data.
     *
     * Desktop 0.2.1-rc3 (ui-primitives `c3eead771d`) moved every product icon
     * into the document icon sprite: the header button now renders
     * `<svg data-icon="dsw-icon-project-add-outline-regular"><use href="#…"/></svg>`
     * with NO `<path>` child anywhere. The geometry scan above therefore matched
     * nothing, the anchor read as absent, and the W button stood down on every
     * 0.2.1-rc3 desktop. The glyph name is the locale-independent identity in
     * that generation, exactly as the path prefix was in the previous one, and a
     * theme may replace the artwork without renaming the symbol — so the name
     * survives the change that broke the geometry.
     */
    const TRIGGER_ICON_GLYPHS = ['project-add-outline']

    /** Sprite symbol id shape, as `iconSymbolId` composes it: `dsw-icon-<glyph>-<weight>`. */
    const SPRITE_ICON_ID = /^#?dsw-icon-(.+)-(?:regular|medium)$/

    /**
     * The row glyphs whose artwork is FILL-only, as sprite names.
     *
     * Only the fallback for a sprite symbol that is not in the document yet; the
     * live read (`isSolidIcon`) prefers the symbol's own geometry. Versions
     * qualify the id (`symbolId(glyph, weight)`), so the suffix is not part of a
     * glyph name and the match is on the glyph alone.
     */
    const SOLID_GLYPHS = ['folder-open']

    /** Namespace of every SVG node this half creates. */
    const SVG_NS = 'http://www.w3.org/2000/svg'

    /**
     * The cloud, as one closed path that renders in BOTH weights.
     *
     * The row swaps its own icon with the expansion state — collapsed renders
     * `IconFolderCloseRegular`, a 1px STROKED outline, and expanded renders
     * `IconFolderOpenRegular`, whose geometry is FILL-only. The cloud has to
     * match whichever one is showing, and a single closed path covers both:
     * stroked it is the outline, filled it is the solid. (A union of overlapping
     * shapes cannot be stroked without drawing the seams where they intersect,
     * which is why the filled form is this path rather than a set of circles.)
     *
     * The heavier lobe sits on the RIGHT (right high, left low), which is the
     * shape the operator asked for after reviewing the left-heavy first cut. It
     * sits in the shipped 16x16 grid at the folder's optical size: the cloud
     * spans x 1.4-14.6, y 3.5-13 against the folder's x 1.5-14.5, y 2.1-13.9.
     */
    const CLOUD_PATH = 'M11 13C12.8 13 14.2 11.6 14.2 9.9C14.2 8.3 12.9 7 11.3 6.8C10.8 4.9 9 3.5 6.9 3.5C4.8 3.5 3.1 5.1 2.8 7.1C1.9 7.6 1.4 8.5 1.4 9.5C1.4 11.4 2.9 13 4.8 13Z'

    /**
     * The leading folder slot of a workspace row, by CSS-module local name.
     *
     * Class tokens END with the local name — the convention the header-cluster
     * detection below already relies on — so `folderActive`, a separate token
     * on the same span, cannot match this.
     */
    const FOLDER_SLOT = /(^|_)folder$/

    /**
     * The copy language of everything this release adds.
     *
     * The catalog is bilingual, so the dialog can render a host failure in the
     * operator's language without a translation build step.
     */
    // ── 2. copy, theme and shared node helpers ─────────────────────────────
    const LOCALE = typeof navigator !== 'undefined' && /^zh/i.test(String(navigator.language ?? '')) ? 'zh' : 'en'

    /**
     * Pick one of two copies by the current language.
     * @param {string} zh - Chinese copy.
     * @param {string} en - English copy.
     * @returns {string} the selected copy.
     */
    function t(zh, en) {
      return LOCALE === 'zh' ? zh : en
    }

    /**
     * The older dialog copy, in one table so the whole W dialog is bilingual.
     *
     * The 0.6 surfaces above use `t(zh, en)` inline; these entries are older and
     * carry `{name}` placeholders, which `copy()` fills. Keeping them here means a
     * language sweep has one place to audit instead of 1,700 lines of literals.
     */
    const COPY = {
      trigger: { zh: '添加 WSL 工作区', en: 'Add a WSL workspace' },
      createRefused: { zh: '宿主拒绝创建会话', en: 'The host refused to create the session' },
      notADirectory: { zh: '{target} 不是一个存在的目录', en: '{target} is not an existing directory' },
      sessionHint: { zh: '新会话的 bash 与文件工具都会在该发行版里工作；Windows 文件可在 /mnt/<盘符> 下访问。', en: 'The new session runs bash and the file tools inside this distribution; Windows files are under /mnt/<drive>.' },
      distroLabel: { zh: '发行版', en: 'Distribution' },
      reading: { zh: '读取中…', en: 'Reading…' },
      noDistros: { zh: '没有可用的 WSL 发行版', en: 'No usable WSL distribution' },
      userHint: { zh: '输入要进入该发行版的用户；确认后直接落在其主目录。', en: 'Enter the user to enter this distribution as; the browser lands in their home.' },
      userPlaceholder: { zh: '留空 = 发行版默认用户', en: 'Leave blank for the distribution default user' },
      resolving: { zh: '解析中…', en: 'Resolving…' },
      confirmUser: { zh: '确认进入', en: 'Enter' },
      cancel: { zh: '取消', en: 'Cancel' },
      userHome: { zh: '用户 {user} · 主目录 {home}（可直接修改）', en: 'User {user} · home {home} (editable)' },
      pathPlaceholder: { zh: '/home/用户名/项目', en: '/home/user/project' },
      go: { zh: '前往', en: 'Go' },
      readingDir: { zh: '读取目录…', en: 'Reading the directory…' },
      noSubdirs: { zh: '没有子目录', en: 'No subdirectories' },
      parentDir: { zh: '.. 上级目录', en: '.. Parent directory' },
      working: { zh: '处理中…', en: 'Working…' },
      createOpen: { zh: '创建并打开', en: 'Create and open' },
      missingPrefix: { zh: '缺少：', en: 'Missing: ' },
      healthSummary: { zh: '环境检查：{pass} 项通过{warn}{fail}', en: 'Health check: {pass} passed{warn}{fail}' },
      healthWarn: { zh: '，{count} 项建议处理', en: ', {count} advisory' },
      healthFail: { zh: '，{count} 项失败', en: ', {count} failed' },
      dialogDescription: { zh: '从 WSL 发行版目录创建工作区。', en: 'Create a workspace from a WSL distribution directory.' },
      filterPlaceholder: { zh: '过滤当前目录…', en: 'Filter this directory…' },
      filterLabel: { zh: '按名称过滤目录', en: 'Filter directories by name' },
      filterEmpty: { zh: '没有匹配的子目录', en: 'No matching subdirectories' },
      retryList: { zh: '重试读取', en: 'Try again' },
    }

    /**
     * Look up one COPY entry and fill its `{name}` placeholders.
     * @param {string} key - the COPY key.
     * @param {Record<string, unknown>} [vars] - placeholder values.
     * @returns {string} the copy.
     */
    function copy(key, vars = {}) {
      const entry = COPY[key]
      const text = entry?.[LOCALE] ?? entry?.en ?? key
      return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
    }

    /** Accessible name and tooltip of the companion button. */
    const BUTTON_LABEL = copy('trigger')

    /** Inline style for text that screen readers get but the page does not show. */
    const VISUALLY_HIDDEN = {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0,0,0,0)',
      whiteSpace: 'nowrap',
      border: '0',
    }

    /** The open dialog's polite live region; null while no dialog is open. */
    let liveStatus = null

    /**
     * Announce a short status through the dialog's live region.
     * @param {string} text - the message.
     */
    function announce(text) {
      if (liveStatus === null) return
      liveStatus.textContent = ''
      liveStatus.textContent = text
    }

    /** Copy used only when the catalog itself could not be fetched. */
    const FALLBACK_MESSAGES = {
      transport: { zh: '连不上插件的本地路由。', en: 'The plugin route could not be reached.' },
      internal: { zh: '插件内部错误。', en: 'The plugin hit an internal error.' },
      'host-plugin-stale': { zh: '宿主半边还是旧版本，浏览器半边已经更新。', en: 'The host half is older than the browser half.' },
      'catalog-unavailable': { zh: '诊断目录暂时不可用，错误码仍然会显示。', en: 'The diagnostic catalog is unavailable; the code is still shown.' },
    }

    /** The public documentation base a catalog `doc` anchor resolves against. */
    const DOC_BASE = 'https://github.com/zcluo/dsh-wsl-desktop/blob/main/docs'

    /** Bilingual status words for the health rows. */
    const CHECK_STATUS_LABELS = {
      pass: { zh: '通过', en: 'passed' },
      warn: { zh: '建议处理', en: 'advisory' },
      fail: { zh: '失败', en: 'failed' },
      unknown: { zh: '未测量', en: 'unmeasured' },
      skip: { zh: '跳过', en: 'skipped' },
    }

    /** Chinese for the doctor's fixed detail vocabulary; unknown text falls through. */
    const DETAIL_ZH = {
      'found': '已找到',
      'command not found': '命令不存在',
      'version unreadable or below 3.8': '版本无法识别或低于 3.8',
      'not found': '未找到',
      'not found; the provider default shell is used': '未找到；将使用发行版默认 shell',
      'unshare, setpriv, findmnt and mount found': 'unshare、setpriv、findmnt、mount 均已找到',
      'not available': '不可用',
      'probe timed out': '探测超时',
      'supported': '支持',
      'unsupported by setpriv': '当前 setpriv 不支持',
      'unmeasured': '未测量',
      'not measured': '未测量',
      'not selected; the runner uses sudo-unshare': '未被选中；运行器使用 sudo-unshare',
      'not installed or not v1.3': '未安装或版本不是 v1.3',
    }

    /**
     * Localise one doctor detail line.
     * @param {unknown} detail - the host's short fact.
     * @returns {unknown} the Chinese text, or the original when it is dynamic/unknown.
     */
    function localizeDetail(detail) {
      if (LOCALE !== 'zh' || typeof detail !== 'string') return detail
      if (detail.startsWith('missing: ')) return `${copy('missingPrefix')}${detail.slice('missing: '.length)}`
      // Version strings carry their own identity (Python x.y, dsh-wsl-confine v1.3).
      if (detail.startsWith('Python ') || detail.startsWith('dsh-wsl-confine ')) return detail
      return DETAIL_ZH[detail] ?? detail
    }

    /** How long one bootstrap answer is reused by this page. */
    const BOOTSTRAP_TTL_MS = 5 * 60 * 1000

    /** Theme tokens of the running composition. */
    const T = {
      surface: 'var(--dsw-alias-bg-overlay, #26262b)',
      layer: 'var(--dsw-alias-bg-layer-2, #2f2f35)',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
      label: 'var(--dsw-alias-label-primary, #eaeaea)',
      dim: 'var(--dsw-alias-label-secondary, rgba(234,234,234,0.66))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14))',
      accent: 'var(--dsw-alias-brand-primary, #4f8cff)',
      error: 'var(--dsw-alias-state-error-primary, #ff8a80)',
    }

    const BUTTON_STYLE = {
      padding: '6px 14px',
      borderRadius: '6px',
      border: `1px solid ${T.border}`,
      background: 'transparent',
      color: T.label,
      font: 'inherit',
      cursor: 'pointer',
    }

    const PRIMARY_STYLE = { ...BUTTON_STYLE, borderColor: T.accent, color: T.accent, fontWeight: '600' }

    const FIELD_STYLE = {
      flex: '1',
      padding: '6px 10px',
      borderRadius: '6px',
      border: `1px solid ${T.border}`,
      background: T.layer,
      color: T.label,
      font: 'inherit',
    }

    const OVERLAY_STYLE = {
      position: 'fixed',
      inset: '0',
      zIndex: '9999',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.45)',
      color: T.label,
    }

    const CARD_STYLE = {
      width: '560px',
      maxWidth: '90vw',
      maxHeight: '76vh',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '20px',
      borderRadius: '12px',
      border: `1px solid ${T.border}`,
      background: T.surface,
      color: T.label,
      font: 'inherit',
      boxShadow: '0 18px 48px rgba(0,0,0,0.45)',
    }

    /**
     * One code-carrying failure.
     * @param {string} method - the method that failed.
     * @param {number} status - the HTTP status, or 0 when no response arrived.
     * @param {object|null} envelope - the route's JSON body, when it parsed.
     * @returns {Error} the failure, with `code` and `params` attached.
     */
    // ── 3. route calls and failure rendering ─────────────────────────────
    function routeFailure(method, status, envelope) {
      const error = new Error(envelope?.error ?? `${method} failed (HTTP ${status})`)
      error.code = typeof envelope?.code === 'string' ? envelope.code : status === 0 ? 'transport' : 'internal'
      error.params = envelope !== null && typeof envelope?.params === 'object' && envelope?.params !== null
        ? envelope.params
        : {}
      return error
    }

    /**
     * Perform one host call and unwrap the envelope.
     * @param {string} method - host method name.
     * @param {object} [params] - method payload.
     * @returns {Promise<any>} the unwrapped value.
     */
    async function call(method, params = {}) {
      let response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, params }),
        })
      } catch (cause) {
        const error = routeFailure(method, 0, null)
        error.cause = cause
        throw error
      }
      // The route answers non-JSON for a refused or malformed request (401 from
      // the trust fence, 415 for a bad media type, 405 for a wrong method), so
      // the status is read before the body is parsed.
      let envelope = null
      try {
        envelope = await response.json()
      } catch {
        throw routeFailure(method, response.status, null)
      }
      if (envelope?.ok !== true) throw routeFailure(method, response.status, envelope)
      return envelope.value
    }

    /**
     * Keep only the wire facts a render needs.
     * @param {unknown} failure - the thrown value.
     * @returns {{code: string, params: Record<string, unknown>}} the facts.
     */
    function failureOf(failure) {
      const code = typeof failure?.code === 'string' ? failure.code : 'internal'
      const params = failure?.params !== null && typeof failure?.params === 'object' ? failure.params : {}
      return { code, params }
    }

    /**
     * Wait one short period.
     * @param {number} ms - milliseconds.
     * @returns {Promise<void>} settlement.
     */
    function delay(ms) {
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    }


    /**
     * Create the workspace's session with the WSL preset named in the request.
     *
     * The client service wrapper (`ctx.sessions.create`) rebuilds its payload
     * from `workspaceId | cwd | sessionId` alone and silently DROPS
     * `agentPreset`, even though the Host's `SessionCreateRequest` accepts it
     * and the generated remote `session.create(request)` forwards it. The
     * dropped field is invisible: the session is created on the default preset,
     * and only the `api-session/added` fallback on the host half rescues it —
     * and that fallback is refused once the session has taken a turn.
     *
     * Naming the preset at creation is the only race-free seam, so the create
     * goes through the remote contract that carries it. The service wrapper is
     * kept as the fallback for a host whose remote surface does not expose
     * `session.create`; the session list updates from the host's own
     * `api-session/added` event either way.
     * @param {object} ctx - the client plugin context.
     * @param {string} workspaceId - workspace the session belongs to.
     * @param {string} agentPreset - the WSL variant id to compose.
     * @returns {Promise<string>} the new session id.
     */
    async function createBoundSession(ctx, workspaceId, agentPreset) {
      const create = ctx.remote?.session?.create
      if (typeof create !== 'function') return ctx.sessions.create({ workspaceId })
      const result = await create({ workspaceId, agentPreset })
      if (result?.ok !== true) throw new Error(result?.error?.message ?? copy('createRefused'))
      return result.value.sessionId
    }

    /** The cached bootstrap answer, and the call in flight. */
    let bootstrapCache = null
    let bootstrapInflight = null

    /**
     * Fetch the catalog and the capability state once per page, retrying one failure.
     *
     * An `unknown-method` here means the browser half is newer than the host half: the
     * route exists, but the method does not. That is reported as `host-plugin-stale`
     * rather than as a generic failure, because the fix is "restart the desktop".
     * @param {boolean} [force] - ignore the cached answer.
     * @returns {Promise<{ok: true, value: object} | {ok: false, failure: {code: string, params: object}}>} the result.
     */
    async function bootstrapOnce(force = false) {
      if (!force && bootstrapCache !== null && Date.now() - bootstrapCache.at < BOOTSTRAP_TTL_MS) {
        return bootstrapCache.value
      }
      if (bootstrapInflight !== null) return bootstrapInflight
      const attempt = async () => {
        try {
          return { ok: true, value: await call('bootstrap') }
        } catch (failure) {
          if (failure?.code === 'unknown-method') failure.code = 'host-plugin-stale'
          return { ok: false, failure: failureOf(failure) }
        }
      }
      bootstrapInflight = (async () => {
        let result = await attempt()
        if (!result.ok) {
          await delay(500)
          result = await attempt()
        }
        // Only a fully-ok answer is a fact worth reusing. A pending or degraded
        // answer is a phase: caching it would freeze a transient boot state for
        // five minutes and hide the retry.
        if (result.ok && result.value?.capabilities?.status === 'ok') {
          bootstrapCache = { at: Date.now(), value: result }
        }
        return result
      })().finally(() => {
        bootstrapInflight = null
      })
      return bootstrapInflight
    }

    /**
     * Resolve one dotted client path.
     * @param {object} root - the client context.
     * @param {string[]} path - the segments.
     * @returns {boolean} whether every hop is present.
     */
    function resolveClientPath(root, path) {
      let value = root
      for (const segment of path) {
        if (value === null || value === undefined) return false
        value = value[segment]
      }
      return value !== undefined && value !== null
    }

    /**
     * Probe the browser-side symbols the host served.
     * @param {object} ctx - the client context.
     * @param {object|null} catalog - the bootstrap catalog.
     * @returns {{features: Record<string, string>, missing: object[]}} the outcome.
     */
    function clientFeatureStatus(ctx, catalog) {
      const symbols = Array.isArray(catalog?.clientSymbols) ? catalog.clientSymbols : []
      const features = {}
      const missing = []
      for (const feature of catalog?.features ?? []) {
        const required = symbols.filter((symbol) => symbol.feature === feature && symbol.required !== false)
        if (required.length === 0) {
          features[feature] = 'unknown'
          continue
        }
        const absent = required.filter((symbol) => !resolveClientPath(ctx, symbol.path))
        features[feature] = absent.length === 0 ? 'ok' : 'degraded'
        for (const symbol of absent) missing.push({ id: symbol.id, feature })
      }
      return { features, missing }
    }

    /**
     * Merge the host's feature status with the browser's.
     *
     * A side with no symbol for a feature reports `unknown`, which means "not mine",
     * not "degraded"; only a side that actually has symbols decides the feature.
     * @param {string} feature - the feature id.
     * @param {Record<string, string>} hostFeatures - the host probe's features.
     * @param {Record<string, string>} clientFeatures - the browser probe's features.
     * @param {object|null} catalog - the bootstrap catalog.
     * @returns {string} ok, degraded or unknown.
     */
    function mergeFeature(feature, hostFeatures, clientFeatures, catalog) {
      const hostStatus = typeof hostFeatures?.[feature] === 'string' ? hostFeatures[feature] : 'unknown'
      const clientHas = (catalog?.clientSymbols ?? []).some((symbol) => symbol.feature === feature)
      const relevant = []
      if (clientHas && typeof clientFeatures[feature] === 'string') relevant.push(clientFeatures[feature])
      if (hostStatus !== 'unknown') relevant.push(hostStatus)
      if (relevant.includes('degraded')) return 'degraded'
      if (relevant.includes('unknown')) return 'unknown'
      return relevant.length === 0 ? 'unknown' : 'ok'
    }

    /**
     * Render one remedy.
     * @param {object|null} remedy - a catalog remedy.
     * @returns {HTMLElement|null} the node, or null when there is nothing to render.
     */
    function renderRemedy(remedy) {
      if (remedy === null || typeof remedy !== 'object') return null
      if (remedy.kind === 'command') {
        const row = el('div', { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' })
        row.append(el('code', {
          fontSize: '11px',
          padding: '2px 6px',
          borderRadius: '4px',
          background: T.surface,
        }, String(remedy.value ?? '')))
        const copy = el('button', { ...BUTTON_STYLE, padding: '2px 8px', fontSize: '11px' }, t('复制', 'Copy'))
        copy.type = 'button'
        copy.addEventListener('click', () => {
          void navigator.clipboard?.writeText?.(String(remedy.value ?? ''))
          copy.textContent = t('已复制', 'Copied')
          announce(t('已复制', 'Copied'))
        })
        row.append(copy)
        return row
      }
      if (remedy.kind === 'link' && typeof remedy.href === 'string') {
        const link = el('a', { fontSize: '11px', color: T.accent }, t('查看文档', 'Open the docs'))
        link.href = remedy.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        return link
      }
      if (remedy.kind === 'text') {
        return el('div', { fontSize: '11px', color: T.dim }, remedy[LOCALE] ?? remedy.en ?? '')
      }
      return null
    }

    /**
     * Render one coded failure from the catalog, with its remedy.
     * @param {{code: string, params: object}|null} failure - the wire facts.
     * @param {object|null} bootstrap - the bootstrap result.
     * @returns {HTMLElement|null} the node.
     */
    function renderFailureNode(failure, bootstrap, state = null) {
      if (failure === null) return null
      const catalog = bootstrap?.ok === true ? bootstrap.value?.catalog : null
      const entry = catalog?.codes?.[failure.code]
      const copy = entry?.[LOCALE] ?? FALLBACK_MESSAGES[failure.code]?.[LOCALE]
        ?? t('插件内部错误。', 'The plugin hit an internal error.')
      const box = el('div', { fontSize: '12px', color: T.error, display: 'flex', flexDirection: 'column', gap: '4px' })
      box.setAttribute('role', 'alert')
      box.setAttribute('aria-live', 'assertive')
      box.setAttribute('data-wsl-error', failure.code)
      box.append(el('div', {}, copy))
      const remedy = entry === undefined ? null : renderRemedy(entry.remedy)
      if (remedy !== null) box.append(remedy)
      const params = failure.params ?? {}
      const ref = failure.code === 'internal' && typeof params.ref === 'string' ? params.ref : null
      if (ref !== null) {
        const row = el('div', { display: 'flex', gap: '6px', alignItems: 'center' })
        row.append(el('code', {
          fontSize: '11px',
          padding: '2px 6px',
          borderRadius: '4px',
          background: T.surface,
        }, ref))
        const copyRef = el('button', { ...BUTTON_STYLE, padding: '2px 8px', fontSize: '11px' }, t('复制 ref', 'Copy ref'))
        copyRef.type = 'button'
        copyRef.addEventListener('click', () => {
          void navigator.clipboard?.writeText?.(ref)
          copyRef.textContent = t('已复制', 'Copied')
          announce(t('已复制', 'Copied'))
        })
        row.append(copyRef)
        box.append(row)
      }
      for (const [key, value] of Object.entries(params)) {
        if (key === 'ref' && ref !== null) continue
        box.append(el('div', { fontSize: '11px', color: T.dim }, `${key}: ${String(value)}`))
      }
      if (typeof entry?.doc === 'string') {
        const docsBase = typeof bootstrap?.value?.docsBase === 'string' ? bootstrap.value.docsBase : DOC_BASE
        const link = el('a', { fontSize: '11px', color: T.accent }, t('查看诊断', 'Open diagnostics'))
        link.href = `${docsBase}/${entry.doc}`
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        box.append(link)
      }
      box.append(el('div', { fontSize: '11px', color: T.dim }, failure.code))
      if (state !== null) {
        // A failed browse or commit used to offer no report at all; only the
        // degraded card did. The same report is now one click away on every
        // failure, with the same redaction rules.
        const copyAll = el('button', { ...BUTTON_STYLE, padding: '2px 8px', fontSize: '11px', alignSelf: 'flex-start' },
          t('复制诊断', 'Copy diagnostics'))
        copyAll.type = 'button'
        copyAll.setAttribute('data-wsl-diagnostics', '')
        copyAll.addEventListener('click', () => {
          void navigator.clipboard?.writeText?.(buildDiagnostics(state, failure))
          copyAll.textContent = t('已复制', 'Copied')
          announce(t('已复制', 'Copied'))
        })
        box.append(copyAll)
      }
      return box
    }

    /**
     * Build the copyable diagnostic report.
     *
     * Deliberately excludes the host message, stderr, resolved paths and the raw
     * failure text: it carries only what the catalog already exposes plus the
     * doctor's path-free facts. A failure is described by its code and params.
     * @param {object} state - the open picker's state.
     * @param {object|null} [failure] - the failure to include, if any.
     * @returns {string} pretty JSON.
     */
    function buildDiagnostics(state, failure = null) {
      const bootstrap = state.bootstrap
      const value = bootstrap?.ok === true ? bootstrap.value : null
      const health = state.health?.status === 'ready'
        ? {
          distro: state.health.distro ?? state.distro,
          user: state.health.user ?? state.user,
          family: state.health.family ?? null,
          runner: state.health.runner ?? null,
          restricted: state.health.restricted ?? null,
          checks: (state.health.checks ?? []).map((entry) => ({
            id: entry.id,
            status: entry.status,
            ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
          })),
        }
        : null
      return JSON.stringify({
        schema: 1,
        locale: LOCALE,
        pluginVersion: value?.pluginVersion ?? 'unknown',
        catalog: value === null ? 'unavailable' : 'loaded',
        capabilities: value?.capabilities ?? null,
        features: state.features,
        missing: state.missing,
        health,
        error: failure === null ? null : { code: failure.code, params: failure.params ?? {} },
      }, null, 2)
    }

    /**
     * The degraded card: what is missing, what to do, and a copyable report.
     * @param {object[]} body - the card's child list.
     * @param {object} state - the open picker's state.
     * @param {() => void} onClose - the picker's close.
     */
    function renderDegraded(body, state, onClose, onRetry) {
      const catalog = state.bootstrap?.ok === true ? state.bootstrap.value?.catalog : null
      const panel = el('div', {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        borderRadius: '8px',
        border: `1px solid ${T.border}`,
        background: T.layer,
      })
      panel.setAttribute('data-wsl-degraded', state.degraded.join(','))
      panel.tabIndex = -1
      panel.append(el('div', { fontSize: '14px', fontWeight: '600' }, t('插件已降级', 'The plugin is degraded')))
      panel.append(el('div', { fontSize: '12px', color: T.dim },
        t('当前桌面版本缺少插件依赖的宿主能力。能工作的部分会继续工作。',
          'This desktop version lacks a host capability the plugin depends on. The working parts keep working.')))
      for (const feature of state.degraded) {
        const label = catalog?.featureLabels?.[feature]?.[LOCALE] ?? feature
        panel.append(el('div', { fontSize: '12px' }, `• ${label}`))
      }
      const entry = catalog?.codes?.['host-capability-missing']
      const remedy = entry === undefined ? null : renderRemedy(entry.remedy)
      if (remedy !== null) panel.append(remedy)
      const diagnostics = buildDiagnostics(state)
      panel.append(el('pre', {
        margin: '0',
        padding: '8px',
        borderRadius: '6px',
        background: T.surface,
        color: T.dim,
        fontSize: '11px',
        overflow: 'auto',
        maxHeight: '120px',
      }, diagnostics))
      const copy = el('button', BUTTON_STYLE, t('复制诊断', 'Copy diagnostics'))
      copy.type = 'button'
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText?.(diagnostics)
        copy.textContent = t('已复制', 'Copied')
        announce(t('已复制', 'Copied'))
      })
      panel.append(copy)
      if (typeof onRetry === 'function') {
        const retry = el('button', BUTTON_STYLE, t('重新检查', 'Check again'))
        retry.type = 'button'
        retry.setAttribute('data-wsl-degraded-retry', '')
        retry.addEventListener('click', () => { onRetry() })
        panel.append(retry)
      }
      const closeButton = el('button', { ...PRIMARY_STYLE, alignSelf: 'flex-end' }, t('关闭', 'Close'))
      closeButton.type = 'button'
      closeButton.addEventListener('click', () => { onClose() })
      panel.append(closeButton)
      body.push(panel)
    }


    /**
     * Parent of a Linux path.
     *
     * The operator's spelling is normalised to absolute FIRST, mirroring what the
     * host does with the same string (world.js listLinuxDir prefixes '/'). Without
     * it a relative spelling produced a character-trimmed path: 'tmp' has no '/',
     * so lastIndexOf returned -1 and slice(0, -1) gave 'hom'/'tm' — the host
     * listed /tmp while the "up" button navigated to /tm.
     */
    // ── 4. the W workspace picker dialog ─────────────────────────────
    function parentOf(path) {
      const absolute = path.startsWith('/') ? path : `/${path}`
      const trimmed = absolute.replace(/\/+$/, '')
      if (trimmed === '' || trimmed === '/') return null
      return trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
    }

    /** Join one Linux segment onto a directory. */
    function joinLinux(path, name) {
      return path === '/' ? `/${name}` : `${path.replace(/\/+$/, '')}/${name}`
    }

    /**
     * Build one element.
     * @param {string} tag - element name.
     * @param {object} [style] - inline style declarations.
     * @param {...(Node|string|null|false|undefined)} children - text or elements to append.
     * @returns {HTMLElement} the built element.
     */
    function el(tag, style, ...children) {
      const node = document.createElement(tag)
      if (style !== undefined) Object.assign(node.style, style)
      for (const child of children) {
        if (child === null || child === undefined || child === false) continue
        node.append(typeof child === 'string' ? document.createTextNode(child) : child)
      }
      return node
    }

    /** The open picker's teardown, or null while none is open. */
    let teardown = null

    /**
     * Open the WSL workspace picker and adopt the chosen directory.
     * @param {object} ctx - the client plugin context (`workspaces`, `uiWorkspace`).
     */
    function openPicker(ctx) {
      if (teardown !== null) return
      // The element that opened the dialog; focus returns here when it closes.
      const opener = companion.button?.isConnected === true
        ? companion.button
        : companion.fallback ?? null
      const state = {
        distros: null,
        distro: null,
        /**
         * The gate: pick the distribution user before any browsing happens.
         * `loading` while the bootstrap answer is in flight, `degraded` when the
         * picker's required capabilities are missing.
         */
        phase: 'loading',
        /** The bootstrap result: `{ok,value}` or `{ok:false,failure}`. */
        bootstrap: null,
        /** A bootstrap failure shown above the gate, when the catalog is unavailable. */
        bootstrapError: null,
        /** Merged feature statuses, and the symbols missing from either side. */
        features: {},
        missing: [],
        degraded: [],
        /** The doctor's answer: null, or {status:'loading'|'ready'|'error', ...}. */
        health: null,
        healthOpen: false,
        healthToken: 0,
        userDraft: '',
        pending: false,
        /** The confirmed distribution user and their home, once resolved. */
        user: null,
        home: null,
        path: '/',
        draft: '/',
        /** Case-insensitive substring filter for the current directory. */
        filter: '',
        listing: null,
        /** `{code, params}` or null; the raw host message is never rendered. */
        error: null,
        working: false,
        closed: false,
        token: 0,
      }
      const overlay = el('div', OVERLAY_STYLE)
      const card = el('div', CARD_STYLE)
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-label', BUTTON_LABEL)
      const description = el('div', VISUALLY_HIDDEN, copy('dialogDescription'))
      description.id = 'wsl-dialog-description'
      overlay.setAttribute('aria-describedby', description.id)
      const status = el('div', VISUALLY_HIDDEN, '')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      liveStatus = status
      overlay.append(description, card, status)
      overlay.addEventListener('click', () => { close() })
      card.addEventListener('click', (event) => { event.stopPropagation() })

      /**
       * Close the picker and release its listeners.
       * A commit in flight owns the outcome: closing mid-commit would let the
       * workspace be created and a session opened after the operator cancelled.
       */
      function close() {
        // The guard is the ONLY difference from forceClose(); the teardown itself is
        // that function's, so the two cannot drift apart.
        if (state.closed || state.working) return
        forceClose()
      }

      /** Close the picker regardless of an in-flight commit, once it settles. */
      function forceClose() {
        state.closed = true
        state.token += 1
        liveStatus = null
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        opener?.setAttribute?.('aria-expanded', 'false')
        // The dialog was opened from the W button (or its fallback entry); a
        // keyboard user should land back where they started.
        if (opener?.isConnected === true) opener.focus()
        teardown = null
      }

      /** The focusable controls inside the dialog, in document order. */
      function focusables() {
        return [...overlay.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      }

      function onKey(event) {
        if (event.key === 'Escape') {
          close()
          return
        }
        if (event.key !== 'Tab') return
        // A modal dialog owns the keyboard: Tab from the last control wraps to the
        // first and Shift+Tab from the first wraps to the last, so focus cannot
        // escape into the page behind the overlay.
        const focusable = focusables()
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        } else if (!overlay.contains(document.activeElement)) {
          event.preventDefault()
          first.focus()
        }
      }

      /** Discover distributions only after the capability gate has cleared. */
      async function discover() {
        try {
          const names = await call('listDistros')
          if (state.closed) return
          state.distros = names
          const fallback = await call('defaultDistro').catch(() => ({ distro: null }))
          if (state.closed) return
          const selected = names.includes(fallback.distro) ? fallback.distro : names[0] ?? null
          if (selected === null) {
            render()
            return
          }
          chooseDistro(selected)
        } catch (failure) {
          if (state.closed) return
          state.error = failureOf(failure)
          render()
        }
      }

      /**
       * Bootstrap the catalog and capability state, then gate or discover.
       *
       * A `pending` capability answer is retried once after a second: the host may
       * still be resolving its preset registry. A still-pending answer is treated as
       * unknown, not degraded, because the picker can still be attempted.
       */
      async function initialize(force = false) {
        const startedAt = Date.now()
        let boot = await bootstrapOnce(force)
        if (state.closed) return
        // When the host already burned its full readiness budget, a second call
        // would only wait the same five seconds again; treat the pending answer as
        // unknown and let the picker proceed instead of an ~11s dialog.
        if (boot.ok && boot.value?.capabilities?.status === 'pending' && Date.now() - startedAt < 4_000) {
          await delay(1_000)
          if (state.closed) return
          boot = await bootstrapOnce(true)
          if (state.closed) return
        }
        state.bootstrap = boot
        if (!boot.ok) {
          state.bootstrapError = boot.failure
          state.phase = 'pick-user'
          render()
          await discover()
          return
        }
        const catalog = boot.value?.catalog ?? {}
        const client = clientFeatureStatus(ctx, catalog)
        const host = boot.value?.capabilities?.features ?? {}
        const features = {}
        for (const feature of catalog.features ?? []) {
          features[feature] = mergeFeature(feature, host, client.features, catalog)
        }
        state.features = features
        state.missing = [...(boot.value?.capabilities?.missing ?? []), ...client.missing]
        const degraded = ['picker', 'preset-generation', 'session-create']
          .filter((feature) => features[feature] === 'degraded')
        if (degraded.length > 0) {
          state.degraded = degraded
          state.phase = 'degraded'
          render()
          const panel = card.querySelector('[data-wsl-degraded]')
          if (panel !== null) panel.focus()
          return
        }
        state.phase = 'pick-user'
        render()
        await discover()
      }

      /** Force a fresh bootstrap after the degraded card asked for it. */
      function retryDegraded() {
        state.bootstrap = null
        state.bootstrapError = null
        state.degraded = []
        state.phase = 'loading'
        render()
        void initialize(true)
      }

      /**
       * Ask the doctor for the selected distro, without blocking the browser.
       *
       * Advisory by construction: a failure fills the strip with a coded error, and
       * no path below consults it before enabling "创建并打开".
       */
      async function loadHealth() {
        if (state.distro === null) return
        const token = state.healthToken += 1
        state.health = { status: 'loading' }
        state.healthOpen = false
        render()
        try {
          const data = await call('health', {
            distro: state.distro,
            ...(state.user !== null ? { username: state.user } : {}),
          })
          if (state.closed || token !== state.healthToken) return
          state.health = { status: 'ready', data }
        } catch (failure) {
          if (state.closed || token !== state.healthToken) return
          state.health = { status: 'error', failure: failureOf(failure) }
        }
        render()
      }

      /**
       * The advisory strip above the path field.
       * @param {object[]} body - the card's child list.
       */
      function renderHealthStrip(body) {
        if (state.health === null) return
        const strip = el('div', {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '8px',
          borderRadius: '6px',
          border: `1px solid ${T.border}`,
          background: T.layer,
        })
        if (state.health.status === 'loading') {
          strip.setAttribute('data-wsl-health', 'loading')
          strip.setAttribute('role', 'status')
      strip.setAttribute('aria-live', 'polite')
          strip.append(el('div', { fontSize: '12px', color: T.dim }, t('环境检查：检查中…', 'Health check: running…')))
          body.push(strip)
          return
        }
        if (state.health.status === 'error') {
          strip.setAttribute('data-wsl-health', 'error')
          const failure = renderFailureNode(state.health.failure, state.bootstrap, state)
          if (failure !== null) strip.append(failure)
          const retry = el('button', {
            ...BUTTON_STYLE,
            padding: '2px 8px',
            fontSize: '11px',
            alignSelf: 'flex-start',
          }, t('重试', 'Retry'))
          retry.type = 'button'
          retry.addEventListener('click', () => { void loadHealth() })
          strip.append(retry)
          body.push(strip)
          return
        }
        const data = state.health.data
        const checks = Array.isArray(data?.checks) ? data.checks : []
        const counts = { pass: 0, warn: 0, fail: 0, unknown: 0, skip: 0 }
        for (const check of checks) {
          if (counts[check.status] !== undefined) counts[check.status] += 1
        }
        strip.setAttribute('data-wsl-health', `${counts.pass},${counts.warn},${counts.fail}`)
        const measured = checks.some((check) => check.status !== 'unknown')
        const summary = el('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' })
        summary.append(el('span', { fontSize: '12px', color: counts.fail > 0 ? T.error : T.dim },
          copy('healthSummary', {
            pass: counts.pass,
            warn: counts.warn > 0 ? copy('healthWarn', { count: counts.warn }) : '',
            fail: counts.fail > 0 ? copy('healthFail', { count: counts.fail }) : '',
          })))
        const toggle = el('button', { ...BUTTON_STYLE, padding: '2px 8px', fontSize: '11px' },
          state.healthOpen ? t('收起', 'Hide') : t('展开', 'Details'))
        toggle.type = 'button'
        toggle.setAttribute('data-wsl-health-toggle', '')
        toggle.setAttribute('aria-expanded', state.healthOpen ? 'true' : 'false')
        toggle.addEventListener('click', () => {
          state.healthOpen = !state.healthOpen
          render()
          card.querySelector('[data-wsl-health-toggle]')?.focus()
        })
        summary.append(toggle)
        strip.append(summary)
        if (measured && data?.restricted !== true) {
          strip.append(el('div', { fontSize: '11px', color: T.dim },
            t('受限模式不可用；danger-full-access 仍可创建。',
              'Restricted mode is unavailable; danger-full-access can still create.')))
        }
        if (state.healthOpen) {
          const rows = el('div', { display: 'flex', flexDirection: 'column', gap: '4px' })
          const labels = state.bootstrap?.ok === true ? state.bootstrap.value?.catalog?.checkLabels : null
          for (const check of checks) {
            const label = labels?.[check.id]?.[LOCALE] ?? check.id
            const status = (CHECK_STATUS_LABELS[check.status] ?? { zh: check.status, en: check.status })[LOCALE]
            const detail = localizeDetail(check.detail)
            const row = el('div', { display: 'flex', flexDirection: 'column', gap: '2px' })
            row.append(el('div', {
              fontSize: '12px',
              color: check.status === 'fail' ? T.error : T.label,
            }, `${label} · ${status}${typeof detail === 'string' ? ` — ${detail}` : ''}`))
            const remedy = renderRemedy(check.remedy)
            if (remedy !== null && (check.status === 'warn' || check.status === 'fail' || check.status === 'unknown')) {
              row.append(remedy)
            }
            rows.append(row)
          }
          strip.append(rows)
        }
        body.push(strip)
      }

      /** Load the current directory of the selected distribution. */
      async function load() {
        if (state.distro === null) return
        const token = state.token += 1
        state.listing = null
        state.error = null
        render()
        try {
          const listing = await call('listDir', { distro: state.distro, path: state.path })
          if (token !== state.token) return
          state.listing = listing
        } catch (failure) {
          if (token !== state.token) return
          state.error = failureOf(failure)
        }
        render()
      }

      /** Navigate to a path and keep the text field in step. */
      function go(path) {
        state.path = path
        state.draft = path
        void load()
      }

      /**
       * Select a distribution and gate on the user to enter as.
       *
       * Switching distros re-prompts, carrying the last confirmed user as a
       * starting point; an empty field means the distribution's default user.
       * No resolution happens here: the gate's confirm button is the one place
       * `resolveHome` runs.
       */
      function chooseDistro(name) {
        // A commit in flight owns the outcome, exactly like `close()`: a
        // mid-commit re-pick would repaint the gate only for the settling
        // commit to tear it down and open the session.
        if (state.working) return
        state.distro = name
        state.phase = 'pick-user'
        // Carry the last confirmed user; with none confirmed yet, preserve
        // whatever the operator typed while discovery was settling instead of
        // wiping it.
        state.userDraft = state.user ?? (state.userDraft || '')
        state.listing = null
        state.error = null
        // A re-pick supersedes any in-flight home resolution; without this the
        // abandoned confirm's `pending` would stay true and the fresh gate
        // would render permanently disabled (its result is dropped by the
        // token marker below).
        state.pending = false
        state.token += 1
        render()
      }

      /**
       * Resolve the entered user's home and enter the browse phase at it.
       *
       * The user is answered by the distribution's own user database, so an
       * unknown name fails right here in the gate with the host's error —
       * browsing never opens on a guess. The path is not asked for: it is the
       * user's home, editable afterwards like any other path.
       */
      async function confirmUser() {
        if (state.pending || state.distro === null) return
        const name = state.userDraft.trim()
        state.pending = true
        state.error = null
        const marker = state.token += 1
        render()
        try {
          const resolved = await call('resolveHome', { distro: state.distro, ...(name !== '' ? { username: name } : {}) })
          if (state.closed || marker !== state.token) return
          state.user = resolved.user
          state.home = resolved.home
          state.pending = false
          state.phase = 'browse'
          go(resolved.home)
          void loadHealth()
        } catch (failure) {
          if (state.closed || marker !== state.token) return
          state.error = failureOf(failure)
          state.pending = false
          render()
        }
      }

      /** Validate the chosen directory, register the workspace, open its session. */
      async function commit() {
        if (state.working || state.distro === null) return
        // The field is the operator's intent; navigating only moves `path`.
        const target = state.draft
        state.working = true
        state.error = null
        render()
        try {
          const facts = await call('checkPath', { distro: state.distro, path: target })
          if (facts.isDirectory !== true) {
            throw Object.assign(new Error(copy('notADirectory', { target })), {
              code: 'path-not-directory',
              params: { path: target },
            })
          }
          const workspace = await ctx.workspaces.create({ path: facts.uncPath })
          // The harness fixes a session's preset at creation, so the execution
          // world has to be named in the create request: binding afterwards is
          // refused for any session that has already taken a turn, and the
          // session then runs in the host world while looking correct.
          const preset = await call('wslPresetFor', {})
          const sessionId = await createBoundSession(ctx, workspace.workspaceId, preset.agentPreset)
          if (state.closed) return
          forceClose()
          ctx.uiWorkspace.openSession(sessionId)
        } catch (failure) {
          if (state.closed) return
          state.error = failureOf(failure)
          state.working = false
          render()
        }
      }

      /** One distribution pill. */
      function pill(name) {
        const active = name === state.distro
        const node = el('button', {
          ...BUTTON_STYLE,
          padding: '4px 10px',
          borderColor: active ? T.accent : T.border,
          color: active ? T.accent : T.label,
          background: active ? T.layer : 'transparent',
          // Same ownership rule as `close()`: while a commit is in flight the
          // outcome belongs to it, so re-picking is refused at the source.
          opacity: state.working ? '0.6' : '1',
        }, name)
        node.type = 'button'
        node.disabled = state.working
        node.addEventListener('click', () => { chooseDistro(name) })
        return node
      }

      /** A flat text button inside the breadcrumb row. */
      function crumb(label, onClick) {
        const node = el('button', {
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          padding: '0',
        }, label)
        node.type = 'button'
        node.addEventListener('click', onClick)
        return node
      }

      /** The phase whose primary field last took focus. */
      let renderedPhase = null
      /** The last error the rendered state carried, so a fresh error re-focuses. */
      let renderedError = null

      /** Repaint the whole card from `state`. */
      function render() {
        const body = []

        body.push(el('div', { fontSize: '15px', fontWeight: '600' }, BUTTON_LABEL))
        body.push(el('div', { fontSize: '12px', color: T.dim }, copy('sessionHint')))

        if (state.phase === 'loading') {
          const status = el('div', { fontSize: '12px', color: T.dim }, t('检查插件状态…', 'Checking the plugin…'))
          status.setAttribute('role', 'status')
          body.push(status)
        } else if (state.phase === 'degraded') {
          renderDegraded(body, state, close, retryDegraded)
        } else {
          if (state.bootstrapError !== null) {
            const failure = renderFailureNode(state.bootstrapError, state.bootstrap, state)
            if (failure !== null) body.push(failure)
          }

          const distros = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' })
        distros.append(el('span', { fontSize: '12px', color: T.dim }, copy('distroLabel')))
        if (state.distros === null) {
          distros.append(el('span', { fontSize: '12px', color: T.dim }, copy('reading')))
        } else if (state.distros.length === 0) {
          distros.append(el('span', { fontSize: '12px', color: T.error }, copy('noDistros')))
        } else {
          for (const name of state.distros) distros.append(pill(name))
        }
        body.push(distros)

        if (state.phase === 'pick-user') {
          // The user gate: no browsing until the distribution user is named.
          // An empty field means the distribution's default user; an unknown
          // user fails right here instead of opening the browser on a guess.
          body.push(el('div', { fontSize: '12px', color: T.dim }, copy('userHint')))
          const userField = el('input', FIELD_STYLE)
          userField.value = state.userDraft
          userField.placeholder = copy('userPlaceholder')
          userField.addEventListener('input', () => { state.userDraft = userField.value })
          userField.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && state.distro !== null) void confirmUser()
          })
          const enter = el('button', {
            ...PRIMARY_STYLE,
            opacity: state.pending ? '0.6' : '1',
          }, state.pending ? copy('resolving') : copy('confirmUser'))
          enter.type = 'button'
          enter.setAttribute('data-wsl-action', 'confirm-user')
          enter.disabled = state.pending || state.distro === null
          enter.addEventListener('click', () => { void confirmUser() })
          body.push(el('div', { display: 'flex', gap: '8px' }, userField, enter))

          if (state.error !== null) {
            const failure = renderFailureNode(state.error, state.bootstrap, state)
            if (failure !== null) body.push(failure)
          }

          const cancel = el('button', BUTTON_STYLE, copy('cancel'))
          cancel.type = 'button'
          cancel.addEventListener('click', () => { close() })
          body.push(el('div', { display: 'flex', justifyContent: 'flex-end' }, cancel))
        } else {
          // The confirmed user and their home: provenance of the prefill.
          if (state.user !== null && state.home !== null) {
            body.push(el('div', { fontSize: '12px', color: T.dim }, copy('userHome', { user: state.user, home: state.home })))
          }

          renderHealthStrip(body)

          const input = el('input', FIELD_STYLE)
          input.value = state.draft
          input.placeholder = copy('pathPlaceholder')
          input.addEventListener('input', () => { state.draft = input.value })
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && state.distro !== null) go(state.draft)
          })
          const goButton = el('button', BUTTON_STYLE, copy('go'))
          goButton.type = 'button'
          goButton.disabled = state.distro === null
          goButton.addEventListener('click', () => { go(state.draft) })
          body.push(el('div', { display: 'flex', gap: '8px' }, input, goButton))

          const crumbs = el('div', { display: 'flex', flexWrap: 'wrap', gap: '4px', fontSize: '12px', color: T.dim })
          crumbs.append(crumb('/', () => { go('/') }))
          let accumulated = ''
          for (const segment of state.path.split('/').filter((part) => part.length > 0)) {
            accumulated += `/${segment}`
            const target = accumulated
            crumbs.append(el('span', { opacity: '0.45' }, ' › '))
            crumbs.append(crumb(segment, () => { go(target) }))
          }
          body.push(crumbs)

          const list = el('div', {
            flex: '1',
            minHeight: '180px',
            overflow: 'auto',
            padding: '6px',
            borderRadius: '6px',
            border: `1px solid ${T.border}`,
            background: T.layer,
          })
          const allDirectories = (state.listing?.entries ?? []).filter((entry) => entry.kind === 'directory')
          // Filtering updates the rendered rows in place instead of repainting the
          // card: a paint per keystroke replaces the input and steals focus (and
          // breaks IME composition). The initial paint applies the stored filter.
          const matchesFilter = (name) => state.filter === ''
            || name.toLowerCase().includes(state.filter.toLowerCase())
          const empty = el('div', { fontSize: '12px', color: T.dim, padding: '6px' }, copy('filterEmpty'))
          empty.style.display = 'none'
          const applyFilter = () => {
            let visible = 0
            for (const node of list.querySelectorAll('[data-wsl-entry]')) {
              const shown = matchesFilter(node.getAttribute('data-name') ?? '')
              node.style.display = shown ? 'block' : 'none'
              if (shown) visible += 1
            }
            empty.style.display = visible === 0 ? 'block' : 'none'
            if (state.filter !== '') empty.setAttribute('data-wsl-filter-empty', '')
            else empty.removeAttribute('data-wsl-filter-empty')
          }
          if (state.listing !== null) {
            const filter = el('input', FIELD_STYLE)
            filter.value = state.filter
            filter.placeholder = copy('filterPlaceholder')
            filter.setAttribute('data-wsl-filter', '')
            filter.setAttribute('aria-label', copy('filterLabel'))
            filter.addEventListener('input', () => {
              state.filter = filter.value
              applyFilter()
            })
            body.push(filter)
          }
          if (state.listing === null) {
            list.append(el('div', { fontSize: '12px', color: T.dim, padding: '6px' }, copy('readingDir')))
          } else if (allDirectories.length === 0) {
            list.append(el('div', { fontSize: '12px', color: T.dim, padding: '6px' }, copy('noSubdirs')))
          } else {
            for (const entry of allDirectories) {
              const item = el('button', {
                display: matchesFilter(entry.name) ? 'block' : 'none',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color: T.label,
                font: 'inherit',
                fontSize: '13px',
                padding: '4px 6px',
                borderRadius: '4px',
                cursor: 'pointer',
              }, `📁 ${entry.name}`)
              item.type = 'button'
              item.setAttribute('data-wsl-entry', '')
              item.setAttribute('data-name', entry.name)
              item.addEventListener('mouseenter', () => { item.style.background = T.hover })
              item.addEventListener('mouseleave', () => { item.style.background = 'transparent' })
              item.addEventListener('click', () => { go(joinLinux(state.path, entry.name)) })
              list.append(item)
            }
            list.append(empty)
            if (state.filter !== '') empty.setAttribute('data-wsl-filter-empty', '')
            applyFilter()
          }
          body.push(list)
          if (typeof state.listing?.hidden === 'number' && state.listing.hidden > 0) {
            body.push(el('div', { fontSize: '11px', color: T.dim },
              t(
                `${state.listing.hidden} 个名称包含无法在 Windows 路径中表示的字符，已隐藏。`,
                `${state.listing.hidden} name(s) contain characters a Windows path cannot represent and are hidden.`,
              )))
          }

          const parent = parentOf(state.path)
          if (parent !== null) {
            const up = el('button', { ...BUTTON_STYLE, alignSelf: 'flex-start', padding: '4px 10px' }, copy('parentDir'))
            up.type = 'button'
            up.addEventListener('click', () => { go(parent) })
            body.push(up)
          }

          if (state.error !== null) {
            const failure = renderFailureNode(state.error, state.bootstrap, state)
            if (failure !== null) body.push(failure)
            // A failed listing left the operator with an error and no way back to
            // the directory they were reading. Retrying the same load is safe; a
            // failed commit is deliberately excluded because it may have created
            // the workspace before the error.
            if (state.listing === null && !state.working) {
              const retryList = el('button', BUTTON_STYLE, copy('retryList'))
              retryList.type = 'button'
              retryList.setAttribute('data-wsl-list-retry', '')
              retryList.addEventListener('click', () => { void load() })
              body.push(el('div', { display: 'flex', justifyContent: 'flex-start' }, retryList))
            }
          }

          const cancel = el('button', BUTTON_STYLE, copy('cancel'))
          cancel.type = 'button'
          cancel.addEventListener('click', () => { close() })
          const confirm = el('button', {
            ...PRIMARY_STYLE,
            opacity: state.working ? '0.6' : '1',
          }, state.working ? copy('working') : copy('createOpen'))
          confirm.type = 'button'
          confirm.setAttribute('data-wsl-action', 'create')
          confirm.disabled = state.working || state.distro === null
          confirm.addEventListener('click', () => { void commit() })
          body.push(el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, cancel, confirm))
        }
        }

        // replaceChildren DESTROYS whatever had focus, so the question is not
        // whether to steal focus but whether the field holding the caret was just
        // rebuilt. Discovery settles ~0.2-1s after the dialog opens and repaints
        // in the same phase with no error, which used to leave the focused
        // username input detached and send the rest of the typing to
        // document.body. Focus is restored only when one of OUR fields had it.
        const focused = document.activeElement
        const hadOurFocus = focused !== null && focused !== document.body
          && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA') && card.contains(focused)
        card.replaceChildren(...body)
        // Focus the phase's primary field when the phase changes, a FRESH error
        // appears, or the field that held the caret was just rebuilt — the most
        // common repair (a typo'd username, a bad path) starts in that field.
        if (hadOurFocus || renderedPhase !== state.phase || (state.error !== null && state.error !== renderedError)) {
          renderedPhase = state.phase
          card.querySelector('input')?.focus()
        }
        renderedError = state.error
      }

      // The uninstall teardown gets forceClose, not close: a plugin
      // uninstalled mid-commit must still release the overlay, and the token
      // bump makes the in-flight commit's settled result drop instead of
      // creating a workspace on a dead context. The dialog's own cancel paths
      // (overlay click, Escape) keep the guarded close below.
      teardown = forceClose
      opener?.setAttribute?.('aria-expanded', 'true')
      document.addEventListener('keydown', onKey)
      hostElement().append(overlay)
      render()
      if (!overlay.contains(document.activeElement)) focusables()[0]?.focus()

      // The rejection handler only ever sees a refusal of listDistros itself; a
      // throw INSIDE the continuation (a body the route did not expect,
      // chooseDistro failing) would surface as an unhandled rejection —
      // state.distros assigned without a render, the dialog stuck on its reading
      // line, and nothing anywhere to read. One handler owns the whole chain.
      void initialize()
    }

    /** The injected services the picker and its trigger read. */
    // ── 5. the companion button and workspace rows ─────────────────────────────
    const companion = { button: null, fallback: null, trigger: null, observer: null, scheduled: false, disposed: false }

    /** Whether the missing-workspace-source warning was already printed. */
    let warnedWorkspaceSource = false

    /**
     * The sprite glyph one `<use>` reference names, or null.
     *
     * Accepts both the bare symbol id and the `#`-prefixed href form, and both
     * `href` and the legacy `xlink:href` spelling, because an icon may render
     * either. Returning the GLYPH (not the whole id) lets the trigger list stay
     * a list of glyph names, which is what a desktop generation actually fixes.
     * @param {Element} node - a `<use>` element.
     * @returns {string | null} the glyph name, or null when it is not a sprite ref.
     */
    function spriteGlyphOf(node) {
      const ref = node.getAttribute('href')
        ?? node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      if (ref === null) return null
      return SPRITE_ICON_ID.exec(ref)?.[1] ?? null
    }

    /**
     * The candidate trigger buttons carrying one generation's icon identity.
     *
     * Each generation is ONE document-level selector rather than a walk over
     * every button: `findTrigger` re-runs on every animation frame whenever the
     * anchor is missing, so a per-button subtree query would turn a single scan
     * into N of them exactly when the header is already in trouble.
     * @param {string} selector - the icon nodes this generation renders.
     * @param {(node: Element) => boolean} identifies - whether one icon is the trigger's.
     * @returns {HTMLElement[]} the distinct buttons owning a matching icon.
     */
    function triggerCandidates(selector, identifies) {
      const matches = []
      for (const icon of document.querySelectorAll(selector)) {
        if (!identifies(icon)) continue
        const trigger = icon.closest('button')
        if (trigger !== null && !matches.includes(trigger)) matches.push(trigger)
      }
      return matches
    }

    /** Whether one inline path carries the add-workspace geometry. */
    function isTriggerPath(path) {
      const d = path.getAttribute('d')
      return TRIGGER_ICON_PATHS.some((geometry) => d.startsWith(geometry))
    }

    /**
     * Whether one icon node is the add-workspace artwork, in either generation.
     *
     * A sprite icon is identified by `data-icon` (the id the component was
     * CONSTRUCTED with, which a theme replacement does not change) and, failing
     * that, by the `<use>` reference it renders.
     * @param {Element} icon - an inline path or a sprite `<svg>`/`<use>`.
     * @returns {boolean} true when it is the trigger's artwork.
     */
    function isTriggerIcon(icon) {
      if (icon.tagName === 'path') return isTriggerPath(icon)
      const declared = icon.tagName === 'svg' ? icon.getAttribute('data-icon') : null
      const glyph = declared !== null ? SPRITE_ICON_ID.exec(declared)?.[1] : spriteGlyphOf(icon)
      return glyph !== undefined && glyph !== null && TRIGGER_ICON_GLYPHS.includes(glyph)
    }

    /** Pick the trigger out of one generation's candidates, or null. */
    function pickTrigger(matches) {
      if (matches.length <= 1) return matches[0] ?? null
      // More than one control carries the geometry. The shipped trigger is the
      // one inside a `*_headerActions` cluster — the CSS-module local name is
      // stable across builds — and anchoring to a stranger would put the
      // companion beside an unrelated control, so an unrecognised duplicate
      // makes the companion stand down instead.
      return matches.find((trigger) => hasHeaderActionsParent(trigger)) ?? null
    }

    /**
     * Find the shipped "add workspace" trigger in either desktop generation.
     *
     * The sprite generation is scanned FIRST because it is the newer one: on a
     * desktop that renders it, that single scan is the whole cost. Only a
     * desktop with no sprite icon anywhere falls through to the geometry scan,
     * which is what every release before 0.2.1-rc3 needed.
     * @returns {HTMLElement | null} the anchor, or null when this desktop has none.
     */
    function findTrigger() {
      const sprite = triggerCandidates('svg[data-icon], use', isTriggerIcon)
      // A non-empty sprite result is this desktop's answer even when it is
      // ambiguous: `pickTrigger` returns null there to mean "stand down", and
      // falling through would let an unrelated inline icon pick the anchor.
      if (sprite.length > 0) return pickTrigger(sprite)
      return pickTrigger(triggerCandidates('svg > path[d]', isTriggerIcon))
    }

    /**
     * Whether one trigger sits in the shipped trailing action cluster.
     * @param {HTMLElement} trigger - a candidate trigger button.
     * @returns {boolean} true when its parent is the cluster.
     */
    function hasHeaderActionsParent(trigger) {
      const tokens = String(trigger.parentElement?.className ?? '').split(/\s+/)
      return tokens.some((token) => /(^|_)headerActions$/.test(token))
    }

    /**
     * The action cluster holding the shipped trigger.
     *
     * The companion is inserted after this cluster — beside it, inside the
     * header row — because the cluster caps its own width (the shipped sheet
     * gives it `max-width: 60px` for exactly two 28px buttons) and clips a
     * third child.
     * @param {HTMLElement} trigger - the shipped add-workspace button.
     * @returns {Element} the node the companion follows.
     */
    function actionCluster(trigger) {
      return trigger.parentElement ?? trigger
    }

    /**
     * Whether one workspace path is a WSL UNC path, and which distribution.
     *
     * Inlined rather than imported from `lib/wsl/paths.js`: the browser half is
     * a hand-written factory with no module graph of its own, and this is the
     * whole rule. Both UNC hosts Windows accepts are covered, as in the host
     * half.
     * @param {unknown} path - the workspace path.
     * @returns {string | null} the distribution name, or null when not WSL.
     */
    function wslDistroOf(path) {
      if (typeof path !== 'string') return null
      const segments = path.replace(/\\/g, '/').split('/').filter((segment) => segment !== '')
      if (segments.length < 2) return null
      const host = segments[0].toLowerCase()
      if (host !== 'wsl.localhost' && host !== 'wsl$') return null
      return segments[1]
    }

    /**
     * Build the cloud icon for one distribution, in the row's own weight.
     * @param {string} distro - the distribution, kept on the node for debugging.
     * @param {boolean} solid - true for the expanded row's fill-only geometry.
     * @returns {SVGElement} the icon node.
     */
    function cloudIcon(distro, solid) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('xmlns', SVG_NS)
      // Decorative, exactly like the folder it replaces. A tooltip here could
      // never be read anyway: reaching the icon means hovering the row, and the
      // shipped stylesheet hides this whole slot on row hover.
      svg.setAttribute('aria-hidden', 'true')
      svg.dataset.wslCloud = distro
      svg.dataset.wslCloudWeight = solid ? 'solid' : 'outline'
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', CLOUD_PATH)
      if (solid) {
        path.setAttribute('fill', 'currentColor')
        svg.append(path)
        return svg
      }
      // The weight lives on the svg, as the shipped artwork declares it.
      svg.setAttribute('stroke-width', '1')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-linejoin', 'round')
      svg.append(path)
      return svg
    }

    /**
     * The leading folder slot of one workspace row.
     * @param {Element} row - the row element.
     * @returns {Element | null} the slot span, or null when the markup moved.
     */
    function folderSlotOf(row) {
      for (const child of row.children) {
        if (child.tagName !== 'SPAN') continue
        const tokens = String(child.className ?? '').split(/\s+/)
        if (tokens.some((token) => FOLDER_SLOT.test(token))) return child
      }
      return null
    }

    /**
     * Show a cloud instead of the folder icon on every WSL workspace row.
     *
     * The row's DOM carries the workspace NAME, never its path, so the row is
     * resolved through its `data-row-key="workspace:<id>"` against the workspace
     * list — those ids are the workspace ids themselves. Reading the list inside
     * each pass needs no subscription: the observer already re-runs on every
     * mutation that could add, remove, or relabel a row.
     *
     * The shipped `<svg>` is HIDDEN, never removed: React owns that node, and
     * reconciling a subtree whose child vanished is how a removeChild exception
     * starts. `display` is also not a childList mutation, so the hiding cannot
     * feed the observer this runs from. Every branch is idempotent.
     * @param {object} ctx - the client plugin context.
     */
    function syncWorkspaceIcons(ctx) {
      // The snapshot source hangs off `list` (IWorkspaces), NOT off the service
      // object. Reading the wrong one yields undefined, and an empty list there
      // is silent: that is how this feature first shipped doing nothing while
      // every check still passed. A missing source is reported once instead.
      const source = ctx.workspaces?.list
      if (typeof source?.getSnapshot !== 'function') {
        if (!warnedWorkspaceSource) {
          warnedWorkspaceSource = true
          console.warn('dsh-wsl-desktop: 读不到工作区列表（ctx.workspaces.list.getSnapshot 缺失），WSL 工作区行图标不会替换')
        }
        return
      }
      const items = source.getSnapshot().items ?? []
      const wsl = new Map()
      for (const workspace of items) {
        const distro = wslDistroOf(workspace?.path)
        if (distro !== null) wsl.set(String(workspace.workspaceId), distro)
      }
      for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) {
        const id = String(row.getAttribute('data-row-key')).slice('workspace:'.length)
        const span = folderSlotOf(row)
        if (span === null) continue
        const shipped = span.querySelector('svg:not([data-wsl-cloud])')
        let mine = span.querySelector('svg[data-wsl-cloud]')
        const distro = wsl.get(id)
        if (distro === undefined) {
          // Not a WSL workspace, or it went away: leave the shipped icon alone.
          if (mine !== null) mine.remove()
          if (shipped !== null) shipped.style.display = ''
          continue
        }
        if (shipped !== null) shipped.style.display = 'none'
        // The row's own weight, read off the icon it just rendered: the expanded
        // artwork fills its paths, the collapsed one strokes them. A rebuild is
        // owed whenever that flips, which is exactly what expanding a workspace
        // does to this span.
        const solid = isSolidIcon(shipped)
        const weight = solid ? 'solid' : 'outline'
        if (mine !== null && mine.dataset.wslCloudWeight !== weight) {
          mine.remove()
          mine = null
        }
        if (mine === null) span.append(cloudIcon(distro, solid))
        else if (mine.dataset.wslCloud !== distro) mine.dataset.wslCloud = distro
      }
    }

    /**
     * The sprite symbol an icon element references, as a bare symbol id.
     *
     * `data-icon` is the id the icon COMPONENT was built with, so it keeps the
     * shipped symbol even when a theme points the `<use>` href at its own
     * artwork; the href is the fallback for markup that omits `data-icon`.
     * @param {Element} icon - one icon `<svg>`.
     * @returns {string | null} the symbol id without `#`, or null.
     */
    function spriteSymbolOf(icon) {
      const declared = icon.getAttribute('data-icon')
      if (typeof declared === 'string' && declared !== '') return declared.replace(/^#/, '')
      for (const use of icon.querySelectorAll('use')) {
        const ref = use.getAttribute('href')
          ?? use.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        if (typeof ref === 'string' && ref !== '') return ref.replace(/^#/, '')
      }
      return null
    }

    /**
     * Whether one workspace row icon renders the FILL-only artwork.
     *
     * The collapsed row strokes its folder outline and the expanded one fills
     * it, and the cloud has to match whichever is showing. Up to 0.2.1-rc2 the
     * artwork was inline, so a stroked `<path>` was the tell. From 0.2.1-rc3 the
     * icon is a sprite reference with NO path child anywhere: the weight then
     * belongs to the SYMBOL in the document sprite, not to the `<svg>` naming
     * it. Reading only the inline shape (as this did) made every sprite row look
     * fill-only, so a collapsed row got the solid cloud.
     * @param {Element | null} icon - the shipped folder icon, if the row renders one.
     * @returns {boolean} true when the icon is the fill-only artwork.
     */
    function isSolidIcon(icon) {
      if (icon === null) return false
      // Inline generation: the artwork declares its own weight.
      if (icon.querySelector('path[d]') !== null) return icon.querySelector('path[stroke]') === null
      const symbolId = spriteSymbolOf(icon)
      if (symbolId === null) return false
      const symbol = document.getElementById(symbolId)
      // Sprite generation, symbol present: judge the artwork the browser paints,
      // so a theme's own geometry is measured rather than assumed.
      if (symbol !== null) return symbol.querySelector('path[stroke]') === null
      // Sprite generation, symbol not in the document (a theme may mount its
      // own sprite later): fall back to the glyph name, which is the fill-only
      // identity in the shipped table.
      const glyph = SPRITE_ICON_ID.exec(`#${symbolId}`)?.[1]
      return glyph !== undefined && glyph !== null && SOLID_GLYPHS.includes(glyph)
    }

    /**
     * Whether one observed mutation could have changed a workspace row's markup.
     *
     * Chat streaming mutates the transcript many times a second, and the icon scan
     * is a whole-document `querySelectorAll` — running it at that rate is exactly
     * the per-frame scan the trigger cache exists to avoid, and the comment on
     * `sync` claimed it did not happen when it did. A row only changes when React
     * writes inside one (add, remove, relabel, expand) or replaces its container,
     * so a record whose target and nodes all sit outside every workspace row
     * cannot have moved what the scan reads.
     * @param {MutationRecord} record - one observed mutation.
     * @returns {boolean} true when the icon scan has to re-run.
     */
    function touchesWorkspaceRow(record) {
      const target = record.target
      const anchor = target instanceof Element ? target : target.parentElement
      if (anchor === null) return false
      // Inside a row, IS a row, or IS an ancestor of the rows (the list container
      // React re-renders rows into). The transcript pane satisfies none of the
      // three, which is the whole point.
      if (anchor.closest('[data-row-key^="workspace:"]') !== null) return true
      return anchor.querySelector('[data-row-key^="workspace:"]') !== null
    }

    /**
     * Re-attach the companion button when React replaced or reordered its anchor.
     *
     * Every branch here is idempotent. The one `remove()` is guarded by
     * `isConnected`, so a settled "no anchor" state re-runs to a no-op instead
     * of feeding the observer a fresh mutation; hiding while connected is
     * expressed as `display`, which is not a childList mutation at all.
     * @param {object} ctx - the client plugin context.
     * @param {boolean} [iconsDirty] - false skips the whole-document workspace-row
     *   scan: the observer only asks for it when a mutation actually touched a
     *   workspace row, so transcript churn (chat streaming) costs the cheap
     *   placement checks below and nothing more.
     */
    function sync(ctx, iconsDirty = true) {
      companion.scheduled = false
      // A frame queued before disposal must not run: it would re-mark the rows
      // the disposer just restored, with no observer left to converge it (see
      // the disposer's `disposed` flag).
      if (companion.disposed === true) return
      // Runs before the companion's own early returns: marking workspace rows
      // is independent of whether the add-workspace trigger was found.
      if (iconsDirty) syncWorkspaceIcons(ctx)
      const { button } = companion
      if (button === null) return
      // Steady-state fast path: the cached trigger stays valid while it
      // remains connected inside the trailing action cluster, so chat
      // streaming (a mutation every frame) re-runs only the cheap placement
      // and visibility checks below instead of the whole-document icon scan.
      // The cache self-heals: a replaced or relocated trigger is disconnected
      // and forces one full rescan.
      let trigger = companion.trigger
      if (trigger === null || !trigger.isConnected || !hasHeaderActionsParent(trigger)) {
        trigger = findTrigger()
        companion.trigger = trigger
      }
      if (trigger === null) {
        if (button.isConnected) button.remove()
        return
      }
      const target = actionCluster(trigger)
      if (!button.isConnected || button.parentElement !== target.parentElement
        || button.previousElementSibling !== target) {
        // Adopt the trigger's own class so the companion renders as one of the
        // header's icon buttons in every sidebar width.
        button.className = trigger.className
        button.style.display = ''
        target.after(button)
      }
      // Measure with the button rendered, then decide. The header row clips its
      // own overflow, and the shipped action cluster hides itself while the
      // inline search is expanded — the companion follows it there.
      button.style.display = ''
      const row = button.parentElement?.getBoundingClientRect()
      const box = button.getBoundingClientRect()
      const fits = row === undefined || box.right <= row.right + 1
      const triggerVisible = getComputedStyle(trigger).visibility !== 'hidden'
      button.style.display = fits && triggerVisible ? '' : 'none'
    }

    /**
     * The document element a client plugin may already touch.
     *
     * A client plugin applies while the document is still being parsed, so
     * `document.body` can be null here — observing it would throw and leave the
     * trigger permanently unattached. The document element always exists.
     * @returns {HTMLElement} the body once it exists, otherwise the document element.
     */
    function hostElement() {
      return document.body ?? document.documentElement
    }

    /**
     * Install the companion button and keep it attached.
     * @param {object} ctx - the client plugin context.
     * @returns {() => void} teardown releasing the button, observer, and dialog.
     */
    function install(ctx) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.wslDesktop = 'workspace-trigger'
      button.setAttribute('aria-label', BUTTON_LABEL)
      button.setAttribute('aria-haspopup', 'dialog')
      button.setAttribute('aria-expanded', 'false')
      button.title = BUTTON_LABEL
      button.append(el('span', {
        fontWeight: '600',
        fontSize: '13px',
        lineHeight: '1',
        letterSpacing: '0.02em',
      }, 'W'))
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openPicker(ctx)
      })
      companion.button = button

      /** The degraded entry shown when the sidebar anchor is missing. */
      let fallbackEntry = null

      /** Remove the degraded entry, if one is showing. */
      function removeFallback() {
        if (fallbackEntry === null) return
        fallbackEntry.remove()
        fallbackEntry = null
        companion.fallback = null
      }

      /**
       * Show the only visible entry when the sidebar anchor is missing.
       *
       * This is the failure path of the DOM anchor, not a second product entry: it
       * appears only after the 5s probe finds nothing, can be dismissed for the page
       * session, and disappears when the real button later attaches.
       */
      function showFallback() {
        if (fallbackEntry !== null) return
        const entry = document.createElement('div')
        entry.setAttribute('data-wsl-fallback-entry-container', '')
        entry.setAttribute('role', 'group')
        entry.setAttribute('aria-label', t('WSL 工作区入口', 'WSL workspace entry'))
        entry.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9998;display:flex;align-items:center;gap:4px;'
          + 'padding:4px 6px;border-radius:8px;border:1px solid rgba(127,127,127,0.35);'
          + 'background:var(--dsw-alias-bg-secondary, #2a2a2a);box-shadow:0 4px 12px rgba(0,0,0,0.25)'
        const open = document.createElement('button')
        open.type = 'button'
        open.textContent = 'WSL'
        open.setAttribute('data-wsl-fallback-entry', '')
        open.setAttribute('aria-haspopup', 'dialog')
        open.setAttribute('aria-expanded', 'false')
        open.setAttribute('aria-label', t('打开 WSL 工作区（入口降级）', 'Open the WSL workspace picker (degraded entry)'))
        open.style.cssText = 'border:none;background:transparent;color:var(--dsw-alias-label-primary,#eaeaea);'
          + 'font:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:4px 6px;border-radius:6px'
        open.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          openPicker(ctx)
        })
        const dismiss = document.createElement('button')
        dismiss.type = 'button'
        dismiss.textContent = '×'
        dismiss.setAttribute('data-wsl-fallback-dismiss', '')
        dismiss.setAttribute('aria-label', t('关闭降级入口', 'Dismiss the degraded entry'))
        dismiss.style.cssText = 'border:none;background:transparent;color:var(--dsw-alias-label-secondary,rgba(234,234,234,0.66));'
          + 'font:inherit;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px'
        dismiss.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          removeFallback()
        })
        entry.append(open, dismiss)
        hostElement().append(entry)
        fallbackEntry = entry
        companion.fallback = open
      }

      // `sync` is idempotent and never removes the node it manages, so its own
      // work cannot re-trigger the observer it runs from.
      // Cleared on every install: the flag is set by the disposer and this
      // companion object outlives a disable/enable cycle.
      companion.disposed = false
      // Two independent things make the icon scan necessary, so they OR into one
      // coalesced frame: the DOM actually changed inside the workspace rows, or the
      // workspace LIST changed under them (a re-point edits the store, and the row
      // markup may not move at all). Either trigger upgrades a scheduled
      // transcript-only sync to a full pass; neither adds a timer.
      let pendingIcons = false
      const schedule = (iconsDirty) => {
        if (companion.scheduled) {
          if (iconsDirty) pendingIcons = true
          return
        }
        companion.scheduled = true
        pendingIcons = iconsDirty
        requestAnimationFrame(() => {
          const dirty = pendingIcons
          pendingIcons = false
          sync(ctx, dirty)
          // The anchor may have appeared after the fallback was shown; the real
          // entry wins and the failure-path chip leaves.
          if (button.isConnected) removeFallback()
        })
      }
      const observer = new MutationObserver((mutations) => {
        // The record list is the cheap discriminator: a transcript-only burst
        // schedules a sync that skips the icon scan, while anything that touched a
        // workspace row — or the container React renders rows into — schedules the
        // full pass. Either way the placement checks below run as before.
        schedule(mutations.some((record) => touchesWorkspaceRow(record)))
      })
      companion.observer = observer
      const workspaceSource = ctx.workspaces?.list
      const unsubscribe =
        typeof workspaceSource?.subscribe === 'function' ? workspaceSource.subscribe(() => schedule(true)) : null
      sync(ctx)
      if (button.isConnected) removeFallback()
      observer.observe(document.documentElement, { childList: true, subtree: true })
      const warning = setTimeout(() => {
        if (button.isConnected) return
        // Distinguishes "no mount point" from "deliberately hidden": only the
        // former means the sidebar has no room beside the trigger at all. The
        // console line is not enough for a user; the fallback entry is.
        console.warn('dsh-wsl-desktop: 侧栏未出现"添加工作区"入口，W 按钮没有挂载点')
        showFallback()
      }, 5000)

      return () => {
        clearTimeout(warning)
        removeFallback()
        observer.disconnect()
        unsubscribe?.()
        // disconnect() does not cancel a callback already handed to
        // requestAnimationFrame, and that queued sync would re-inject the cloud
        // icons (and re-hide the shipped folder icons) after the loop below put
        // them back, with no observer left to converge it. sync() checks this
        // flag before it touches the DOM.
        companion.disposed = true
        // Put every swapped row back: the shipped folder icon is shown again
        // and this half's node leaves with the plugin.
        for (const mine of document.querySelectorAll('svg[data-wsl-cloud]')) {
          const shipped = mine.parentElement?.querySelector('svg:not([data-wsl-cloud])')
          if (shipped !== null && shipped !== undefined) shipped.style.display = ''
          mine.remove()
        }
        button.remove()
        companion.button = null
        companion.trigger = null
        companion.observer = null
        teardown?.()
      }
    }


    // ── 6. module registration and dispose ─────────────────────────────
    return {
      // `remote.session` is the namespace the create request travels through
      // (see `createBoundSession`); the harness's own client plugins inject it
      // the same way.
      inject: ['workspaces', 'uiWorkspace', 'sessions', 'remote', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => install(ctx), 'wsl-desktop: sidebar WSL workspace trigger')
      },
    }
  },
})
