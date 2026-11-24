import { describe, expect, test } from "bun:test"
import { CCodeAuthPlugin, _internal } from "../index.mjs"

const { parseUsage, fetchUsage, PROVIDER, OPENAI_BASE } = _internal

describe("插件结构", () => {
  test("声明 ccode 供应商，指向 CCode API", async () => {
    const hooks = await CCodeAuthPlugin({ client: {} })
    const cfg = {}
    await hooks.config(cfg)
    expect(cfg.provider[PROVIDER]).toBeDefined()
    expect(cfg.provider[PROVIDER].api).toBe(OPENAI_BASE)
    expect(Object.keys(cfg.provider[PROVIDER].models).length).toBe(26)
    expect(hooks.auth.provider).toBe(PROVIDER)
    expect(typeof hooks.auth.loader).toBe("function")
    expect(typeof hooks.auth.usage).toBe("function")
    expect(hooks.provider.id).toBe(PROVIDER)
  })
})

describe("parseUsage", () => {
  test("账户 credits → 余额", () => {
    const r = parseUsage({ user: { plan: "Free" }, credits: 10, creditsAreFree: true })
    expect(r.plan).toBe("Free")
    expect(r.balance).toBe("$10.00")
  })

  test("five_hour / weekly / monthly 窗口 → 用量", () => {
    const r = parseUsage({
      plan: "Free",
      credits: 6.5,
      windows: {
        five_hour: { percent: 42, limit: 5, reset_at: "2026-11-24T18:00:00Z" },
        weekly: { percent: 10, limit: 10 },
        monthly: { percent: 3, limit: 10 },
      },
    })
    expect(r.balance).toBe("$6.50")
    expect(r.windows).toHaveLength(3)
    expect(r.windows[0].name).toBe("5-hour window")
    expect(r.windows[0].used).toBe(42)
    expect(r.windows[0].resetsAt).toBe("2026-11-24T18:00:00.000Z")
    expect(r.windows[1].name).toBe("Weekly window")
    expect(r.windows[2].name).toBe("Monthly window")
  })

  test("top-up balance 与 minor 计价", () => {
    expect(parseUsage({ balance: 0, plan: "Pro" }).balance).toBe("$0.00")
    expect(parseUsage({ data: { available_total_minor: 5000, currency: "USD" } }).balance).toBe("$50.00")
  })

  test("key 的 spent → Spent 窗口", () => {
    const r = parseUsage({ spent: 2.35, rpm: 30 })
    expect(r.windows[0].name).toBe("Spent")
    expect(r.windows[0].amount).toBe(2.35)
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

  test("端点 404 时继续尝试下一个", async () => {
    const calls = []
    const fakeFetch = async (url) => {
      calls.push(url)
      if (url.endsWith("/key")) return { status: 404, ok: false }
      return {
        status: 200,
        ok: true,
        json: async () => ({ plan: "Pro", credits: 12.5, windows: { monthly: { percent: 20, limit: 70 } } }),
      }
    }
    const r = await fetchUsage("key", fakeFetch)
    expect(calls.length).toBe(2)
    expect(r.balance).toBe("$12.50")
    expect(r.windows[0].name).toBe("Monthly window")
  })
})
