/**
 * deepseek-usage — browser half.
 *
 * A compact balance chip in the session header (`conversation.session.header.actions`)
 * that polls the host's same-origin `/deepseek-usage/balance` route every 60s and
 * expands, on click, into a small panel with the full balance breakdown and a
 * refresh action.
 *
 * The bundle runs in the real browser page, so it uses native `fetch` and
 * `window.setInterval`; React is resolved from the shared module table.
 */

window.__ModuleLoader__.load({
  id: 'deepseek-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'deepseek-usage'
    /** Steady-state poll: the host refreshes on the same order of magnitude. */
    const POLL_HEALTHY_MS = 60000
    /** Poll while the first reading is still on its way (cold app start). */
    const POLL_FAST_MS = 1200
    /** Poll back-off while reads keep failing, before joining the steady cadence. */
    const POLL_ERROR_STEPS_MS = [2000, 4000, 8000, 15000, 30000]

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'title': 'DeepSeek 余额',
      'total': '总余额',
      'toppedUp': '充值余额',
      'granted': '赠送余额',
      'available': '可用',
      'unavailable': '不可用',
      'loading': '查询中…',
      'error': '余额获取失败',
      'noKey': '未配置 API Key',
      'refresh': '刷新',
      'updatedAt': '更新于 {time}',
      'stale': '显示的是上次成功获取的数据',
      'noData': '暂无余额数据'
    }
    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'title': 'DeepSeek Balance',
      'total': 'Total',
      'toppedUp': 'Topped up',
      'granted': 'Granted',
      'available': 'Available',
      'unavailable': 'Unavailable',
      'loading': 'Loading…',
      'error': 'Balance unavailable',
      'noKey': 'No API key configured',
      'refresh': 'Refresh',
      'updatedAt': 'Updated {time}',
      'stale': 'Showing the last successful reading',
      'noData': 'No balance data'
    }

    /** Poll delay (ms): fast until a reading lands, backing off while reads fail. */
    function pollDelayMs(value, failures) {
      if (value !== null && value.status === 'ok') return POLL_HEALTHY_MS
      if (value !== null && value.status === 'error') {
        const step = Math.min(Math.max(failures, 1), POLL_ERROR_STEPS_MS.length) - 1
        return POLL_ERROR_STEPS_MS[step]
      }
      return POLL_FAST_MS
    }

    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return `${currency} `
    }

    /** Colors follow theme tokens where they exist, with safe fallbacks. */
    const styles = {
      // The wrapper is the hover target: `paddingTop` extends its hit box up
      // across the visual gap above the chip so the pointer can travel from
      // chip to panel without a mouseleave in between; the matching negative
      // margin keeps the added 6px out of the composer dock row's layout.
      //
      // Positioning to the FAR RIGHT of that row: list-slot occupants render
      // as direct flex children of the row, so `order: 1` moves this item past
      // the context-usage ring (the only other trailing sibling) and
      // `marginLeft: auto` hands it the row's whole remaining free space,
      // pinning it to the trailing edge.
      wrapper: {
        position: 'relative',
        display: 'flex',
        width: 'fit-content',
        order: 1,
        marginLeft: 'auto',
        paddingTop: 6,
        marginTop: -6
      },
      // Styled to sit in the composer dock next to the stats pills: same pill
      // shape (`padding: 1px 8px`, transparent, tertiary label color) so the
      // row reads as one strip. The font size/line-height are copied from the
      // stats pills' own root (`--dsh-content-font-size-secondary - 1px` and
      // `20px + --dsh-content-font-delta-secondary`); `font: inherit` alone
      // would pick up the shell's default body size instead and look larger
      // than the pills beside it.
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '1px 8px',
        borderRadius: 999,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        font: 'inherit',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        fontVariantNumeric: 'tabular-nums',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap'
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: 'none' },
      panel: {
        position: 'absolute',
        // The dock sits at the bottom of the window, so the panel opens UP:
        // `bottom: 100%` measures from the wrapper's padding box, placing the
        // panel just above the 6px hover bridge. The chip is right-aligned, so
        // the panel hangs off its right edge and grows leftward, staying on
        // screen instead of overflowing the window.
        bottom: '100%',
        right: 0,
        zIndex: 50,
        minWidth: 230,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-module-platform, #1e1e1e)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        // Same secondary scale as the dock pills, so the panel and the chip
        // never show two different type sizes.
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        boxShadow: '0 8px 24px rgba(0,0,0,.35)'
      },
      panelTitle: {
        fontWeight: 600,
        marginBottom: 6,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12
      },
      row: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '3px 0'
      },
      muted: { opacity: 0.65 },
      error: { color: '#f85149', whiteSpace: 'pre-wrap', maxWidth: 260 },
      refresh: {
        marginTop: 8,
        width: '100%',
        padding: '5px 0',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        cursor: 'pointer'
      }
    }

    function formatTime(timestamp) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
      return new Date(timestamp).toLocaleTimeString()
    }

    /**
     * The session-header chip. `t` is the standard slot translate prop bound
     * to this plugin's locale namespace when present.
     */
    function UsageChip(props) {
      const tr = (key) => (typeof props.t === 'function' ? props.t(key) : (zh[key] ?? key))
      const [data, setData] = useState({ status: 'loading' })
      const [open, setOpen] = useState(false)
      const failures = useRef(0)

      /** Read the host snapshot; resolves with the value it just stored. */
      const load = useCallback(async () => {
        let value
        try {
          const response = await fetch('/deepseek-usage/balance', {
            headers: { accept: 'application/json' }
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          value = await response.json()
        } catch (error) {
          value = {
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          }
        }
        failures.current = value.status === 'ok' ? 0 : failures.current + 1
        setData(value)
        return value
      }, [])

      // Self-scheduling poll. A plain fixed interval left the chip blank for up
      // to a full minute whenever the app opened before the host's first fetch
      // succeeded, so the delay now adapts: ~1.2s until a reading lands, then
      // the steady cadence, with a short back-off while reads keep failing.
      useEffect(() => {
        let cancelled = false
        let timer = null
        const tick = async () => {
          const value = await load()
          if (cancelled) return
          timer = window.setTimeout(tick, pollDelayMs(value, failures.current))
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [load])

      // Returning to the page is exactly when a stale reading is most visible,
      // so re-read as soon as the tab/window becomes active again.
      useEffect(() => {
        const wake = () => {
          if (document.visibilityState !== 'hidden') void load()
        }
        document.addEventListener('visibilitychange', wake)
        window.addEventListener('focus', wake)
        return () => {
          document.removeEventListener('visibilitychange', wake)
          window.removeEventListener('focus', wake)
        }
      }, [load])

      const refresh = useCallback(async () => {
        try {
          const response = await fetch('/deepseek-usage/refresh', {
            method: 'POST',
            headers: { accept: 'application/json' }
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const value = await response.json()
          failures.current = value.status === 'ok' ? 0 : failures.current + 1
          setData(value)
        } catch (error) {
          failures.current += 1
          setData({
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }, [])

      // A last-good reading rides along with an error, so the chip keeps
      // showing the amount (flagged stale) instead of blanking out.
      const balance =
        data !== null && typeof data.balance === 'object' && data.balance !== null
          ? data.balance
          : null
      const hasInfo = balance !== null && Array.isArray(balance.infos) && balance.infos.length > 0
      const info = hasInfo ? balance.infos[0] : null
      const failed = typeof data.error === 'string' && data.error.length > 0

      let chipLabel
      if (hasInfo) {
        chipLabel = `${currencySymbol(info.currency)}${info.totalBalance}`
      } else if (failed) {
        chipLabel = tr('error')
      } else if (data.status === 'ok') {
        chipLabel = tr('noData')
      } else {
        chipLabel = tr('loading')
      }

      const dotColor = failed
        ? '#f85149'
        : hasInfo
          ? balance.isAvailable === true
            ? '#3fb950'
            : '#d29922'
          : '#8b949e'

      const panelChildren = []
      if (hasInfo) {
        for (const [label, value] of [
          [tr('total'), `${currencySymbol(info.currency)}${info.totalBalance}`],
          [tr('toppedUp'), `${currencySymbol(info.currency)}${info.toppedUpBalance}`],
          [tr('granted'), `${currencySymbol(info.currency)}${info.grantedBalance}`]
        ]) {
          panelChildren.push(
            React.createElement('div', { key: label, style: styles.row },
              React.createElement('span', { style: styles.muted }, label),
              React.createElement('span', null, value)
            )
          )
        }
      } else if (!failed) {
        panelChildren.push(
          React.createElement('div', { key: 'nodata', style: styles.muted },
            data.status === 'ok' ? tr('noData') : tr('loading'))
        )
      }
      if (failed) {
        panelChildren.push(
          React.createElement('div', { key: 'error', style: styles.error }, data.error)
        )
        if (hasInfo) {
          panelChildren.push(
            React.createElement('div', { key: 'stale', style: styles.muted }, tr('stale'))
          )
        }
      }
      const updated = formatTime(data.fetchedAt)
      panelChildren.push(
        React.createElement('div', { key: 'updated', style: { ...styles.row, ...styles.muted } },
          React.createElement('span', null, updated.length > 0 ? tr('updatedAt').replace('{time}', updated) : '')
        )
      )
      panelChildren.push(
        React.createElement('button', {
          key: 'refresh',
          type: 'button',
          style: styles.refresh,
          onClick: refresh
        }, tr('refresh'))
      )

      // Hover drives the panel: pointer over the chip (or the panel, which is a
      // DOM child of the wrapper) keeps it open, leaving closes it. Focus does
      // the same for keyboard users; the contains() check keeps the refresh
      // button from closing the panel when focus moves inside it.
      return React.createElement('div', {
        style: styles.wrapper,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: (event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }
      },
        React.createElement('button', {
          type: 'button',
          style: styles.chip,
          title: tr('title')
        },
          React.createElement('span', { style: { ...styles.dot, background: dotColor } }),
          React.createElement('span', null, chipLabel)
        ),
        open &&
          React.createElement('div', { style: styles.panel },
            React.createElement('div', { style: styles.panelTitle },
              React.createElement('span', null, tr('title')),
              hasInfo
                ? React.createElement('span', {
                    style: {
                      color: balance.isAvailable === true ? '#3fb950' : '#d29922'
                    }
                  }, balance.isAvailable === true ? tr('available') : tr('unavailable'))
                : null
            ),
            panelChildren
          )
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-usage: dictionaries')
      // The composer dock row under the input box — the same strip as the
      // cache-hit / tokens-per-second stats (ui-chat registers its "stats"
      // occupant there with order 0, so order 10 lands right after it).
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'deepseek-usage',
          order: 10,
          locale: NS
        }, UsageChip)
      )
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
