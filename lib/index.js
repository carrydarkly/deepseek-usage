/**
 * deepseek-usage — host half.
 *
 * Periodically queries the DeepSeek `/user/balance` endpoint with the
 * configured API key and serves a cached snapshot to the browser over two
 * same-origin HTTP routes:
 *
 *   GET  /deepseek-usage/balance  -> cached snapshot (JSON)
 *   POST /deepseek-usage/refresh  -> force a refresh, then the snapshot
 *
 * The API key never leaves the host: it is resolved per refresh through the
 * `credentials` service (the same seam the web Models page writes), falling
 * back to the process environment, then to a literal `apiKey` config value.
 *
 * This is a plain Cordis plugin: no imports beyond the platform. The loader
 * calls `apply(ctx, config)` with the row's `config` object; the `timer`
 * injection supplies `ctx.interval()` (effect-owned), and the `webServer`
 * injection guarantees the HTTP routes register only after the webserver
 * mounts.
 */

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
    error: null // string | null
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
   * `error`, and `stale` marks that pairing so the chip can keep showing the
   * amount while flagging it as not freshly confirmed.
   */
  function snapshot() {
    return {
      status: state.status,
      fetchedAt: state.fetchedAt,
      attemptedAt: state.attemptedAt,
      ...(state.balance === null ? {} : { balance: state.balance }),
      ...(state.error === null ? {} : { error: state.error }),
      stale: state.balance !== null && state.error !== null
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
