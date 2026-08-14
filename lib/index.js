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

  /** Cached snapshot; only scalars and plain JSON, safe to stringify. */
  const state = {
    status: 'idle', // 'loading' | 'ok' | 'error'
    fetchedAt: 0,
    balance: null, // normalized { isAvailable, infos: [...] } | null
    error: null // string | null
  }

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

  /** One balance query; always writes a coherent snapshot into `state`. */
  async function refresh() {
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
    } catch (error) {
      state.status = 'error'
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.fetchedAt = Date.now()
    }
  }

  /** The JSON the browser renders; stable shape regardless of status. */
  function snapshot() {
    const base = { status: state.status, fetchedAt: state.fetchedAt }
    if (state.status === 'ok') return { ...base, balance: state.balance }
    if (state.status === 'error') return { ...base, error: state.error }
    return base
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
      sendJson(res, 200, snapshot(), method)
      return
    }
    if (pathname === '/deepseek-usage/refresh' && method === 'POST') {
      void refresh()
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

  // First fetch immediately, then keep the snapshot fresh.
  void refresh()
  ctx.interval(() => void refresh(), refreshIntervalMs)
}
