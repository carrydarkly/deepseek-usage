/**
 * deepseek-usage — host half.
 *
 * Queries the DeepSeek `/user/balance` endpoint with the configured API key,
 * tracks how fast each successful reading is being spent, and serves the result
 * to the browser over same-origin HTTP routes:
 *
 *   GET  /deepseek-usage/balance  -> cached snapshot (JSON)
 *   POST /deepseek-usage/refresh  -> force a refresh, then the snapshot
 *   GET  /deepseek-usage/config   -> the alert settings
 *   POST /deepseek-usage/config   -> replace the alert settings
 *
 * Two user-owned thresholds drive the chip's state:
 *
 *   warnBelow         total balance at or below this -> `low` (amber dot)
 *   alertBurnPerHour  estimated spend rate at or above this -> `abnormal` (red)
 *
 * The burn rate is the balance drop between successful readings, scaled to one
 * hour across a trailing window, so it reflects token consumption without
 * needing any per-token accounting. The thresholds are stored in
 * `$DSH_HOME/deepseek-usage.json` (written by the settings card); until that
 * document exists this row's `config` supplies them.
 *
 * The API key never leaves the host: it is resolved per refresh through the
 * `credentials` service, falling back to the process environment and then to a
 * literal `apiKey` config value.
 *
 * The loader calls `apply(ctx, config)`; `timer` supplies `ctx.interval()` and
 * `ctx.timeout()` (both effect-owned) and `webServer` guarantees the routes
 * register only after the webserver mounts.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'deepseek-usage'

export const inject = ['timer', 'webServer']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_REFRESH_INTERVAL_MS = 60000
/**
 * Retry delays (ms) used while the latest attempt has failed: a cold start
 * whose first request loses the race against the network or the credential
 * store recovers in seconds instead of waiting out the whole cadence.
 */
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000]
/** Settings document (inside `$DSH_HOME`) holding the two alert thresholds. */
const SETTINGS_FILENAME = 'deepseek-usage.json'
/** Successful readings kept for the burn-rate estimate. */
const MAX_SAMPLES = 12
/** Only readings from this trailing window feed the estimate. */
const SAMPLE_WINDOW_MS = 15 * 60 * 1000
/** Upper bound for a settings POST body. */
const MAX_BODY_BYTES = 4096

/** Build the /user/balance URL, tolerating a trailing slash on baseURL. */
function balanceUrl(baseURL) {
  return `${String(baseURL).replace(/\/+$/, '')}/user/balance`
}

/**
 * Query DeepSeek's balance endpoint. Throws with a readable message on any
 * non-2xx response or parse failure.
 */
async function fetchBalance(baseURL, apiKey, signal) {
  const response = await fetch(balanceUrl(baseURL), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json'
    },
    signal
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      /* response body unreadable; report the status alone */
    }
    throw new Error(
      `DeepSeek 余额接口返回 HTTP ${response.status}${detail.length > 0 ? `：${detail}` : ''}`
    )
  }
  return await response.json()
}

/** Keep a balance value as the display string DeepSeek sends. */
function stringifyBalance(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Project the raw API body into the small JSON the browser renders. */
function normalizeBalance(raw) {
  const isAvailable = raw !== null && typeof raw === 'object' && raw.is_available === true
  const infos = Array.isArray(raw?.balance_infos)
    ? raw.balance_infos.map((info) => ({
        currency:
          typeof info?.currency === 'string' && info.currency.length > 0
            ? info.currency
            : 'CNY',
        totalBalance: stringifyBalance(info?.total_balance),
        grantedBalance: stringifyBalance(info?.granted_balance),
        toppedUpBalance: stringifyBalance(info?.topped_up_balance)
      }))
    : []
  return { isAvailable, infos }
}

/** The DSH home directory the settings document lives in. */
function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0
    ? fromEnv.trim()
    : join(homedir(), '.dsh')
}

/** Snap an amount to the two decimals DeepSeek bills in. */
function round2(value) {
  return Math.round(value * 100) / 100
}

/** Integer cents, so threshold comparisons never suffer binary-float drift. */
function cents(value) {
  return Math.round(value * 100)
}

/**
 * Read one threshold. An empty or non-positive value means "feature off" and
 * yields `null`; anything numeric and positive yields the number.
 */
function thresholdOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Keep a settings payload to the two known keys, as trimmed display strings. */
function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (key) => {
    const value = source[key]
    if (typeof value === 'string') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value)
    return ''
  }
  return { warnBelow: pick('warnBelow'), alertBurnPerHour: pick('alertBurnPerHour') }
}

/**
 * Load the stored settings document. Returns `null` when it does not exist (or
 * is unreadable), so this row's `config` still applies; once the document
 * exists it owns the values, so clearing a field in the settings card really
 * turns that alert off.
 */
