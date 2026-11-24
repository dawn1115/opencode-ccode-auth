import { describe, expect, test } from "bun:test"
import { CCodeAuthPlugin, _internal } from "../index.mjs"

const { parseUsage, fetchUsage, PROVIDER, OPENAI_BASE } = _internal

// api.ccode.si/v1/limits 的真实响应（用户 Free 账号实测）
const REAL_LIMITS = {
  plan: "free",
  windows: {
    five_hour: { used: 0, limit: 5, remaining: 5, percent: 0, resets_at: null },
    weekly: { used: 0, limit: 10, remaining: 10, percent: 0, resets_at: null },
    monthly: { used: 0, limit: 10, remaining: 10, percent: 0, resets_at: null },
  },
  models: {},
  limited: null,
  tiers: {
    free: {
      plan: "free",
      windows: {
        five_hour: { used: 0, limit: 5, remaining: 5, percent: 0, resets_at: null },
        weekly: { used: 0, limit: 10, remaining: 10, percent: 0, resets_at: null },
        monthly: { used: 0, limit: 10, remaining: 10, percent: 0, resets_at: null },
      },
      models: {}, limited: null,
    },
    paid: null,
    topup: {
      plan: "topup",
      windows: {
        five_hour: { used: 0, limit: null, remaining: null, percent: null, resets_at: null },
        weekly: { used: 0, limit: 50, remaining: 50, percent: 0, resets_at: null },
        monthly: { used: 0, limit: null, remaining: null, percent: null, resets_at: null },
      },
      models: {}, limited: null,
    },
  },
}

describe("插件结构", () => {
  test("声明 ccode 供应商，指向 CCode API", async () => {
    const hooks = await CCodeAuthPlugin({ client: {} })
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider[PROVIDER]).toBeDefined()
    expect(cfg.provider[PROVIDER].api).toBe(OPENAI_BASE)
    expect(Object.keys(cfg.provider[PROVIDER].models).length).toBe(26)
    expect(hooks.auth.provider).toBe(PROVIDER)
    expect(typeof hooks.auth.usage).toBe("function")
    expect(hooks.provider.id).toBe(PROVIDER)
  })
})

describe("parseUsage — /v1/limits 分层额度", () => {
  test("真实 payload：所有额度种类分类显示", () => {
    const r = parseUsage(REAL_LIMITS)
    expect(r.plan).toBe("free")
    // free 三窗口（参与路由）+ topup weekly（aside）；paid 为 null 不显示
    expect(r.windows).toHaveLength(4)
    expect(r.windows.map((w) => w.name)).toEqual([
      "Free · 5-hour window", "Free · Weekly window", "Free · Monthly window", "Top-up · Weekly window",
    ])
    expect(r.windows[0].used).toBe(0)
    expect(r.windows[0].limit).toBe(5)
    expect(r.windows[0].unit).toBe("USD")
    expect(r.windows[1].limit).toBe(10)
    expect(r.windows[2].limit).toBe(10)
    expect(r.windows[3].aside).toBe(true)
    expect(r.windows[3].limit).toBe(50)
  })

  test("paid 档位非 null 时也分类显示", () => {
    const data = JSON.parse(JSON.stringify(REAL_LIMITS))
    data.plan = "pro"
    data.tiers.paid = {
      plan: "pro",
      windows: {
        five_hour: { used: 20, limit: 14, remaining: 11.2, percent: 20, resets_at: null },
        weekly: { used: 35, limit: 35, remaining: 0, percent: 100, resets_at: null },
        monthly: { used: 70, limit: 70, remaining: 0, percent: 100, resets_at: null },
      },
    }
    const r = parseUsage(data)
    expect(r.plan).toBe("pro")
    expect(r.windows.some((w) => w.name === "Plan · 5-hour window")).toBe(true)
    expect(r.windows.some((w) => w.name === "Free · Weekly window")).toBe(true)
    const paidMonthly = r.windows.find((w) => w.name === "Plan · Monthly window")
    expect(paidMonthly.used).toBe(100)
    expect(paidMonthly.aside).toBeUndefined()
  })
})

describe("parseUsage — 兜底", () => {
  test("/v1/key 的 credits.remaining → 余额", () => {
    const r = parseUsage({
      plan: "free",
      credits: { limit: 10, used: 0, remaining: 10 },
      topup_credits: { remaining: 0 },
    })
    expect(r.balance).toBe("$10.00")
    expect(r.windows[0].name).toBe("Plan usage")
    expect(r.windows[0].limit).toBe(10)
  })

  test("平铺 windows（无 tiers）→ 无前缀窗口", () => {
    const r = parseUsage({
      plan: "Free",
      credits: 6.5,
      windows: {
        five_hour: { percent: 42, limit: 5, reset_at: "2026-11-24T18:00:00Z" },
        monthly: { percent: 3, limit: 10 },
      },
    })
    expect(r.balance).toBe("$6.50")
    expect(r.windows[0].name).toBe("5-hour window")
    expect(r.windows[0].resetsAt).toBe("2026-11-24T18:00:00.000Z")
  })
})

describe("fetchUsage", () => {
  test("无效 key → 标记需要重新登录", async () => {
    const fakeFetch = async () => ({ status: 401, ok: false })
    let err
    try {
      await fetchUsage("bad", fakeFetch)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(err.signIn).toBe("expired")
  })

  test("/limits 优先：成功即返回全部分类窗口", async () => {
    const calls = []
    const fakeFetch = async (url) => {
      calls.push(url)
      if (url.endsWith("/limits")) {
        return { status: 200, ok: true, json: async () => REAL_LIMITS }
      }
      throw new Error("should not be called")
    }
    const r = await fetchUsage("key", fakeFetch)
    expect(calls).toHaveLength(1)
    expect(r.windows).toHaveLength(4)
    expect(r.windows[0].name).toBe("Free · 5-hour window")
  })

  test("/limits 404 → 回退 /key", async () => {
    const calls = []
    const fakeFetch = async (url) => {
      calls.push(url)
      if (url.endsWith("/limits")) return { status: 404, ok: false }
      return {
        status: 200,
        ok: true,
        json: async () => ({ plan: "free", credits: { limit: 10, used: 3, remaining: 7 } }),
      }
    }
    const r = await fetchUsage("key", fakeFetch)
    expect(calls.length).toBe(2)
    expect(r.balance).toBe("$7.00")
    expect(r.windows[0].name).toBe("Plan usage")
  })
})
