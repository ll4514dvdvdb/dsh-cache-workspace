/**
 * dsh-cache-workspace — Client half.
 *
 * One compact control in the composer's left tool row, right after the
 * computer-use chip. Clicking the folder name opens the Host-native directory
 * picker (Windows Explorer dialog); the small chevron lists folders already in
 * the workspace. A native <select> renders its own popup, so no portal is needed
 * inside the docked composer.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cache-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/dsh-cache-workspace'
    const CSS_ID = 'dsh-cache-workspace-style'
    const DEFAULT_NAME = '.dsh-cache'
    const NOTICE_MS = 4000

    /** Set by apply(): the Client context, used to reach the native picker. */
    let clientCtx = null

    // Matches the computer-use chip next to it: a 24px transparent pill that only
    // gains a light background on hover, 13px secondary label, 6px radius.
    const CSS = `
      .dsh-cw { box-sizing: border-box; display: inline-flex; align-items: center; gap: 2px; min-width: 0; max-width: 210px; }
      .dsh-cw-chip { box-sizing: border-box; display: inline-flex; align-items: center; height: 24px; max-width: 176px; padding: 0 4px 0 8px; border: 1px solid transparent; border-radius: var(--dsw-radius-md, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family); font-size: var(--dsw-font-xs-13, 13px); line-height: 1; white-space: nowrap; transition: background-color .12s ease, color .12s ease; }
      .dsh-cw-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .dsh-cw-chip.is-busy { opacity: .55; }
      .dsh-cw-chip.is-idle { cursor: default; color: var(--dsw-alias-label-tertiary); }
      .dsh-cw-chip-btn { gap: 5px; padding: 0 8px; text-align: left; cursor: pointer; }
      .dsh-cw-hit { box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 22px; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; line-height: 1; cursor: pointer; }
      .dsh-cw-hit:disabled { cursor: default; }
      .dsh-cw-hit:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 1px; border-radius: 4px; }
      .dsh-cw-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; opacity: .9; }
      .dsh-cw-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-cw-name.is-missing { opacity: .55; font-style: italic; }
      .dsh-cw-name.is-error { color: var(--dsw-alias-state-error-primary); opacity: 1; font-style: normal; }
      .dsh-cw-more { position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 22px; border-radius: 4px; color: inherit; opacity: .65; cursor: pointer; }
      .dsh-cw-more:hover { opacity: 1; }
      .dsh-cw-more:focus-within { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: 0; }
      .dsh-cw-select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; border: 0; padding: 0; margin: 0; cursor: pointer; font-size: 13px; }
      .dsh-cw-clear { box-sizing: border-box; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: var(--dsw-radius-md, 6px); background: transparent; color: var(--dsw-alias-label-secondary); line-height: 1; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
      .dsh-cw-clear:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-state-error-primary); }
      .dsh-cw-clear:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color); outline-offset: -1px; }
      .dsh-cw-clear:disabled { opacity: .35; cursor: default; }
      .dsh-cw-input { box-sizing: border-box; height: 24px; width: 148px; padding: 0 6px; border-radius: var(--dsw-radius-md, 6px); border: 1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.45)); background: transparent; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: var(--dsw-font-xs-13, 13px); outline: none; }
      .dsh-cw-input:focus { border-color: var(--dsw-alias-brand-primary, #4c8dff); }
    `

    // Icons are drawn as inline SVG rather than emoji so they inherit the label
    // colour and never fall back to a missing-glyph box.
    function icon(paths, size) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          className: 'dsh-cw-icon',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    function FolderIcon() {
      return icon(['M2.1 4.7c0-.7.5-1.2 1.2-1.2h2.9l1.3 1.4h5.2c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.3c-.7 0-1.2-.5-1.2-1.2z'], 14)
    }

    function ChevronIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 10,
          height: 10,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M4.2 6.4 8 10.1l3.8-3.7' }),
      )
    }

    function ClearIcon() {
      return icon(
        ['M2.9 4.4h10.2', 'M6.3 4.4V3.2c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.2', 'M4.4 4.4l.5 8.2c0 .5.5.9 1 .9h4.2c.5 0 1-.4 1-.9l.5-8.2', 'M6.8 7v3.9', 'M9.2 7v3.9'],
        13,
      )
    }

    function insertStyle() {
      if (document.getElementById(CSS_ID) !== null) return
      const style = document.createElement('style')
      style.id = CSS_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function request(pathName, options) {
      const response = await fetch(ROUTE + pathName, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const reason = payload && payload.error ? payload.error : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return payload
    }

    function post(pathName, body) {
      return request(pathName, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
    }

    function CacheChip(props) {
      const sessionId = props && props.sessionId ? props.sessionId : null
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [draft, setDraft] = React.useState('')

      const load = React.useCallback(async () => {
        if (!sessionId) return
        // A freshly opened conversation can briefly miss from the Host session
        // registry (it answers 404 until the session settles), so retry a few
        // times before showing the error state.
        const delays = [0, 1200, 3000]
        for (let attempt = 0; attempt < delays.length; attempt += 1) {
          if (delays[attempt] > 0) {
            await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
          }
          try {
            const data = await request(
              `/state?sessionId=${encodeURIComponent(sessionId)}`,
              { headers: { accept: 'application/json' } },
            )
            setSnap(data)
            setError(null)
            return
          } catch (err) {
            const message = err && err.message ? err.message : String(err)
            if (attempt === delays.length - 1) setError(message)
          }
        }
      }, [sessionId])

      React.useEffect(() => {
        load()
      }, [load])

      // A short-lived inline notice replaces the folder name; full text lives in
      // the control's title so a long sandbox explanation never widens the chip.
      React.useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), NOTICE_MS)
        return () => clearTimeout(timer)
      }, [notice])

      const applyResult = React.useCallback((data) => {
        if (data) setSnap(data)
        setError(null)
      }, [])

      /** Click on the folder name: ask the Host for its native directory picker. */
      const onBrowse = React.useCallback(async () => {
        if (!sessionId || busy) return
        const service = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null
        if (!service || typeof service.pickDirectory !== 'function') {
          setNotice('当前客户端不支持目录选择器')
          return
        }
        let picked = null
        try {
          picked = await service.pickDirectory()
        } catch (err) {
          setNotice(err && err.message ? err.message : '打开目录选择器失败')
          return
        }
        if (!picked) return
        setBusy(true)
        try {
          applyResult(await post('/select', { sessionId, path: picked }))
        } catch (err) {
          setNotice(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [sessionId, busy, applyResult])

      const onPick = React.useCallback(
        async (event) => {
          const value = event.target.value
          if (value === '__new__') {
            setCreating(true)
            setDraft('')
            return
          }
          if (!sessionId || busy) return
          setBusy(true)
          try {
            applyResult(await post('/select', { sessionId, name: value === DEFAULT_NAME ? '' : value }))
          } catch (err) {
            setNotice(err && err.message ? err.message : String(err))
            if (snap) event.target.value = snap.name
          } finally {
            setBusy(false)
          }
        },
        [sessionId, busy, snap, applyResult],
      )

      const submitCreate = React.useCallback(async () => {
        const name = draft.trim()
        if (!sessionId || busy) return
        if (!name) {
          setCreating(false)
          return
        }
        setBusy(true)
        try {
          applyResult(await post('/create', { sessionId, name }))
          setCreating(false)
          setDraft('')
        } catch (err) {
          setNotice(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [sessionId, busy, draft, applyResult])

      const onClear = React.useCallback(async () => {
        if (!sessionId || busy || !snap) return
        const confirmed = window.confirm(
          `清理缓存目录「${snap.displayName || snap.name}」？\n\n删除路径：\n${snap.cacheDir}\n\n` +
            '删除会在独立进程中进行：即使这段对话被归档，清理也会继续完成。目录内容不可恢复。',
        )
        if (!confirmed) return
        setBusy(true)
        try {
          const data = await post('/clear', { sessionId })
          if (data && data.started === false) {
            setNotice(data.reason || '没有可清理的内容')
          } else {
            setNotice(null)
          }
          await load()
        } catch (err) {
          setNotice(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [sessionId, busy, snap, load])

      if (!snap && !error) {
        return h(
          'span',
          { className: 'dsh-cw' },
          h(
            'span',
            { className: 'dsh-cw-chip is-idle', title: '缓存工作区加载中…' },
            h(
              'span',
              { className: 'dsh-cw-hit' },
              h(FolderIcon),
              h('span', { className: 'dsh-cw-name' }, '缓存…'),
            ),
          ),
        )
      }

      if (!snap) {
        return h(
          'span',
          { className: 'dsh-cw' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-cw-chip dsh-cw-chip-btn',
              title: `缓存工作区不可用：${error}\n点击重试`,
              onClick: () => {
                setError(null)
                load()
              },
            },
            h(FolderIcon),
            h('span', { className: 'dsh-cw-name is-error' }, '缓存不可用'),
          ),
        )
      }

      const shown = notice || snap.displayName || snap.name
      const roots = Array.isArray(snap.writableRoots) ? snap.writableRoots : []
      const where = snap.isDefault ? '默认' : snap.external ? '工作区外' : '自定义'
      const title =
        `缓存工作区：${snap.cacheDir}\n` +
        `${snap.exists ? '目录已存在' : '目录尚未创建'}｜${where}` +
        (roots.length ? `\n\n可选择的目录范围：\n${roots.map((root) => `· ${root}`).join('\n')}` : '') +
        '\n\n点击文件夹名：用资源管理器选择目录' +
        (error ? `\n\n${error}` : '')

      const picker = creating
        ? h('input', {
            className: 'dsh-cw-input',
            autoFocus: true,
            value: draft,
            placeholder: '新文件夹名',
            spellCheck: false,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitCreate()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setCreating(false)
                setDraft('')
              }
            },
            onBlur: () => {
              if (busy) return
              if (draft.trim()) submitCreate()
              else setCreating(false)
            },
          })
        : h(
            'span',
            { className: `dsh-cw-chip${busy ? ' is-busy' : ''}` },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-cw-hit',
                title,
                disabled: busy,
                onClick: onBrowse,
              },
              h(FolderIcon),
              h('span', { className: `dsh-cw-name${notice ? ' is-error' : snap.exists ? '' : ' is-missing'}` }, shown),
            ),
            h(
              'label',
              { className: 'dsh-cw-more', title: `${title}\n\n下拉：从工作区已有文件夹中选择` },
              h(ChevronIcon),
              h(
                'select',
                {
                  className: 'dsh-cw-select',
                  value: snap.name,
                  disabled: busy,
                  title,
                  onChange: onPick,
                },
                (snap.options || []).map((option) =>
                  h('option', { key: option.name, value: option.name }, option.label || option.name),
                ),
                h('option', { key: '__new__', value: '__new__' }, '＋ 新建文件夹…'),
              ),
            ),
          )

      return h(
        'span',
        { className: 'dsh-cw' },
        picker,
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-cw-clear',
            title: `清理缓存目录「${snap.displayName || snap.name}」（独立进程删除，会话归档也会完成）`,
            disabled: busy || !snap.exists,
            onClick: onClear,
          },
          h(ClearIcon),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        insertStyle()
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-cache-workspace',
              order: 41,
              label: '缓存工作区',
            },
            CacheChip,
          ),
        )
      },
    }
  },
})
