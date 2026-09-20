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
     * First path command of `IconProjectAddOutline16` — the icon of the shipped
     * "add workspace" trigger, and the only place the app renders it.
     */
    const TRIGGER_ICON_PATH = 'M3.55246 0L3.55246 2.44252'

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
          const sessionId = await ctx.sessions.create({
            workspaceId: workspace.workspaceId,
            agentPreset: preset.agentPreset,
          })
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
        }, name)
        node.type = 'button'
        node.addEventListener('click', () => {
          state.distro = name
          go('/')
        })
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

      /** Whether the path field already took its opening focus. */
      let focusedOnce = false

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

        card.replaceChildren(...body)
        // Focus once, when the dialog opens. A focus on every repaint would
        // yank the caret whenever a background listing settles or an error
        // appears while the operator is typing.
        if (!focusedOnce) {
          focusedOnce = true
          input.focus()
        }
      }

      teardown = close
      document.addEventListener('keydown', onKey)
      hostElement().append(overlay)
      render()

      call('listDistros').then(async (names) => {
        if (state.closed) return
        state.distros = names
        const fallback = await call('defaultDistro').catch(() => ({ distro: null }))
        if (state.closed) return
        state.distro = names.includes(fallback.distro) ? fallback.distro : names[0] ?? null
        state.path = '/'
        state.draft = '/'
        void load()
      }, (failure) => {
        if (state.closed) return
        state.error = message(failure)
        render()
      })
    }

    /** The injected services the picker and its trigger read. */
    const companion = { button: null, after: null, observer: null, scheduled: false }

    /** Find the shipped "add workspace" trigger by its icon geometry. */
    function findTrigger() {
      const matches = []
      for (const path of document.querySelectorAll('svg > path[d]')) {
        if (!path.getAttribute('d').startsWith(TRIGGER_ICON_PATH)) continue
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
     * Re-attach the companion button when React replaced or reordered its anchor.
     *
     * Every branch here is idempotent. The one `remove()` is guarded by
     * `isConnected`, so a settled "no anchor" state re-runs to a no-op instead
     * of feeding the observer a fresh mutation; hiding while connected is
     * expressed as `display`, which is not a childList mutation at all.
     */
    function sync() {
      companion.scheduled = false
      const { button } = companion
      if (button === null) return
      const trigger = findTrigger()
      if (trigger === null) {
        if (button.isConnected) button.remove()
        companion.after = null
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
        companion.after = target
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
        requestAnimationFrame(sync)
      })
      companion.observer = observer
      sync()
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
        button.remove()
        companion.button = null
        companion.after = null
        companion.observer = null
        teardown?.()
      }
    }

    return {
      inject: ['workspaces', 'uiWorkspace', 'sessions'],
      apply(ctx) {
        ctx.effect(() => install(ctx), 'wsl-desktop: sidebar WSL workspace trigger')
      },
    }
  },
})
