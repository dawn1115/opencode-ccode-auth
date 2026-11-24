// magpie/OpenCode 供应商插件：CCode（ccode.si）
// 作用：
//   1. 把供应商指向 ccode.si 的 API 地址（用户只需填 API key）
//   2. 通过 auth.usage 钩子查询套餐余额与用量，在 magpie 里显示
// 官方 API 文档：https://ccode.si/docs/api

const PROVIDER = "ccode"
const PLUGIN_VERSION = "0.2.0"

// CCode 服务端用这个头识别“官方客户端”，Free 账号的免费额度只对官方客户端开放。
// 值必须是 ccode/<版本> 格式（大小写不敏感），其他值会被当作第三方工具返回 403。
// 这是 CCode App/CLI 自己发送的正常标识，不是绕过鉴权。
const CLIENT_HEADER = "ccode/1.12.1"

// CCode 网关地址：
// - OpenAI 格式基地址（chat completions）带 /v1
// - Anthropic 格式基地址不带 /v1（SDK 自己补 /v1/messages）
const OPENAI_BASE = "https://api.ccode.si/v1"
const ANTHROPIC_BASE = "https://api.ccode.si"

// ccode.si 同时支持 OpenAI 与 Anthropic 两种格式，所有模型都可用任意格式回答。
// 这里用 openai-compatible（chat completions），magpie 会把任何 agent 的请求都转换成这个格式。
const SDK_NPM = "@ai-sdk/openai-compatible"

