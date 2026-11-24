// magpie/OpenCode 供应商插件：CCode（ccode.si）
// 作用：
//   1. 把供应商指向 ccode.si 的 API 地址（用户只需填 API key）
//   2. 通过 auth.usage 钩子查询套餐余额与用量，在 magpie 里显示
// 官方 API 文档：https://ccode.si/docs/api

const PROVIDER = "ccode"
const PLUGIN_VERSION = "0.1.0"

// CCode 网关地址：
// - OpenAI 格式基地址（chat completions）带 /v1
// - Anthropic 格式基地址不带 /v1（SDK 自己补 /v1/messages）
const OPENAI_BASE = "https://api.ccode.si/v1"
const ANTHROPIC_BASE = "https://api.ccode.si"

// ccode.si 同时支持 OpenAI 与 Anthropic 两种格式，所有模型都可用任意格式回答。
// 这里用 openai-compatible（chat completions），magpie 会把任何 agent 的请求都转换成这个格式。
const SDK_NPM = "@ai-sdk/openai-compatible"

// 官网公布的 26 个模型（作为首次离线时的兜底列表；登录后由 provider.models 从 /models 动态刷新）
const DEFAULT_MODELS = {
  "claude-opus-5-5": { name: "Claude Opus 5.5", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", limit: { context: 200000, output: 64000 }, reasoning: true, tool_call: true },
  "claude-fable-5-2": { name: "Claude Fable 5.2", limit: { context: 200000, output: 64000 }, reasoning: true, tool_call: true },
  "claude-fable-5-1": { name: "Claude Fable 5.1", limit: { context: 200000, output: 64000 }, reasoning: true, tool_call: true },
  "claude-opus-5": { name: "Claude Opus 5", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
  "claude-sonnet-5": { name: "Claude Sonnet 5", limit: { context: 200000, output: 64000 }, reasoning: true, tool_call: true },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", limit: { context: 200000, output: 64000 }, tool_call: true },
  "gpt-6-2-sol": { name: "GPT-6.2 Sol", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-6-2-astra": { name: "GPT-6.2 Astra", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-6-1-sol": { name: "GPT-6.1 Sol", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-6-sol": { name: "GPT-6 Sol", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-6-astra": { name: "GPT-6 Astra", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-6-luna": { name: "GPT-6 Luna", limit: { context: 400000, output: 128000 }, tool_call: true },
  "gpt-5-6-sol": { name: "GPT-5.6 Sol", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-5-6-terra": { name: "GPT-5.6 Terra", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-5-6-luna": { name: "GPT-5.6 Luna", limit: { context: 400000, output: 128000 }, tool_call: true },
  "gpt-5-5": { name: "GPT-5.5", limit: { context: 400000, output: 128000 }, reasoning: true, tool_call: true },
  "gpt-5-4": { name: "GPT-5.4", limit: { context: 400000, output: 128000 }, tool_call: true },
  "gpt-5-4-mini": { name: "GPT-5.4 mini", limit: { context: 400000, output: 128000 }, tool_call: true },
  "gpt-5-4-nano": { name: "GPT-5.4 nano", limit: { context: 400000, output: 128000 }, tool_call: true },
  "glm-5-3": { name: "GLM 5.3", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
  "glm-5-3-flash": { name: "GLM 5.3 Flash", limit: { context: 200000, output: 32000 }, tool_call: true },
  "kimi-k3-1-pro": { name: "Kimi K3.1 Pro", limit: { context: 256000, output: 32000 }, reasoning: true, tool_call: true },
  "qwen-4-max": { name: "Qwen 4 Max", limit: { context: 256000, output: 32000 }, reasoning: true, tool_call: true },
  "qwen-3-8-max": { name: "Qwen 3.8 Max", limit: { context: 256000, output: 32000 }, reasoning: true, tool_call: true },
  "deepseek-v4-1-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 128000, output: 32000 }, tool_call: true },
}

// ---------------------------------------------------------------------------
// 余额查询
//
// CCode 的余额模型（从 app.ccode.si 真实页面确认）：
//   - 账户余额是“credits”（美元计），每月随套餐重置：user.credits + creditsAreFree
//   - 三个用量窗口：five_hour / weekly / monthly，各有 limit（美元）与 percent
//   - 每个 API key 有 spent（该 key 累计花费）、rpm、concurrency
//   - 付费充值余额（top-up balance）与 plan credits 分开显示
// API 网关侧（api.ccode.si）文档确认存在 GET /v1/key（key 信息与限额），
// /v1/usage、/v1/balance 也接受认证。这里优先网关端点，解析字段覆盖上述命名；
// 全部失败时给出可操作的错误信息。
// ---------------------------------------------------------------------------

const USAGE_ENDPOINTS = ["/key", "/usage", "/balance"]

// CCode 计划窗口名 → 展示名
const WINDOW_LABELS = { five_hour: "5-hour window", weekly: "Weekly window", monthly: "Monthly window" }

function windowLabel(name) {
  return WINDOW_LABELS[name] ?? name
}

function authHeaders(key) {
  // CCode 两种认证头都接受；两个都带上最稳
  return {
    authorization: `Bearer ${key}`,
    "x-api-key": key,
    accept: "application/json",
  }
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = Number(value.replace(/[$,\s]/g, ""))
    if (Number.isFinite(n)) return n
  }
  return null
}

// 在（可能嵌套的）响应里找第一个命中字段名的数值
function findNumber(data, names, { skipNames = [] } = {}) {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const skip = new Set(skipNames.map((n) => n.toLowerCase()))
  const visit = (node, key) => {
    if (key && wanted.has(key.toLowerCase()) && !skip.has(key.toLowerCase())) {
      const n = asNumber(node)
      if (n !== null) return n
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, key)
        if (hit !== null) return hit
      }
      return null
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const hit = visit(v, k)
        if (hit !== null) return hit
      }
    }
    return null
  }
  return visit(data, "")
}

function money(value, currency = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value)
  } catch {
    return `$${value.toFixed(2)}`
  }
}

function planName(data) {
  const candidates = new Set(["plan", "plan_name", "tier", "subscription"])
  const visit = (node, key) => {
    if (key && candidates.has(key.toLowerCase()) && typeof node === "string" && node.trim()) return node.trim()
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, key)
        if (hit) return hit
      }
      return null
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const hit = visit(v, k)
        if (hit) return hit
      }
    }
    return null
  }
  return visit(data, "") || "CCode API"
}

