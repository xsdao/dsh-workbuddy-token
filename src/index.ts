// 宿主侧:凭据发现 → 定时拉数(积分 5 分钟 / config 2 小时,失败指数退避)→
// 计算 → 本地只读路由 GET /plugins/dsh-workbuddy-token/status 与 POST .../refresh。

import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { discoverCredential, defaultCpaDir } from './credentials'
import {
  activePromotion, billingBase, billingHeaders, computeTokens, creditsRequestBody, formatCompact,
  formatCredits, formatMultiplier, parseCreditMultiplier, parseCreditsTotal, parseCredential, parseRoster, regionOf, selectionModel,
  type Credential, type Probe, type Roster,
} from './shared'

export const name = 'dsh-workbuddy-token'
export const inject: string[] = []

export const Config = z.object({
  creditsIntervalSec: z.number().default(300).description('剩余积分刷新间隔(秒,最小 60)'),
  configIntervalSec: z.number().default(7200).description('模型/活动配置刷新间隔(秒,最小 600)'),
  cpaDir: z.string().default('').description('CPA 凭据目录;留空 = ~/.cli-proxy-api'),
  baseTokensPerCredit: z.number().default(1000).description('基准费率:x1 倍率下 1 积分约可换的 token 数(估算系数,可校准)'),
})

export interface PluginConfig {
  creditsIntervalSec?: number
  configIntervalSec?: number
  cpaDir?: string
  baseTokensPerCredit?: number
}

export const STATUS_PATH = '/plugins/dsh-workbuddy-token/status'
export const REFRESH_PATH = '/plugins/dsh-workbuddy-token/refresh'
const REQUEST_TIMEOUT_MS = 15000

interface Route { kind: 'exact', path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }
interface WebServerService { register(route: Route): () => void }
interface HostContext {
  effect(callback: () => unknown, label?: string): unknown
  inject?(names: string[], callback: (ctx: { webServer: WebServerService, effect: HostContext['effect'] }) => void): unknown
}

/** 视图(§7 _status 契约;含三态显示与降级所需的最少附加字段)。 */
export interface StatusView {
  state?: 'ok' | 'stale' | 'invalid-credential' | 'no-credential' | 'loading'
  credits?: number
  effectiveMultiplier?: number | { min: number, max: number }
  period?: string
  tokensEstimate?: number | { min: number, max: number }
  fetchedAtMs?: number
  model?: string
  modelStatus?: 'ok' | 'floating' | 'missing' | 'unknown'
  creditsText?: string
  multiplierText?: string
  tokensText?: string
  staleMinutes?: number
  probes?: Probe[]
}

class AuthRejectedError extends Error {}

function warn(message: string): void {
  console.warn(`[dsh-workbuddy-token] ${message}`)
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const readBody = async () => { try { await response.body?.cancel?.() } catch {} }
  if (response.status === 401 || response.status === 403) {
    await readBody()
    throw new AuthRejectedError(`gateway rejected credentials (HTTP ${response.status})`)
  }
  if (!response.ok) {
    await readBody()
    throw new Error(`HTTP ${response.status}`)
  }
  const body: unknown = await response.json().catch(() => { throw new Error('non-JSON response') })
  const envelope = body as { code?: unknown }
  if (envelope.code !== undefined && String(envelope.code) !== '0') {
    if (String(envelope.code) === '401' || String(envelope.code) === '403') throw new AuthRejectedError('gateway rejected credentials (business code)')
    throw new Error(`business code ${String(envelope.code)}`)
  }
  return body
}

async function fetchCreditsTotal(credential: Credential): Promise<number> {
  const body = await requestJson(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: { ...billingHeaders(credential), 'Content-Type': 'application/json' },
    body: JSON.stringify(creditsRequestBody()),
  })
  const total = parseCreditsTotal(body)
  if (total === undefined) throw new Error('billing response carried no Accounts list')
  return total
}