// 官网公布的 26 个模型（作为首次离线时的兜底列表；登录后由 /models 动态刷新）。
// Free 账号另可用 6 个 -free 变体（API id 用厂商的点号写法，如 kimi-k3.1-pro-free）。
const DEFAULT_MODELS = {
  // Free 套餐在 App/CLI 里可用的 6 个模型
  "deepseek-v4.1-flash-free": { name: "DeepSeek V4.1 Flash (Free)", limit: { context: 128000, output: 32000 }, tool_call: true },
  "glm-5.3-flash-free": { name: "GLM 5.3 Flash (Free)", limit: { context: 200000, output: 32000 }, tool_call: true },
  "glm-5.3-free": { name: "GLM 5.3 (Free)", limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
  "kimi-k3.1-pro-free": { name: "Kimi K3.1 Pro (Free)", limit: { context: 256000, output: 32000 }, reasoning: true, tool_call: true },
  "qwen-4-max-free": { name: "Qwen 4 Max (Free)", limit: { context: 256000, output: 32000 }, reasoning: true, tool_call: true },
  "qwen-3.8-max-free": { name: "Qwen 3.8 Max (Free)", limit: { context: 256000, output: 32000 }, reasoning: true, tool_call: true },
  // 付费套餐的 26 个模型
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
// 额度查询
//
// CCode 有两套额度，api.ccode.si 各有端点（均已用真实 key 验证）：
//   GET /v1/limits — App 同款额度：当前档位 plan + 三个窗口
//                    (five_hour / weekly / monthly，美元)，以及 tiers 分层：
//                    tiers.free / tiers.paid / tiers.topup（充值额度）
//   GET /v1/key    — 这个 API key 自身的额度（credits / topup_credits）
//   GET /v1/usage  — 用量明细（费用、token、请求数）
//
// 插件以 /v1/limits 为主，把 tiers 里的每一类额度分窗口显示，让 magpie 的
// quota / 账号卡片 / 网关 /v1/magpie/quotas 都能看到全部额度种类。
// /v1/key 作为补充（key 自身剩余），/v1/usage 失败不影响额度显示。
// ---------------------------------------------------------------------------

const USAGE_ENDPOINTS = ["/limits", "/key"]

// CCode 计划窗口名 → 展示名
const WINDOW_LABELS = { five_hour: "5-hour window", weekly: "Weekly window", monthly: "Monthly window" }

// tier 名 → 展示前缀
const TIER_LABELS = { paid: "Plan", free: "Free", topup: "Top-up" }

function windowLabel(name) {
  return WINDOW_LABELS[name] ?? name
}

// 当前 plan 值 → tiers 里的档位名（"pro"/"starter" 都算 paid）
function currentTierName(plan) {
  const p = String(plan ?? "").toLowerCase()
  if (p === "free") return "free"
  if (!p || p === "topup") return null
  return "paid"
}

// 把一份 tier（含 windows）展开成 magpie 窗口列表
function tierWindows(tier, tierName, { aside = false } = {}) {
  if (!tier || typeof tier !== "object") return []
  const raw = tier.windows
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const prefix = TIER_LABELS[tierName] ?? (tierName ? String(tierName) : "")
  const out = []
  for (const [name, w] of Object.entries(raw)) {
    if (!w || typeof w !== "object") continue
    const used = asNumber(w.used)
    const limit = asNumber(w.limit)
    const remaining = asNumber(w.remaining)
    const percent = asNumber(w.percent)
    // limit / remaining / percent 都没有 = 这个 tier 在该窗口没有额度，不显示
    if (limit === null && remaining === null && percent === null) continue
    out.push({
      name: prefix ? `${prefix} · ${windowLabel(name)}` : windowLabel(name),
      ...(percent !== null ? { used: Math.max(0, percent) }
        : used !== null && limit > 0 ? { used: Math.max(0, Math.min(100, (used / limit) * 100)) }
        : { used: null }),
      ...(used !== null ? { amount: used } : {}),
      ...(limit !== null ? { limit } : {}),
      unit: "USD",
      ...(isoTime(w.reset_at ?? w.resets_at ?? w.resetAt) ? { resetsAt: isoTime(w.reset_at ?? w.resets_at ?? w.resetAt) } : {}),
      ...(aside ? { aside: true } : {}),
    })
  }
  return out
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

  const plan = planName(data)
  const windows = []

  // /v1/limits：tiers 里每一类额度都显示；当前档位的窗口参与路由，其余 aside
  if (data.tiers && typeof data.tiers === "object") {
    const current = currentTierName(data.plan)
    for (const [tierName, tier] of Object.entries(data.tiers)) {
      if (!tier || typeof tier !== "object") continue
      const isCurrent = tierName.toLowerCase() === current
      const isTopup = tierName.toLowerCase() === "topup"
      windows.push(...tierWindows(tier, tierName, { aside: !isCurrent || isTopup }))
    }
  }

  // /v1/limits 顶层 windows（当前档位）：若 tiers 没给则用它兜底
  if (windows.length === 0 && data.windows && typeof data.windows === "object") {
    const fake = { windows: data.windows }
    windows.push(...tierWindows(fake, ""))
  }

  // 平铺的 used/limit（如 /v1/key 的 credits 或早期响应）
  if (windows.length === 0) {
    const rawCredits = data.credits && typeof data.credits === "object" ? data.credits
      : data.topup_credits && typeof data.topup_credits === "object" ? data.topup_credits
      : data
    const used = asNumber(rawCredits.used ?? findNumber(data, ["used", "usage_amount", "spent", "consumed", "usage_usd"]))
    const limit = asNumber(rawCredits.limit ?? findNumber(data, ["limit", "monthly_limit", "quota", "allowance", "cap"]))
    const remaining = asNumber(rawCredits.remaining)
    const resetsAt = isoTime(data.reset_at ?? data.resets_at ?? data.resetAt ?? data.renew_at)
    if (used !== null || remaining !== null) {
      windows.push({
        name: "Plan usage",
        ...(used !== null && limit > 0 ? { used: Math.max(0, Math.min(100, (used / limit) * 100)) } : { used: null }),
        ...(used !== null ? { amount: used } : {}),
        ...(limit !== null ? { limit } : {}),
        unit: currency,
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }

  // 余额：/v1/key 的 credits.remaining / topup_credits.remaining，或通用余额字段
  const minorNames = ["available_total_minor", "balance_minor", "remaining_minor", "total_minor", "credits_minor"]
  const minor = findNumber(data, minorNames)
  const balanceNames = [
    "remaining", "credits_remaining", "balance", "remaining_balance",
    "available_balance", "available", "credit_balance", "quota_remaining",
    "amount_remaining", "wallet", "wallet_balance", "topup_balance", "top_up_balance",
  ]
  let balanceValue = null
  if (typeof data.credits === "number") {
    balanceValue = data.credits
  } else if (data.credits && typeof data.credits === "object") {
    balanceValue = asNumber(data.credits.remaining)
  }
  if (balanceValue === null && data.topup_credits && typeof data.topup_credits === "object") {
    balanceValue = asNumber(data.topup_credits.remaining)
  }
  if (balanceValue === null) balanceValue = findNumber(data, balanceNames, { skipNames: minorNames })
  if (balanceValue === null && minor !== null) balanceValue = minor / 100

  const out = { plan, windows }
  if (balanceValue !== null) out.balance = money(balanceValue, currency)
  if (balanceValue === null && windows.length === 0) {
    out.error = "CCode answered, but no balance field was recognised; see plugin logs"
    out.raw = data
  }
  return out
}

async function fetchUsage(key, fetchImpl = fetch) {
  let lastStatus = null
  let lastBody = ""
  let keyResult = null

  // 先取 App 同款分层额度；它成功就直接返回（包含所有 tiers 分类窗口）
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
      // /limits 有 tiers 时就是完整结果；其他端点只作兜底
      if (path === "/limits" && data.tiers) return parsed
      if (path !== "/key") return parsed
      // /key 成功但 /limits 失败：记住它，最后作为兜底返回
      keyResult = parsed
    } catch {
      lastStatus = res.status
      lastBody = "response was not JSON"
    }
  }
  if (keyResult) return keyResult
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
          headers.set("x-ccode-client", CLIENT_HEADER)
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

  // 登录后从 /models 动态拉取这个账号可用的模型（含价格、上下文与输出上限）。
  // Free 账号的 /models 返回空；此时保留默认列表（含 6 个 -free 模型）。
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api" || !auth.key) return provider.models
      let payload = null
      try {
        const res = await fetch(`${OPENAI_BASE}/models`, { headers: authHeaders(auth.key) })
        if (res.ok) payload = await res.json()
      } catch {
        return provider.models
      }
      let list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null

      // /models 空时，试 /v1/limits 里的 models 字段（付费账号会带）
      if (!list || list.length === 0) {
        try {
          const res = await fetch(`${OPENAI_BASE}/limits`, { headers: authHeaders(auth.key) })
          if (res.ok) {
            const limits = await res.json()
            const m = limits?.models ?? limits?.tiers?.[limits.plan]?.models
            if (m && typeof m === "object") {
              list = Array.isArray(m) ? m : Object.entries(m).map(([id, v]) => ({ id, ...(v ?? {}) }))
            }
          }
        } catch {
          // 保持默认列表
        }
      }
      if (!list || list.length === 0) return provider.models

      const base = provider.models[Object.keys(provider.models)[0]] ?? Object.values(DEFAULT_MODELS)[0]
      const out = {}
      for (const m of list) {
        const id = typeof m === "string" ? m : m?.id
        if (!id || typeof id !== "string") continue
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
  CLIENT_HEADER,
  parseUsage,
  fetchUsage,
  isoTime,
  asNumber,
}