function loadStoredSettings(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    return normalizeSettings(raw)
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const apiKeyEnv =
    typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0
      ? config.apiKeyEnv
      : DEFAULT_API_KEY_ENV
  const baseURL =
    typeof config.baseURL === 'string' && config.baseURL.length > 0
      ? config.baseURL
      : DEFAULT_BASE_URL
  const refreshIntervalMs =
    Number.isFinite(config.refreshIntervalMs) && config.refreshIntervalMs > 0
      ? config.refreshIntervalMs
      : DEFAULT_REFRESH_INTERVAL_MS
  const literalApiKey =
    typeof config.apiKey === 'string' && config.apiKey.length > 0
      ? config.apiKey
      : undefined
  /** A browser read older than this triggers a refresh in the background. */
  const staleAfterMs = Math.max(5000, Math.floor(refreshIntervalMs / 2))

  const settingsFile = join(dshHomeDir(), SETTINGS_FILENAME)
  /** Effective alert thresholds: the stored document wins, then this row. */
  let settings = loadStoredSettings(settingsFile) ?? normalizeSettings(config)
  /** Last write failure, surfaced to the settings card so it can say so. */
  let settingsWriteError = null

  /**
   * Cached snapshot. `balance` holds the LAST GOOD value and survives a failed
   * attempt, so the browser keeps showing an amount (flagged stale) while a
   * retry runs instead of blanking out. Only scalars and plain JSON.
   */
  const state = {
    status: 'idle', // 'idle' | 'loading' | 'ok' | 'error'
    fetchedAt: 0, // last successful fetch
    attemptedAt: 0, // last attempt, success or not
    balance: null, // normalized { isAvailable, infos: [...] } | null
    error: null, // string | null
    samples: [] // recent { at, total } readings, oldest first
  }
  let failureCount = 0
  /** In-flight refresh, shared so concurrent callers coalesce into one request. */
  let inFlight = null

  /** Resolve the key: literal config, credentials service, then process env. */
  async function resolveApiKey() {
    if (literalApiKey !== undefined) return literalApiKey
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(apiKeyEnv)
        if (
          resolved !== null &&
          typeof resolved === 'object' &&
          typeof resolved.value === 'string' &&
          resolved.value.length > 0
        ) {
          return resolved.value
        }
      } catch {
        /* provider failure falls through to the environment */
      }
    }
    const ambient = process.env[apiKeyEnv]
    if (typeof ambient === 'string' && ambient.length > 0) return ambient
    return undefined
  }

  /** The first balance entry, which is what the chip displays. */
  function primaryInfo() {
    const infos = state.balance === null ? null : state.balance.infos
    return Array.isArray(infos) && infos.length > 0 ? infos[0] : null
  }

  /** Total balance of the displayed entry as a number, or null. */
  function totalBalance() {
    const info = primaryInfo()
    if (info === null) return null
    const parsed = Number.parseFloat(info.totalBalance)
    return Number.isFinite(parsed) ? parsed : null
  }

  /**
   * Estimated spend per hour from the trailing readings, or null while fewer
   * than two are available. A top-up (balance rising) counts as no spend.
   */
  function burnPerHour() {
    const now = Date.now()
    const recent = state.samples.filter(
      (sample) => sample.total !== null && now - sample.at <= SAMPLE_WINDOW_MS
    )
    if (recent.length < 2) return null
    const first = recent[0]
    const last = recent[recent.length - 1]
    const hours = (last.at - first.at) / 3600000
    if (!(hours > 0)) return null
    const spent = first.total - last.total
    return spent > 0 ? spent / hours : 0
  }

  /**
   * Everything the chip colours itself from, derived once per read.
   *
   * Every amount is snapped to two decimals (the precision DeepSeek bills in)
   * and the comparisons run on integer cents, so "balance 13.00 against a
   * warning amount of 13.00" is an exact hit rather than a float accident.
   */
  function derived() {
    const totalRaw = totalBalance()
    const total = totalRaw === null ? null : round2(totalRaw)
    const rateRaw = burnPerHour()
    const rate = rateRaw === null ? null : round2(rateRaw)
    const warnBelow = thresholdOf(settings.warnBelow)
    const alertBurnPerHour = thresholdOf(settings.alertBurnPerHour)
    return {
      total,
      burnPerHour: rate,
      warnBelow: warnBelow === null ? null : round2(warnBelow),
      alertBurnPerHour: alertBurnPerHour === null ? null : round2(alertBurnPerHour),
      low:
        warnBelow !== null &&
        total !== null &&
        cents(total) <= cents(round2(warnBelow)),
      abnormal:
        alertBurnPerHour !== null &&
        rate !== null &&
        cents(rate) >= cents(round2(alertBurnPerHour))
    }
  }

  /** Persist the thresholds; a failure is reported instead of thrown. */
  function saveSettings(next) {
    settings = next
    try {
      mkdirSync(dirname(settingsFile), { recursive: true })
      writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      settingsWriteError = null
    } catch (error) {
      settingsWriteError = error instanceof Error ? error.message : String(error)
    }
    return settingsWriteError
  }

  /**
   * One balance query. Concurrent callers share a single in-flight request, and
   * a failure keeps the previous `balance` so the UI can degrade to "stale"
   * rather than "no data".
   */
  async function refresh() {
    if (inFlight !== null) return await inFlight
    inFlight = (async () => {
      state.status = 'loading'
      try {
        const apiKey = await resolveApiKey()
        if (apiKey === undefined) {
          throw new Error(
            `未配置 API Key：请在 Models 设置页写入 ${apiKeyEnv} 凭据，或在启动环境中导出该变量`
          )
        }
        state.balance = normalizeBalance(await fetchBalance(baseURL, apiKey))
        state.error = null
        state.status = 'ok'
        state.fetchedAt = Date.now()
        failureCount = 0
        const total = totalBalance()
        state.samples.push({ at: state.fetchedAt, total: total === null ? null : round2(total) })
        if (state.samples.length > MAX_SAMPLES) {
          state.samples.splice(0, state.samples.length - MAX_SAMPLES)
        }
      } catch (error) {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
        failureCount += 1
      } finally {
        state.attemptedAt = Date.now()
      }
    })()
    try {
      await inFlight
    } finally {
      inFlight = null
    }
  }

  /** Delay before the next retry: quick at first, backing off toward the cadence. */
  function retryDelayMs() {
    const step = Math.min(Math.max(failureCount, 1), RETRY_DELAYS_MS.length) - 1
    return RETRY_DELAYS_MS[step] ?? refreshIntervalMs
  }

  // At most one retry timer is ever pending; it is armed only after a failure,
  // so the healthy path stays on the plain interval.
  let retryPending = false
  async function refreshNow() {
    await refresh()
    if (retryPending || state.status === 'ok') return
    retryPending = true
    ctx.timeout(() => {
      retryPending = false
      void refreshNow()
    }, retryDelayMs())
  }

  /**
   * The JSON the browser renders. A last-good `balance` rides along with
   * `error`, and `stale` marks that pairing. `total` / `burnPerHour` /
   * `low` / `abnormal` drive the chip; `settings` feeds the settings card.
   */
  function snapshot() {
    const value = derived()
    return {
      status: state.status,
      fetchedAt: state.fetchedAt,
      attemptedAt: state.attemptedAt,
      ...(state.balance === null ? {} : { balance: state.balance }),
      ...(state.error === null ? {} : { error: state.error }),
      stale: state.balance !== null && state.error !== null,
      total: value.total,
      burnPerHour: value.burnPerHour,
      low: value.low,
      abnormal: value.abnormal,
      thresholds: { warnBelow: value.warnBelow, alertBurnPerHour: value.alertBurnPerHour },
      settings: { ...settings }
    }
  }

  function sendJson(res, status, body, method) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload)
    })
    res.end(method === 'HEAD' ? undefined : payload)
  }

  /** Collect a small JSON request body, rejecting anything oversized. */
  function readJsonBody(req, callback) {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      callback(error, value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (error) => finish(error))
  }

  /** Owns the full response lifecycle for every /deepseek-usage request. */
  function handleRoute(req, res) {
    const method = req.method ?? 'GET'
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    if (pathname === '/deepseek-usage/balance' && (method === 'GET' || method === 'HEAD')) {
      // A browser request is the earliest signal that someone is looking, so
      // nudge a refresh whenever the snapshot is unhealthy or half-stale. The
      // response is still served immediately from the current snapshot.
      if (state.status !== 'ok' || Date.now() - state.fetchedAt > staleAfterMs) {
        void refreshNow()
      }
      sendJson(res, 200, snapshot(), method)
      return
    }
    if (pathname === '/deepseek-usage/refresh' && method === 'POST') {
      void refreshNow()
        .then(() => sendJson(res, 200, snapshot(), method))
        .catch((error) => {
          sendJson(res, 500, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          }, method)
        })
      return
    }
    if (pathname === '/deepseek-usage/config' && (method === 'GET' || method === 'HEAD')) {
      // The settings card also reads the live figures, so it can show the
      // current spend rate next to the field it calibrates.
      sendJson(res, 200, {
        ...snapshot(),
        file: settingsFile,
        writeError: settingsWriteError
      }, method)
      return
    }
    if (pathname === '/deepseek-usage/config' && method === 'POST') {
      readJsonBody(req, (error, body) => {
        if (error !== null) {
          sendJson(res, 400, { error: error.message }, method)
          return
        }
        const next = normalizeSettings(body)
        // A provided value must be usable as a positive number; a value the
        // caller left out or blanked turns that alert off.
        for (const [key, label] of [
          ['warnBelow', '预警额度'],
          ['alertBurnPerHour', '异常速率阈值']
        ]) {
          if (next[key].length > 0 && thresholdOf(next[key]) === null) {
            sendJson(res, 400, { error: `${label}需要一个正数，或留空表示关闭` }, method)
            return
          }
        }
        const writeError = saveSettings(next)
        sendJson(res, 200, { ...snapshot(), writeError }, method)
      })
      return
    }
    sendJson(res, 404, { error: 'not found' }, method)
  }

  // Serve the routes; `webServer` is injected, so it is present here.
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/deepseek-usage', handler: handleRoute }),
    'deepseek-usage: http routes'
  )

  // First fetch immediately, then keep the snapshot fresh on the cadence;
  // failures additionally self-schedule a fast retry inside `refreshNow`.
  void refreshNow()
  ctx.interval(() => void refreshNow(), refreshIntervalMs)
}