async function fetchRoster(credential: Credential): Promise<{ roster: Roster, warnings: string[] }> {
  const body = await requestJson(`${billingBase(credential)}/v3/config`, {
    method: 'GET',
    headers: billingHeaders(credential),
  })
  const parsed = parseRoster(body)
  if (parsed === undefined) throw new Error('config response not recognized')
  for (const warning of parsed.warnings) warn(warning)
  return parsed
}

export function apply(ctx: HostContext, config: PluginConfig = {}) {
  const creditsIntervalMs = Math.max(60, Math.floor(config.creditsIntervalSec ?? 300)) * 1000
  const configIntervalMs = Math.max(600, Math.floor(config.configIntervalSec ?? 7200)) * 1000
  const cpaDir = (config.cpaDir ?? '').trim() !== '' ? (config.cpaDir ?? '').trim() : defaultCpaDir()
  const baseTokensPerCredit = Number.isFinite(config.baseTokensPerCredit) && (config.baseTokensPerCredit ?? 0) > 0 ? config.baseTokensPerCredit! : 1000

  const state = {
    credits: undefined as { total: number, atMs: number } | undefined,
    roster: undefined as { roster: Roster, atMs: number } | undefined,
    credential: undefined as Credential | undefined,
    probes: [] as Probe[],
    authRejected: false,
    noCredential: false,
    creditsFailed: false,
    busy: false,
  }
  let creditsFailures = 0
  let configFailures = 0

  const runCredits = async () => {
    const { credential, probes } = discoverCredential({ cpaDir })
    state.probes = probes
    state.noCredential = credential === undefined
    state.credential = credential
    if (credential === undefined) return
    try {
      state.credits = { total: await fetchCreditsTotal(credential), atMs: Date.now() }
      creditsFailures = 0
      state.creditsFailed = false
      state.authRejected = false
    } catch (error) {
      creditsFailures += 1
      state.creditsFailed = true
      if (error instanceof AuthRejectedError) state.authRejected = true
      warn(`credits refresh failed (${safeMessage(error)}); backing off`)
    }
  }

  const runConfig = async () => {
    if (state.credential === undefined) {
      const { credential } = discoverCredential({ cpaDir })
      state.credential = credential
      state.noCredential = credential === undefined
      if (credential === undefined) return
    }
    try {
      state.roster = { roster: (await fetchRoster(state.credential!)).roster, atMs: Date.now() }
      configFailures = 0
      state.authRejected = false
    } catch (error) {
      configFailures += 1
      if (error instanceof AuthRejectedError) state.authRejected = true
      warn(`config refresh failed (${safeMessage(error)}); backing off`)
    }
  }

  let creditsTimer: NodeJS.Timeout | undefined
  let configTimer: NodeJS.Timeout | undefined
  const scheduleCredits = () => {
    // §3.3:失败退避 1→2→4→8 分钟,且不短于配置的正常间隔(禁止密集重试)。
    const backoffMs = Math.min(60_000 * 2 ** creditsFailures, 480_000)
    creditsTimer = setTimeout(() => { void runCredits().finally(scheduleCredits) }, Math.max(creditsIntervalMs, backoffMs))
  }
  const scheduleConfig = () => {
    const backoffMs = Math.min(60_000 * 2 ** configFailures, 480_000)
    configTimer = setTimeout(() => { void runConfig().finally(scheduleConfig) }, Math.max(configIntervalMs, backoffMs))
  }
  // 启动立即拉一次,之后按间隔/退避排程(§3.2「每 2 小时 + 启动」)。
  void runCredits().finally(scheduleCredits)
  void runConfig().finally(scheduleConfig)

  /** 手动刷新(点击胶囊):立即拉两个接口;并发去重。 */
  const refreshNow = async () => {
    if (state.busy) return
    state.busy = true
    try {
      await Promise.all([runCredits(), runConfig()])
    } finally {
      state.busy = false
    }
  }

  const viewFor = (modelId: string): StatusView => {
    const view: StatusView = {}
    if (modelId !== '') view.model = modelId
    const credits = state.credits
    if (credits !== undefined) {
      view.credits = credits.total
      view.fetchedAtMs = credits.atMs
      view.creditsText = formatCredits(credits.total)
    }
    if (state.noCredential) {
      view.state = 'no-credential'
      view.probes = state.probes
      return view
    }
    if (state.authRejected) view.state = 'invalid-credential'
    else if (credits === undefined) view.state = 'loading'
    else if (state.creditsFailed) {
      view.state = 'stale'
      view.staleMinutes = Math.max(1, Math.round((Date.now() - credits.atMs) / 60_000))
    } else view.state = 'ok'
    if (credits === undefined) return view

    // 模型倍率 + 时段折扣(§4):有效性每次现判,不信任缓存时刻(§5.2)。
    const now = new Date()
    const roster = state.roster
    if (roster === undefined) { view.modelStatus = 'unknown'; return view }
    const entry = roster.roster.models.find(candidate => candidate.id === modelId)
    if (entry === undefined) { view.modelStatus = 'missing'; return view }
    const promotion = activePromotion(roster.roster.promotions, modelId, now)
    const factor = promotion?.factor ?? 1
    if (promotion?.periodKey !== undefined) view.period = promotion.periodKey
    if (entry.multiplier === undefined) {
      // 浮动倍率(auto 通道):取当前目录全部已知倍率的 min–max(§1)。
      view.modelStatus = 'floating'
      const values = roster.roster.models.map(candidate => candidate.multiplier).filter((value): value is number => value !== undefined && value > 0)
      if (values.length > 0) {
        const min = Math.min(...values) * factor
        const max = Math.max(...values) * factor
        view.effectiveMultiplier = { min, max }
        view.multiplierText = `${formatMultiplier(min)}–${formatMultiplier(max).slice(1)}`
        if (factor > 0) {
          const tokensMin = computeTokens(credits.total, max, baseTokensPerCredit)
          const tokensMax = computeTokens(credits.total, min, baseTokensPerCredit)
          view.tokensEstimate = { min: tokensMin, max: tokensMax }
          view.tokensText = `${formatCompact(tokensMin)}–${formatCompact(tokensMax)}`
        }
      }
      return view
    }
    view.modelStatus = 'ok'
    const effective = entry.multiplier * factor
    view.effectiveMultiplier = effective
    view.multiplierText = formatMultiplier(effective)
    if (effective > 0) {
      const tokens = computeTokens(credits.total, effective, baseTokensPerCredit)
      view.tokensEstimate = tokens
      view.tokensText = formatCompact(tokens)
    }
    return view
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  // 只信同源浏览器请求:跨源 POST 会打到刷新路由(信任边界校验,§3.3 纪律)。
  const crossOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin === '') return false
    try { return new URL(origin).host !== req.headers.host } catch { return true }
  }

  ctx.inject?.(['webServer'], webCtx => {
    webCtx.effect(() => {
      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          const model = new URL(req.url ?? '/', 'http://localhost').searchParams.get('model') ?? ''
          json(res, 200, viewFor(model))
        },
      })
      const disposeRefresh = webCtx.webServer.register({
        kind: 'exact',
        path: REFRESH_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (crossOrigin(req)) return json(res, 403, { error: 'cross-origin rejected' })
          try {
            await refreshNow()
          } catch (error) {
            warn(`manual refresh failed (${safeMessage(error)})`)
          }
          const model = new URL(req.url ?? '/', 'http://localhost').searchParams.get('model') ?? ''
          json(res, 200, viewFor(model))
        },
      })
      return () => { disposeStatus(); disposeRefresh() }
    }, 'dsh-workbuddy-token: status routes')
  })

  ctx.effect(() => () => {
    clearTimeout(creditsTimer)
    clearTimeout(configTimer)
  }, 'dsh-workbuddy-token: timers')
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

export {
  activePromotion, billingHeaders, computeTokens, discoverCredential, formatCompact, formatCredits, formatMultiplier,
  parseCreditMultiplier, parseCreditsTotal, parseCredential, parseRoster, regionOf, selectionModel,
}
