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

    /** Accessible name and tooltip of the companion button. */
    const BUTTON_LABEL = '添加 WSL 工作区'

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
     * Perform one host call and unwrap the envelope.
     * @param {string} method - host method name.
     * @param {object} [params] - method payload.
     * @returns {Promise<any>} the unwrapped value.
     */
    async function call(method, params = {}) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
      })
      // The route answers non-JSON for a refused or malformed request (401 from
      // the trust fence, 415 for a bad media type, 405 for a wrong method), so
      // the status is read before the body is parsed.
      let envelope
      try {
        envelope = await response.json()
      } catch {
        throw new Error(`${method} 被宿主拒绝（HTTP ${response.status}）`)
      }
      if (!envelope.ok) throw new Error(envelope.error ?? `${method} 失败（HTTP ${response.status}）`)
      return envelope.value
    }

    /** Readable text of an unknown rejection. */
    function message(failure) {
      return failure?.message ?? String(failure)
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
      if (result?.ok !== true) throw new Error(result?.error?.message ?? '宿主拒绝创建会话')
      return result.value.sessionId
    }

    /** Parent of an absolute Linux path. */
    function parentOf(path) {
      const trimmed = path.replace(/\/+$/, '')
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
      const state = {
        distros: null,
        distro: null,
        /** The gate: pick the distribution user before any browsing happens. */
        phase: 'pick-user',
        userDraft: '',
        pending: false,
        /** The confirmed distribution user and their home, once resolved. */
        user: null,
        home: null,
        path: '/',
        draft: '/',
        listing: null,
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
      overlay.append(card)
      overlay.addEventListener('click', () => { close() })
      card.addEventListener('click', (event) => { event.stopPropagation() })

      /**
       * Close the picker and release its listeners.
       * A commit in flight owns the outcome: closing mid-commit would let the
       * workspace be created and a session opened after the operator cancelled.
       */
      function close() {
        if (state.closed || state.working) return
        state.closed = true
        state.token += 1
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        teardown = null
      }

      /** Close the picker regardless of an in-flight commit, once it settles. */
      function forceClose() {
        state.closed = true
        state.token += 1
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        teardown = null
      }

      function onKey(event) {
        if (event.key === 'Escape') close()
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
          state.error = message(failure)
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
        } catch (failure) {
          if (state.closed || marker !== state.token) return
          state.error = message(failure)
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
          if (facts.isDirectory !== true) throw new Error(`${target} 不是一个存在的目录`)
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
          state.error = message(failure)
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

        body.push(el('div', { fontSize: '15px', fontWeight: '600' }, '添加 WSL 工作区'))
        body.push(el('div', { fontSize: '12px', color: T.dim },
          '新会话的 bash 与文件工具都会在该发行版里工作；Windows 文件可在 /mnt/<盘符> 下访问。'))

        const distros = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' })
        distros.append(el('span', { fontSize: '12px', color: T.dim }, '发行版'))
        if (state.distros === null) {
          distros.append(el('span', { fontSize: '12px', color: T.dim }, '读取中…'))
        } else if (state.distros.length === 0) {
          distros.append(el('span', { fontSize: '12px', color: T.error }, '没有可用的 WSL 发行版'))
        } else {
          for (const name of state.distros) distros.append(pill(name))
        }
        body.push(distros)

        if (state.phase === 'pick-user') {
          // The user gate: no browsing until the distribution user is named.
          // An empty field means the distribution's default user; an unknown
          // user fails right here instead of opening the browser on a guess.
          body.push(el('div', { fontSize: '12px', color: T.dim },
            '输入要进入该发行版的用户；确认后直接落在其主目录。'))
          const userField = el('input', FIELD_STYLE)
          userField.value = state.userDraft
          userField.placeholder = '留空 = 发行版默认用户'
          userField.addEventListener('input', () => { state.userDraft = userField.value })
          userField.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && state.distro !== null) void confirmUser()
          })
          const enter = el('button', {
            ...PRIMARY_STYLE,
            opacity: state.pending ? '0.6' : '1',
          }, state.pending ? '解析中…' : '确认进入')
          enter.type = 'button'
          enter.disabled = state.pending || state.distro === null
          enter.addEventListener('click', () => { void confirmUser() })
          body.push(el('div', { display: 'flex', gap: '8px' }, userField, enter))

          if (state.error !== null) body.push(el('div', { fontSize: '12px', color: T.error }, state.error))

          const cancel = el('button', BUTTON_STYLE, '取消')
          cancel.type = 'button'
          cancel.addEventListener('click', () => { close() })
          body.push(el('div', { display: 'flex', justifyContent: 'flex-end' }, cancel))
        } else {
          // The confirmed user and their home: provenance of the prefill.
          if (state.user !== null && state.home !== null) {
            body.push(el('div', { fontSize: '12px', color: T.dim }, `用户 ${state.user} · 主目录 ${state.home}（可直接修改）`))
          }

          const input = el('input', FIELD_STYLE)
          input.value = state.draft
          input.placeholder = '/home/用户名/项目'
          input.addEventListener('input', () => { state.draft = input.value })
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && state.distro !== null) go(state.draft)
          })
          const goButton = el('button', BUTTON_STYLE, '前往')
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
          const directories = (state.listing?.entries ?? []).filter((entry) => entry.kind === 'directory')
          if (state.listing === null) {
            list.append(el('div', { fontSize: '12px', color: T.dim, padding: '6px' }, '读取目录…'))
          } else if (directories.length === 0) {
            list.append(el('div', { fontSize: '12px', color: T.dim, padding: '6px' }, '没有子目录'))
          } else {
            for (const entry of directories) {
              const item = el('button', {
                display: 'block',
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
              item.addEventListener('mouseenter', () => { item.style.background = T.hover })
              item.addEventListener('mouseleave', () => { item.style.background = 'transparent' })
              item.addEventListener('click', () => { go(joinLinux(state.path, entry.name)) })
              list.append(item)
            }
          }
          body.push(list)

          const parent = parentOf(state.path)
          if (parent !== null) {
            const up = el('button', { ...BUTTON_STYLE, alignSelf: 'flex-start', padding: '4px 10px' }, '.. 上级目录')
            up.type = 'button'
            up.addEventListener('click', () => { go(parent) })
            body.push(up)
          }

          if (state.error !== null) body.push(el('div', { fontSize: '12px', color: T.error }, state.error))

          const cancel = el('button', BUTTON_STYLE, '取消')
          cancel.type = 'button'
          cancel.addEventListener('click', () => { close() })
          const confirm = el('button', {
            ...PRIMARY_STYLE,
            opacity: state.working ? '0.6' : '1',
          }, state.working ? '处理中…' : '创建并打开')
          confirm.type = 'button'
          confirm.disabled = state.working || state.distro === null
          confirm.addEventListener('click', () => { void commit() })
          body.push(el('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px' }, cancel, confirm))
        }

        card.replaceChildren(...body)
        // Focus the phase's primary field when the phase changes or a FRESH
        // error appears — replaceChildren destroys the focused input, and the
        // most common repair (a typo'd username, a bad path) starts in that
        // field. Routine repaints never steal focus: that would yank the
        // caret while the operator types.
        if (renderedPhase !== state.phase || (state.error !== null && state.error !== renderedError)) {
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
      document.addEventListener('keydown', onKey)
      hostElement().append(overlay)
      render()

      call('listDistros').then(async (names) => {
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
      }, (failure) => {
        if (state.closed) return
        state.error = message(failure)
        render()
      })
    }

    /** The injected services the picker and its trigger read. */
    const companion = { button: null, trigger: null, observer: null, scheduled: false }

    /** Whether the missing-workspace-source warning was already printed. */
    let warnedWorkspaceSource = false

    /** Find the shipped "add workspace" trigger by its icon geometry. */
    function findTrigger() {
      const matches = []
      for (const path of document.querySelectorAll('svg > path[d]')) {
        const d = path.getAttribute('d')
        if (!TRIGGER_ICON_PATHS.some((geometry) => d.startsWith(geometry))) continue
        const trigger = path.closest('button')
        if (trigger !== null && !matches.includes(trigger)) matches.push(trigger)
      }
      if (matches.length <= 1) return matches[0] ?? null
      // More than one control carries the geometry. The shipped trigger is the
      // one inside a `*_headerActions` cluster — the CSS-module local name is
      // stable across builds — and anchoring to a stranger would put the
      // companion beside an unrelated control, so an unrecognised duplicate
      // makes the companion stand down instead.
      return matches.find((trigger) => hasHeaderActionsParent(trigger)) ?? null
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
        const solid = shipped !== null && shipped.querySelector('path[stroke]') === null
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
     * Re-attach the companion button when React replaced or reordered its anchor.
     *
     * Every branch here is idempotent. The one `remove()` is guarded by
     * `isConnected`, so a settled "no anchor" state re-runs to a no-op instead
     * of feeding the observer a fresh mutation; hiding while connected is
     * expressed as `display`, which is not a childList mutation at all.
     * @param {object} ctx - the client plugin context.
     */
    function sync(ctx) {
      companion.scheduled = false
      // Runs before the companion's own early returns: marking workspace rows
      // is independent of whether the add-workspace trigger was found.
      syncWorkspaceIcons(ctx)
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

      // `sync` is idempotent and never removes the node it manages, so its own
      // work cannot re-trigger the observer it runs from.
      const observer = new MutationObserver(() => {
        if (companion.scheduled) return
        companion.scheduled = true
        requestAnimationFrame(() => sync(ctx))
      })
      companion.observer = observer
      sync(ctx)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      const warning = setTimeout(() => {
        if (button.isConnected) return
        // Distinguishes "no mount point" from "deliberately hidden": only the
        // former means the sidebar has no room beside the trigger at all.
        console.warn('dsh-wsl-desktop: 侧栏未出现"添加工作区"入口，W 按钮没有挂载点')
      }, 5000)

      return () => {
        clearTimeout(warning)
        observer.disconnect()
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