function isoTime(value) {
  if (!value) return null
  if (typeof value === "number") {
    // 秒或毫秒时间戳
    const ms = value > 1e12 ? value : value * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === "string") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function parseUsage(data) {
  if (!data || typeof data !== "object") {
    return { plan: "CCode API", windows: [], error: "CCode returned an unexpected usage payload" }
  }

  const currency = typeof data.currency === "string" && data.currency.trim()
    ? data.currency.trim().toUpperCase()
    : "USD"

  // 计划窗口（five_hour / weekly / monthly …）：对象或数组都接受
  const windows = []
  const rawWindows = data.windows ?? data.limits_window ?? data.windows_used
    ?? (data.limits && typeof data.limits === "object" && !Array.isArray(data.limits)
      ? data.limits
      : null)
  const entries = Array.isArray(rawWindows)
    ? rawWindows.map((w) => [w?.name ?? w?.kind, w]).filter(([, w]) => w && typeof w === "object")
    : rawWindows && typeof rawWindows === "object"
      ? Object.entries(rawWindows).filter(([, v]) => v && typeof v === "object")
      : []

  for (const [name, w] of entries) {
    const label = windowLabel(name)
    const percent = asNumber(w.percent ?? w.used_percent ?? w.pct)
    const usedAmt = asNumber(w.used ?? w.used_usd ?? w.spent)
    const limitAmt = asNumber(w.limit ?? w.limit_usd ?? w.granted)
    if (percent === null && usedAmt === null) continue
    windows.push({
      name: label,
      ...(percent !== null ? { used: Math.max(0, Math.min(100, percent)) }
        : limitAmt > 0 ? { used: Math.max(0, Math.min(100, (usedAmt / limitAmt) * 100)) }
        : { used: null }),
      ...(usedAmt !== null ? { amount: usedAmt } : {}),
      ...(limitAmt !== null ? { limit: limitAmt } : {}),
      unit: currency,
      ...(isoTime(w.reset_at ?? w.resets_at ?? w.resetAt) ? { resetsAt: isoTime(w.reset_at ?? w.resets_at ?? w.resetAt) } : {}),
    })
  }

  // 平铺的 used/limit（无窗口结构时）；单独的 spent（如 key 载荷）也当已用量展示
  if (windows.length === 0) {
    const used = findNumber(data, ["used", "usage_amount", "spent", "consumed", "usage_usd"])
    const limit = findNumber(data, ["limit", "monthly_limit", "quota", "allowance", "cap"])
    const resetsAt = isoTime(data.reset_at ?? data.resets_at ?? data.resetAt ?? data.renew_at)
    if (used !== null) {
      windows.push({
        name: "Spent",
        ...(limit > 0 ? { used: Math.max(0, Math.min(100, (used / limit) * 100)) } : { used: null }),
        amount: used,
        ...(limit !== null ? { limit } : {}),
        unit: currency,
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }

  // 余额：credits（CCode 的账户余额）、top-up balance、minor 计价字段
  const minorNames = ["available_total_minor", "balance_minor", "remaining_minor", "total_minor", "credits_minor"]
  const minor = findNumber(data, minorNames)
  const balanceNames = [
    "credits", "credits_remaining", "remaining", "balance", "remaining_balance",
    "available_balance", "available", "credit_balance", "quota_remaining",
    "amount_remaining", "wallet", "wallet_balance", "topup_balance", "top_up_balance",
  ]
  let balanceValue = findNumber(data, balanceNames, { skipNames: minorNames })
  if (balanceValue === null && minor !== null) balanceValue = minor / 100

  const plan = planName(data)
  const out = { plan, windows }
  if (balanceValue !== null) out.balance = money(balanceValue, currency)
  if (balanceValue === null && windows.length === 0) {
    // 端点可达但读不出余额：把原始响应放进 error 提示，便于排查字段名
    out.error = "CCode answered, but no balance field was recognised; see plugin logs"
    out.raw = data
  }
  return out
}

async function fetchUsage(key, fetchImpl = fetch) {
  let lastStatus = null
  let lastBody = ""
  for (const path of USAGE_ENDPOINTS) {
    let res
    try {
      res = await fetchImpl(`${OPENAI_BASE}${path}`, { headers: authHeaders(key) })
    } catch (err) {
      return { error: `CCode couldn't be reached: ${err?.message || err}`, windows: [] }
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error("CCode refused this API key; check the key in app.ccode.si/keys")
      err.signIn = "expired"
      throw err
    }
    if (res.status === 404) {
      lastStatus = 404
      continue
    }
    if (!res.ok) {
      lastStatus = res.status
      lastBody = (await res.text().catch(() => "")).slice(0, 200)
      continue
    }
    try {
      const data = await res.json()
      const parsed = parseUsage(data)
      if (parsed.error && path !== USAGE_ENDPOINTS[USAGE_ENDPOINTS.length - 1]) continue
      return parsed
    } catch {
      lastStatus = res.status
      lastBody = "response was not JSON"
    }
  }
  return {
    plan: "CCode API",
    windows: [],
    error: lastStatus ? `CCode answered ${lastStatus}${lastBody ? `: ${lastBody}` : ""}` : "CCode usage endpoint not found",
  }
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

export const CCodeAuthPlugin = async () => ({
  // 供应商声明：指向 ccode.si 的 API 地址。用 ??= 以免覆盖用户在 plugins.json 里的自定义配置。
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "CCode",
      npm: SDK_NPM,
      api: OPENAI_BASE,
      models: DEFAULT_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [{ type: "api", label: "CCode API key", placeholder: "在 app.ccode.si/keys 创建" }],

    // 这个账号的每个请求都经此 fetch 发出：带上认证头并指向 CCode 网关
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return {
        baseURL: OPENAI_BASE,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${auth.key}`)
          headers.set("x-api-key", auth.key)
          headers.set("x-ccode-client", `magpie-ccode-auth/${PLUGIN_VERSION}`)
          return fetch(input, { ...init, headers })
        },
      }
    },

    // magpie 专属钩子：查询套餐余额与用量（magpie quota / 供应商行里显示）
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) {
        return { plan: "CCode", windows: [], error: "No CCode API key on this account" }
      }
      return fetchUsage(auth.key)
    },
  },

  // 登录后从 /models 动态拉取这个账号可用的模型（含价格、上下文与输出上限）
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api" || !auth.key) return provider.models
      let res
      try {
        res = await fetch(`${OPENAI_BASE}/models`, { headers: authHeaders(auth.key) })
      } catch {
        return provider.models // 拉取失败时 magpie 保留原列表
      }
      if (!res.ok) return provider.models
      let payload
      try {
        payload = await res.json()
      } catch {
        return provider.models
      }
      const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null
      if (!list || list.length === 0) return provider.models
      const base = provider.models[Object.keys(provider.models)[0]] ?? Object.values(DEFAULT_MODELS)[0]
      const out = {}
      for (const m of list) {
        const id = typeof m === "string" ? m : m?.id
        if (!id || typeof id !== "string") continue
        if (id.endsWith("-free")) continue // 文档：-free 结尾的是 App 专用的免费额度模型
        const context = asNumber(typeof m === "object" && m?.context_window)
        const output = asNumber(typeof m === "object" && m?.max_output_tokens)
        out[id] = {
          ...base,
          id,
          name: (typeof m === "object" && (m.display_name || m.name)) || id,
          ...(context ? { limit: { ...base?.limit, context } } : {}),
          ...(output ? { limit: { ...(context ? { context } : base?.limit), output } } : {}),
        }
      }
      return Object.keys(out).length > 0 ? out : provider.models
    },
  },
})

// 供测试使用：不要从入口导出其他函数（magpie 会把每个导出函数都当插件加载）
export const _internal = {
  PROVIDER,
  OPENAI_BASE,
  ANTHROPIC_BASE,
  DEFAULT_MODELS,
  parseUsage,
  fetchUsage,
  isoTime,
  asNumber,
}
