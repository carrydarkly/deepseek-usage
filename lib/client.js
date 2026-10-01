/**
 * deepseek-usage — browser half.
 *
 * Two surfaces:
 *
 * 1. A balance chip in the composer dock row (next to the cache-hit / tok-s
 *    stats). Its dot is the account state: amber when the balance reached the
 *    configured warning threshold, red when the last read failed or when the
 *    spend rate exceeded the configured alert rate — and in either red case the
 *    chip shows the reason instead of the amount, so the two causes are never
 *    confused. Hovering opens a panel with the full breakdown.
 * 2. A settings card in Settings → Plugins, where the two thresholds live.
 *
 * The bundle runs in the real browser page, so it uses native `fetch` and
 * `window.setTimeout`; React comes from the shared module table.
 */

window.__ModuleLoader__.load({
  id: 'deepseek-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'deepseek-usage'
    const CONFIG_URL = '/deepseek-usage/config'
    /** Same-page ping so a saved threshold reaches the chip immediately. */
    const SETTINGS_EVENT = 'deepseek-usage:settings-changed'
    /** Steady-state poll: the host refreshes on the same order of magnitude. */
    const POLL_HEALTHY_MS = 60000
    /** Poll while the first reading is still on its way (cold app start). */
    const POLL_FAST_MS = 1200
    /** Poll back-off while reads keep failing, before joining the steady cadence. */
    const POLL_ERROR_STEPS_MS = [2000, 4000, 8000, 15000, 30000]
    /** Dot palette: healthy / threshold warning / failure or abnormal. */
    const DOT_OK = '#3fb950'
    const DOT_WARN = '#d29922'
    const DOT_BAD = '#f85149'
    const DOT_IDLE = '#8b949e'
    /** Ring geometry — same 14px box as the stats pills' icons. */
    const RING_SIZE = 14
    const RING_STROKE = 2
    const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
    /** The unseen part of a short ring, so the track reads as "used up". */
    const RING_TRACK = 'var(--dsw-alias-border-l2, rgba(128,128,128,.4))'

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
      'noData': '暂无余额数据',
      'failed': '拉取失败',
      'abnormal': '消耗异常',
      'low': '余额偏低',
      'burnRate': '消耗速率',
      'perHour': '{value}/小时',
      'warnBelow': '预警额度',
      'abnormalThreshold': '异常速率阈值',
      'notSet': '未设置',
      'settingsHint': '可在 设置 → 插件配置 中调整阈值',
      'settingsNav': '余额预警',
      'settingsIntro': '总余额低于预警额度时徽标转黄；消耗速率超过异常阈值时转红并显示「消耗异常」。留空表示关闭该项。',
      'settingsRate': '当前消耗速率',
      'save': '保存',
      'saved': '已保存',
      'saveFailed': '设置已生效，但写入文件失败：{message}',
      'hostStale': '宿主插件尚未重载：请完全退出并重新打开 DeepSeek Harness 后再试'
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
      'noData': 'No balance data',
      'failed': 'Fetch failed',
      'abnormal': 'Abnormal usage',
      'low': 'Low balance',
      'burnRate': 'Burn rate',
      'perHour': '{value}/h',
      'warnBelow': 'Warn below',
      'abnormalThreshold': 'Abnormal burn rate',
      'notSet': 'Not set',
      'settingsHint': 'Adjust the thresholds in Settings → Plugins',
      'settingsNav': 'Balance alerts',
      'settingsIntro': 'The dot turns amber when the total balance drops to the warning amount, and red with "Abnormal usage" when the spend rate passes the alert rate. Leave a field empty to switch that alert off.',
      'settingsRate': 'Current burn rate',
      'save': 'Save',
      'saved': 'Saved',
      'saveFailed': 'Applied, but writing the file failed: {message}',
      'hostStale': 'The host half of this plugin has not reloaded yet — fully quit and reopen DeepSeek Harness, then try again'
    }

    /** Interpolate `{name}` placeholders. */
    function format(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined ? match : String(params[key])
      )
    }

    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      if (currency === 'EUR') return '€'
      return `${currency} `
    }

    /**
     * Render a money amount with exactly the two decimals DeepSeek bills in, so
     * every figure in the chip and panel reads at the same precision.
     */
    function money(value, symbol) {
      const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
      return Number.isFinite(parsed) ? `${symbol}${parsed.toFixed(2)}` : `${symbol}${String(value ?? '')}`
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

    function formatTime(timestamp) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
      return new Date(timestamp).toLocaleTimeString()
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
        minWidth: 240,
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
      alert: { color: DOT_BAD, whiteSpace: 'pre-wrap', maxWidth: 260 },
      hint: {
        marginTop: 6,
        opacity: 0.65,
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)'
      },
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
      },
      // Settings card (Settings → Plugins).
      form: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 },
      intro: {
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: '20px'
      },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      fieldLabel: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        lineHeight: '20px'
      },
      fieldHint: {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
        lineHeight: '18px'
      },
      input: {
        boxSizing: 'border-box',
        width: 220,
        height: 34,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        fontVariantNumeric: 'tabular-nums'
      },
      actions: { display: 'flex', alignItems: 'center', gap: 12 },
      button: {
        height: 32,
        padding: '0 16px',
        borderRadius: 8,
        border: 'none',
        background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
        color: '#fff',
        font: 'inherit',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        cursor: 'pointer'
      },
      statusText: {
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
        color: 'var(--dsw-alias-label-tertiary, inherit)'
      },
      statusBad: { color: DOT_BAD }
    }

    /** The composer-dock chip. `t` is the slot translate prop when present. */
    function UsageChip(props) {
      const tr = (key, params) =>
        format(typeof props.t === 'function' ? props.t(key) : (zh[key] ?? key), params)
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

      // The settings card lives in this same page, so a save can repaint the
      // chip at once instead of waiting out the poll interval.
      useEffect(() => {
        const onSettings = () => void load()
        window.addEventListener(SETTINGS_EVENT, onSettings)
        return () => window.removeEventListener(SETTINGS_EVENT, onSettings)
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

      // A last-good reading rides along with an error, so the panel can still
      // show the amount while the chip reports why it is red.
      const balance =
        data !== null && typeof data.balance === 'object' && data.balance !== null
          ? data.balance
          : null
      const hasInfo = balance !== null && Array.isArray(balance.infos) && balance.infos.length > 0
      const info = hasInfo ? balance.infos[0] : null
      const symbol = hasInfo ? currencySymbol(info.currency) : ''
      const amount = hasInfo ? money(info.totalBalance, symbol) : null
      const failed = typeof data.error === 'string' && data.error.length > 0
      const abnormal = data.abnormal === true
      const low = data.low === true
      const rate = Number.isFinite(data.burnPerHour) ? data.burnPerHour : null
      const total = Number.isFinite(data.total) ? data.total : null
      const thresholds = data.thresholds ?? {}
      const warnBelow = Number.isFinite(thresholds.warnBelow) ? thresholds.warnBelow : null
      const alertBurn = Number.isFinite(thresholds.alertBurnPerHour)
        ? thresholds.alertBurnPerHour
        : null

      // Red carries two meanings, so it never shows a bare amount: the label
      // says which one applies.
      let chipLabel
      if (failed) chipLabel = tr('failed')
      else if (abnormal) chipLabel = tr('abnormal')
      else if (amount !== null) chipLabel = amount
      else if (data.status === 'ok') chipLabel = tr('noData')
      else chipLabel = tr('loading')

      // The ring is the alert gauge: a full circle is the warning amount, so a
      // healthy balance fills it green. Once the balance reaches the warning
      // amount the ring turns yellow and shrinks as the balance drains, leaving
      // the grey track behind it. A failed read or abnormal spend stays red, and
      // a not-yet-loaded snapshot is grey.
      const available = hasInfo ? balance.isAvailable === true : null
      const warn = low || available === false
      const ringColor =
        failed || abnormal
          ? DOT_BAD
          : !hasInfo
            ? DOT_IDLE
            : warn
              ? DOT_WARN
              : DOT_OK
      // Money is handled in integer cents end to end, so a balance of 13.00
      // against a warning amount of 13.00 is an exact hit (and the ring ratio
      // is not skewed by binary-float drift).
      const totalCents = total === null ? null : Math.round(total * 100)
      const warnCents = warnBelow === null ? null : Math.round(warnBelow * 100)
      const fraction =
        failed ||
        abnormal ||
        !warn ||
        totalCents === null ||
        warnCents === null ||
        warnCents <= 0 ||
        totalCents >= warnCents
          ? 1
          : Math.min(1, Math.max(0, totalCents / warnCents))

      const panelChildren = []
      if (hasInfo) {
        for (const [label, value] of [
          [tr('total'), amount],
          [tr('toppedUp'), money(info.toppedUpBalance, symbol)],
          [tr('granted'), money(info.grantedBalance, symbol)]
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
      if (rate !== null) {
        panelChildren.push(
          React.createElement('div', { key: 'rate', style: styles.row },
            React.createElement('span', { style: styles.muted }, tr('burnRate')),
            React.createElement('span', {
              style: abnormal ? { color: DOT_BAD } : undefined
            }, tr('perHour', { value: money(rate, symbol) }))
          )
        )
      }
      if (warnBelow !== null) {
        panelChildren.push(
          React.createElement('div', { key: 'warn', style: styles.row },
            React.createElement('span', { style: styles.muted }, tr('warnBelow')),
            React.createElement('span', {
              style: low ? { color: DOT_WARN } : undefined
            }, `${symbol}${warnBelow.toFixed(2)}`)
          )
        )
      }
      if (alertBurn !== null) {
        panelChildren.push(
          React.createElement('div', { key: 'alert', style: styles.row },
            React.createElement('span', { style: styles.muted }, tr('abnormalThreshold')),
            React.createElement('span', null, tr('perHour', { value: `${symbol}${alertBurn.toFixed(2)}` }))
          )
        )
      }
      if (abnormal) {
        panelChildren.push(
          React.createElement('div', { key: 'abnormalNote', style: styles.alert }, tr('abnormal'))
        )
      } else if (low) {
        panelChildren.push(
          React.createElement('div', { key: 'lowNote', style: { color: DOT_WARN } }, tr('low'))
        )
      }
      if (failed) {
        panelChildren.push(
          React.createElement('div', { key: 'error', style: styles.alert }, data.error)
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
          React.createElement('span', null, updated.length > 0 ? tr('updatedAt', { time: updated }) : '')
        )
      )
      panelChildren.push(
        React.createElement('div', { key: 'hint', style: styles.hint }, tr('settingsHint'))
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
          // The gauge: a 14px ring — grey track plus the coloured arc, rotated
          // so it fills from 12 o'clock.
          React.createElement('svg', {
            width: RING_SIZE,
            height: RING_SIZE,
            viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`,
            style: { flex: 'none', transform: 'rotate(-90deg)' },
            'aria-hidden': true
          },
            React.createElement('circle', {
              cx: RING_SIZE / 2,
              cy: RING_SIZE / 2,
              r: RING_RADIUS,
              fill: 'none',
              stroke: RING_TRACK,
              strokeWidth: RING_STROKE
            }),
            fraction > 0 &&
              React.createElement('circle', {
                cx: RING_SIZE / 2,
                cy: RING_SIZE / 2,
                r: RING_RADIUS,
                fill: 'none',
                stroke: ringColor,
                strokeWidth: RING_STROKE,
                strokeLinecap: 'round',
                strokeDasharray: RING_CIRCUMFERENCE,
                strokeDashoffset: RING_CIRCUMFERENCE * (1 - fraction)
              })
          ),
          React.createElement('span', null, chipLabel)
        ),
        open &&
          React.createElement('div', { style: styles.panel },
            React.createElement('div', { style: styles.panelTitle },
              React.createElement('span', null, tr('title')),
              hasInfo
                ? React.createElement('span', {
                    style: {
                      color: balance.isAvailable === true ? DOT_OK : DOT_WARN
                    }
                  }, balance.isAvailable === true ? tr('available') : tr('unavailable'))
                : null
            ),
            panelChildren
          )
      )
    }

    /**
     * Settings card (Settings → Plugins): the two thresholds, stored by the
     * host in `$DSH_HOME/deepseek-usage.json` and applied to the next read.
     */
    function UsageSettings(props) {
      const tr = (key, params) =>
        format(typeof props.t === 'function' ? props.t(key) : (zh[key] ?? key), params)
      const [draft, setDraft] = useState({ warnBelow: '', alertBurnPerHour: '' })
      const [live, setLive] = useState({ rate: null, symbol: '' })
      const [status, setStatus] = useState('idle') // 'idle' | 'saving' | 'saved' | 'error'
      const [message, setMessage] = useState('')

      const describe = useCallback((value) => {
        setDraft({
          warnBelow: typeof value?.settings?.warnBelow === 'string' ? value.settings.warnBelow : '',
          alertBurnPerHour:
            typeof value?.settings?.alertBurnPerHour === 'string'
              ? value.settings.alertBurnPerHour
              : ''
        })
        const info =
          value !== null && typeof value.balance === 'object' && value.balance !== null &&
          Array.isArray(value.balance.infos) && value.balance.infos.length > 0
            ? value.balance.infos[0]
            : null
        setLive({
          rate: Number.isFinite(value?.burnPerHour) ? value.burnPerHour : null,
          symbol: info === null ? '' : currencySymbol(info.currency)
        })
      }, [])

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const response = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } })
            const value = await response.json().catch(() => null)
            if (!response.ok) {
              throw new Error(
                response.status === 404
                  ? tr('hostStale')
                  : (value?.error ?? `HTTP ${response.status}`)
              )
            }
            if (!cancelled) describe(value)
          } catch (error) {
            if (!cancelled) {
              setStatus('error')
              setMessage(error instanceof Error ? error.message : String(error))
            }
          }
        })()
        return () => {
          cancelled = true
        }
        // `describe` is stable; `tr` only feeds the failure copy, so re-running
        // this on every render (which a `tr` dependency would cause) is wrong.
      }, [describe])

      const save = useCallback(async () => {
        setStatus('saving')
        setMessage('')
        try {
          const response = await fetch(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(draft)
          })
          const value = await response.json().catch(() => null)
          // A 404 here means the host half of this plugin predates these
          // routes: they only register when the app boots, so the card can do
          // nothing until the app is restarted.
          if (!response.ok) {
            throw new Error(
              response.status === 404 ? tr('hostStale') : (value?.error ?? `HTTP ${response.status}`)
            )
          }
          describe(value)
          // Let the chip pick the new thresholds up without waiting for its poll.
          try {
            window.dispatchEvent(new Event(SETTINGS_EVENT))
          } catch {
            /* the next poll still catches up */
          }
          if (typeof value?.writeError === 'string' && value.writeError.length > 0) {
            setStatus('error')
            setMessage(tr('saveFailed', { message: value.writeError }))
          } else {
            setStatus('saved')
          }
        } catch (error) {
          setStatus('error')
          setMessage(error instanceof Error ? error.message : String(error))
        }
      }, [describe, draft, tr])

      const field = (key, valueKey) =>
        React.createElement('label', { style: styles.field, key },
          React.createElement('span', { style: styles.fieldLabel }, tr(key)),
          React.createElement('input', {
            type: 'text',
            inputMode: 'decimal',
            style: styles.input,
            value: draft[valueKey],
            placeholder: tr('notSet'),
            onChange: (event) => {
              const next = event.target.value
              setDraft((previous) => ({ ...previous, [valueKey]: next }))
              if (status !== 'idle') setStatus('idle')
            }
          })
        )

      const rateText =
        live.rate === null ? tr('notSet') : tr('perHour', { value: money(live.rate, live.symbol) })

      return React.createElement('div', { style: styles.form },
        React.createElement('p', { style: styles.intro }, tr('settingsIntro')),
        field('warnBelow', 'warnBelow'),
        field('abnormalThreshold', 'alertBurnPerHour'),
        React.createElement('div', { style: styles.fieldHint },
          `${tr('settingsRate')}：${rateText}`),
        React.createElement('div', { style: styles.actions },
          React.createElement('button', {
            type: 'button',
            style: styles.button,
            onClick: save,
            disabled: status === 'saving'
          }, tr('save')),
          status === 'saved'
            ? React.createElement('span', { style: styles.statusText }, tr('saved'))
            : null,
          status === 'error' && message.length > 0
            ? React.createElement('span', {
                style: { ...styles.statusText, ...styles.statusBad }
              }, message)
            : null
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
      // Settings → Plugins gets one tab per feature-owned page; the label is a
      // function so it follows the active language.
      const t = typeof ctx.locale.bind === 'function'
        ? ctx.locale.bind(NS)
        : (key) => zh[key] ?? key
      ctx.slots.inject('settings.plugins.tab', () =>
        ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'deepseek-usage',
          order: 40,
          label: () => t('settingsNav'),
          locale: NS
        }, UsageSettings)
      )
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
