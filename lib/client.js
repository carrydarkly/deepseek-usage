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
    const { useState, useEffect, useCallback } = React

    const NS = 'deepseek-usage'
    const POLL_INTERVAL_MS = 60000

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
      'noData': 'No balance data'
    }

    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return `${currency} `
    }

    /** Colors follow theme tokens where they exist, with safe fallbacks. */
    const styles = {
      wrapper: { position: 'relative', display: 'inline-flex' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12,
        lineHeight: 1,
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap'
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: 'none' },
      panel: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        zIndex: 50,
        minWidth: 230,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-module-platform, #1e1e1e)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 12,
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
        fontSize: 12,
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

      const load = useCallback(async () => {
        try {
          const response = await fetch('/deepseek-usage/balance', {
            headers: { accept: 'application/json' }
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setData(await response.json())
        } catch (error) {
          setData({
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }, [])

      useEffect(() => {
        load()
        const timer = window.setInterval(load, POLL_INTERVAL_MS)
        return () => window.clearInterval(timer)
      }, [load])

      const refresh = useCallback(async () => {
        setData({ status: 'loading' })
        try {
          const response = await fetch('/deepseek-usage/refresh', {
            method: 'POST',
            headers: { accept: 'application/json' }
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setData(await response.json())
        } catch (error) {
          setData({
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }, [])

      const hasInfo =
        data.status === 'ok' &&
        data.balance !== null &&
        Array.isArray(data.balance.infos) &&
        data.balance.infos.length > 0
      const info = hasInfo ? data.balance.infos[0] : null

      let chipLabel
      if (data.status === 'ok') {
        chipLabel = hasInfo
          ? `${currencySymbol(info.currency)}${info.totalBalance}`
          : tr('noData')
      } else if (data.status === 'error') {
        chipLabel = tr('error')
      } else {
        chipLabel = tr('loading')
      }

      const dotColor =
        data.status === 'ok'
          ? data.balance.isAvailable === true
            ? '#3fb950'
            : '#d29922'
          : '#f85149'

      const panelChildren = []
      if (data.status === 'ok') {
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
        } else {
          panelChildren.push(
            React.createElement('div', { key: 'nodata', style: styles.muted }, tr('noData'))
          )
        }
      } else if (data.status === 'error') {
        panelChildren.push(
          React.createElement('div', { key: 'error', style: styles.error }, data.error ?? tr('error'))
        )
      } else {
        panelChildren.push(
          React.createElement('div', { key: 'loading', style: styles.muted }, tr('loading'))
        )
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

      return React.createElement('div', { style: styles.wrapper },
        React.createElement('button', {
          type: 'button',
          style: styles.chip,
          onClick: () => setOpen((value) => !value),
          title: tr('title')
        },
          React.createElement('span', { style: { ...styles.dot, background: dotColor } }),
          React.createElement('span', null, chipLabel)
        ),
        open &&
          React.createElement('div', { style: styles.panel },
            React.createElement('div', { style: styles.panelTitle },
              React.createElement('span', null, tr('title')),
              data.status === 'ok'
                ? React.createElement('span', {
                    style: {
                      color: data.balance.isAvailable === true ? '#3fb950' : '#d29922'
                    }
                  }, data.balance.isAvailable === true ? tr('available') : tr('unavailable'))
                : null
            ),
            panelChildren
          )
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-usage: dictionaries')
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'deepseek-usage',
          order: 30,
          locale: NS
        }, UsageChip)
      )
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
