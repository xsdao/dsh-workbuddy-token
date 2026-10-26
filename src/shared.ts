// 纯逻辑层:凭据 JSON 解析、上游响应解析、活动窗口判定、换算与格式化。
// 无 node 专有依赖,宿主与浏览器客户端共用。字段名与请求配方见 DESIGN.md §2/§3
// (2026-10-26 实测);所有上游字段按 optional 处理,缺失只降级不崩(§5.3)。

/** 网关渠道 UA(§3:不带或带错会 403/404,决定 /v3/config 返回的目录形态)。 */
export const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
export const CN_BILLING_BASE = 'https://www.codebuddy.cn'
export const GLOBAL_BILLING_BASE = 'https://www.workbuddy.ai'

export interface Credential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  domain: string
  region?: string
  uid: string
  enterpriseId?: string
  sourcePath: string
}

/** Model id from the session's durable `modelSelection` projection, if present. */
export function selectionModel(value: unknown): string {
  const selection = record(value)
  const next = record(selection?.next)
  const lastUsed = record(selection?.lastUsed)
  for (const candidate of [next, lastUsed]) {
    const model = text(candidate?.model)
    if (model !== undefined) return model
  }
  return ''
}

/** 探测记录只含路径与失败原因码,绝不含 token/uid(§6 安全红线)。 */
export interface Probe { path: string, reason: 'missing' | 'unreadable' | 'not-json' | 'no-token' | 'encrypted' | 'expired' }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 秒或毫秒的过期时间统一为毫秒(0 = 未知)。 */
function expiryToMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    if (typeof value === 'string' && value !== '') { const ms = Date.parse(value); if (!Number.isNaN(ms)) return ms }
    return 0
  }
  return value > 1e12 ? value : value * 1000
}

/**
 * 解析 WorkBuddy 凭据文档,兼容两种在盘形态(§2):
 *  - CPA 文件/桌面端嵌套 {auth:{...}, account:{...}};
 *  - 扁平(顶层同名字段)。
 * 无法解析或无 accessToken → undefined。加密痕迹($wbEncrypted)→ 'encrypted'。
 */
export function parseCredential(value: unknown, sourcePath = ''): { credential?: Credential, reason?: Probe['reason'] } {
  const document = record(value)
  if (document === undefined) return { reason: 'not-json' }
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (record(document.auth) !== undefined) {
    auth = record(document.auth)!
    identity = record(document.account) ?? {}
  } else {
    auth = document
    identity = document
  }
  if (hasEncryptedFields(auth)) return { reason: 'encrypted' }
  const accessToken = text(auth.accessToken)
  if (accessToken === undefined) return { reason: 'no-token' }
  return {
    credential: {
      accessToken,
      refreshToken: text(auth.refreshToken) ?? '',
      expiresAtMs: expiryToMs(auth.expiresAt ?? auth.expiresAtMs),
      domain: text(auth.domain) ?? '',
      region: text(auth.region),
      uid: text(identity.uid) ?? '',
      enterpriseId: text(identity.enterpriseId),
      sourcePath,
    },
  }
}

function hasEncryptedFields(auth: Record<string, unknown>): boolean {
  for (const field of ['accessToken', 'refreshToken']) {
    const value = auth[field]
    if (value === undefined) continue
    if (typeof value === 'string') continue
    return true // WorkBuddy 5.6+ 的 $wbEncrypted 封装或其他未知结构
  }
  return false
}

/** 区域:显式 auth.region 优先,否则按 domain 判定(workbuddy.ai → global,默认 cn)。 */
export function regionOf(credential: Pick<Credential, 'domain' | 'region'>): 'cn' | 'global' {
  if (credential.region === 'global') return 'global'
  if (credential.region === 'cn') return 'cn'
  const lowered = credential.domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

export function billingBase(credential: Pick<Credential, 'domain' | 'region'>): string {
  return regionOf(credential) === 'global' ? GLOBAL_BILLING_BASE : CN_BILLING_BASE
}

/** 计费请求头(§3 六件套 + UA;X-Enterprise/X-Tenant 同值,uid 缺省时省略)。 */
export function billingHeaders(credential: Credential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'User-Agent': PRODUCT_UA,
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

export function isExpired(credential: Credential, nowMs: number): boolean {
  return credential.expiresAtMs > 0 && nowMs >= credential.expiresAtMs
}

// ---------- 积分解析(§3.1) ----------

function accountsOf(body: unknown): unknown[] | undefined {
  const root = record(body)
  if (root === undefined) return undefined
  // 两种已见形态:data.Response.Data.Accounts 与 data.Response.Data.Data.Accounts(§5.3 防御式都收)。
  for (const source of [record(root.data), record(root.Response)]) {
    if (source === undefined) continue
    const response = record(source.Response) ?? source
    const level = record(response.Data)
    if (level === undefined) continue
    for (const holder of [record(level.Data), level]) {
      if (holder !== undefined && Array.isArray(holder.Accounts)) return holder.Accounts
    }
  }
  return undefined
}

/** 照抄 dsh-connect-workbuddy 的 preciseField 分支:Precise 字符串优先,回退数值字段。 */
export function parseCreditsTotal(body: unknown): number | undefined {
  const accounts = accountsOf(body)
  if (accounts === undefined) return undefined
  let total = 0
  for (const raw of accounts) {
    const account = record(raw)
    if (account === undefined) continue
    const numberField = (key: string): number => (typeof account[key] === 'number' && Number.isFinite(account[key] as number) ? account[key] as number : 0)
    const preciseField = (key: string): number => {
      const value = account[`${key}Precise`]
      if (typeof value === 'string' && value !== '') {
        const parsed = Number.parseFloat(value)
        if (Number.isFinite(parsed)) return parsed
      }
      if (typeof value === 'number' && Number.isFinite(value)) return value
      return numberField(key)
    }
    const remain = account.CycleCapacityRemain !== undefined || account.CycleCapacityRemainPrecise !== undefined
      ? preciseField('CycleCapacityRemain')
      : preciseField('CapacityRemain')
    total += remain < 0 ? 0 : remain
    if (!Number.isFinite(total)) return undefined
  }
  return total
}

/** 本地时间 'YYYY-MM-DD HH:mm:ss'(上游 body 的时间窗格式)。 */
export function formatLocalTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** get-user-resource 的请求 body(§3.1 原样,窗口 = now 到 now+318513600000ms)。 */
export function creditsRequestBody(now = new Date()): Record<string, unknown> {
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatLocalTimestamp(now),
    PackageEndTimeRangeEnd: formatLocalTimestamp(new Date(now.getTime() + 318513600000)),
  }
}

// ---------- 模型目录 + 活动解析(§3.2) ----------

export interface RosterModel {
  id: string
  name: string
  /** 基础倍率;无 credits 字段 = 浮动倍率通道(auto),用区间展示。 */
  multiplier?: number
}

export interface Promotion {
  id: string
  modelIds: string[]
  factor: number
  /** 'night' | 'peak' 之类的规范键,客户端再本地化;推不出来则省略。 */
  periodKey?: string
  /** 「原价」类条目:窗口标记的是高峰原价时段,折扣作用于窗口之外(§3.2 规则 5)。 */
  inverted: boolean
  timezone: string
  validFromMs?: number
  validUntilMs?: number
  /** ISO 星期 1=Mon..7=Sun;仅上游声明时才有。 */
  weekdays?: number[]
  windows: { startMin: number, endMin: number }[]
}

export interface Roster {
  models: RosterModel[]
  promotions: Promotion[]
}

/** credits 字符串("x0.69")→ 倍率数字;解析失败 = 浮动(无此字段)。 */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*(\d*\.?\d+)/i.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** 'HH:mm' → 当日分钟数;'24:00' 仅作为结束值合法(=1440)。 */
function minutesOfClock(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59 || hours > 24) return undefined
  if (hours === 24) return minutes === 0 ? 1440 : undefined
  return hours * 60 + minutes
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** 某时区下的当前分钟数与 ISO 星期;时区非法时回退本地时间。 */
export function clockInZone(date: Date, timeZone: string): { minutes: number, weekday: number } {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const isoWeekday = (name: string | undefined): number => {
    const index = name === undefined ? -1 : weekdays.indexOf(name)
    return index === 0 ? 7 : index // 1=Mon..7=Sun
  }
  try {
    const parts = zonedFormatter(timeZone).formatToParts(date)
    const hour = Number(parts.find(part => part.type === 'hour')?.value ?? NaN)
    const minute = Number(parts.find(part => part.type === 'minute')?.value ?? NaN)
    const weekday = isoWeekday(parts.find(part => part.type === 'weekday')?.value)
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 24) throw new Error('bad parts')
    return { minutes: (hour % 24) * 60 + minute, weekday }
  } catch {
    return { minutes: date.getHours() * 60 + date.getMinutes(), weekday: isoWeekday(weekdays[date.getDay()]) }
  }
}

function windowHit(promotion: Promotion, now: Date): boolean {
  const { minutes, weekday } = clockInZone(now, promotion.timezone || 'Asia/Shanghai')
  for (const window of promotion.windows) {
    if (promotion.weekdays !== undefined && promotion.weekdays.length > 0 && !promotion.weekdays.includes(weekday)) continue
    if (window.startMin <= window.endMin) {
      if (minutes >= window.startMin && minutes < window.endMin) return true
    } else if (minutes >= window.startMin || minutes < window.endMin) return true // 跨午夜(23:00→7:50)
  }
  return false
}

/** 活动条目命中判定:enabled + 有效期 + 时段窗口;「原价」类取窗口之外。 */
export function promotionActive(promotion: Promotion, now: Date): boolean {
  const ms = now.getTime()
  if (promotion.validFromMs !== undefined && ms < promotion.validFromMs) return false
  if (promotion.validUntilMs !== undefined && ms > promotion.validUntilMs) return false
  const hit = promotion.windows.length === 0 ? true : windowHit(promotion, now)
  // 无窗口的「原价」条目方向不明,按保守值跳过(宁可少折不多折,§3.2 规则 5)。
  return promotion.inverted && promotion.windows.length === 0 ? false : promotion.inverted ? !hit : hit
}

/** 当前模型命中的最优折扣:多条命中取 min(factor);返回折扣与时段标签。 */
export function activePromotion(promotions: Promotion[], modelId: string, now: Date): { factor: number, periodKey?: string } | undefined {
  let best: { factor: number, periodKey?: string } | undefined
  for (const promotion of promotions) {
    if (!promotion.modelIds.includes(modelId)) continue
    if (!promotionActive(promotion, now)) continue
    if (best === undefined || promotion.factor < best.factor) {
      best = { factor: promotion.factor, ...(promotion.periodKey === undefined ? {} : { periodKey: promotion.periodKey }) }
    }
  }
  return best
}

function periodKeyOf(entry: unknown): string | undefined {
  const raw = record(entry)
  if (raw === undefined) return undefined
  const badge = record(raw.badge)
  const hover = record(raw.hover)
  const copy = [badge?.label, badge?.shortLabel, badge?.labelEn, badge?.shortLabelEn, hover?.textZh, hover?.textEn, raw.id, raw.textZh, raw.textEn]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (/夜|night/.test(copy)) return 'night'
  if (/高峰|峰时|peak/.test(copy)) return 'peak'
  return undefined
}

/** 是否「原价」方向条目:文案出现 原价/original price 即视为窗口内不打折(§3.2 规则 5)。 */
function invertedOf(entry: Record<string, unknown>): boolean {
  const json = JSON.stringify(entry)
  return /原价|original price/i.test(json)
}

/**
 * 解析 /v3/config 的 data:models[](基础倍率)与 modelPromotions[](时段折扣)。
 * 结构不认识时返回 undefined 并带一条警告(§5.3);factor 非 number 的纯徽标条目跳过。
 */
export function parseRoster(body: unknown): { roster: Roster, warnings: string[] } | undefined {
  const root = record(body)
  if (root === undefined) return undefined
  const data = record(root.data) ?? root
  const warnings: string[] = []
  const models: RosterModel[] = []
  if (Array.isArray(data.models)) {
    for (const raw of data.models) {
      const entry = record(raw)
      if (entry === undefined) continue
      const id = text(entry.id)
      if (id === undefined) continue
      models.push({
        id,
        name: text(entry.name) ?? id,
        ...(parseCreditMultiplier(entry.credits) === undefined ? {} : { multiplier: parseCreditMultiplier(entry.credits)! }),
      })
    }
  } else {
    warnings.push('config response carried no models[] list')
  }
  const promotions: Promotion[] = []
  if (Array.isArray(data.modelPromotions)) {
    for (const raw of data.modelPromotions) {
      const entry = record(raw)
      if (entry === undefined) continue
      if (entry.enabled === false) continue
      const ids = Array.isArray(entry.modelIds) ? entry.modelIds.filter((id): id is string => typeof id === 'string' && id !== '') : []
      if (ids.length === 0) continue
      const discount = record(entry.discount)
      // factor 为 number 才是真折扣;factor: null 是纯展示徽标,跳过(§3.2 规则 2)。
      if (discount === undefined || typeof discount.factor !== 'number' || !Number.isFinite(discount.factor) || discount.factor < 0) continue
      const schedule = record(entry.schedule)
      const windows: Promotion['windows'] = []
      if (schedule !== undefined && Array.isArray(schedule.daily)) {
        for (const daily of schedule.daily) {
          const slot = record(daily)
          if (slot === undefined) continue
          const startMin = minutesOfClock(slot.start)
          const endMin = minutesOfClock(slot.end)
          if (startMin === undefined || endMin === undefined || startMin === endMin) {
            warnings.push(`promotion "${text(entry.id) ?? '?'}": dropped an unreadable daily window`)
            continue
          }
          windows.push({ startMin, endMin })
        }
      }
      const weekdays = Array.isArray(schedule?.weekdays)
        ? (schedule!.weekdays as unknown[]).filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7)
        : undefined
      const validFromMs = typeof schedule?.validFrom === 'string' ? Date.parse(schedule.validFrom) : undefined
      const validUntilMs = typeof schedule?.validUntil === 'string' ? Date.parse(schedule.validUntil) : undefined
      const periodKey = periodKeyOf(entry)
      promotions.push({
        id: text(entry.id) ?? ids.join(','),
        modelIds: ids,
        factor: discount.factor,
        ...(periodKey === undefined ? {} : { periodKey }),
        inverted: invertedOf(entry),
        timezone: text(schedule?.timezone) ?? 'Asia/Shanghai',
        ...(Number.isFinite(validFromMs) ? { validFromMs } : {}),
        ...(Number.isFinite(validUntilMs) ? { validUntilMs } : {}),
        ...(weekdays !== undefined && weekdays.length > 0 ? { weekdays } : {}),
        windows,
      })
    }
  } else {
    warnings.push('config response carried no modelPromotions[] list')
  }
  if (models.length === 0 && promotions.length === 0) return undefined
  return { roster: { models, promotions }, warnings }
}

// ---------- 换算与格式化(§4) ----------

/** token 估算 = 积分 ÷ 有效倍率 × 基准费率(基准:x1 下 1 积分约换的 token 数,可配置)。 */
export function computeTokens(credits: number, effectiveMultiplier: number, baseTokensPerCredit: number): number {
  if (!(effectiveMultiplier > 0)) return Number.POSITIVE_INFINITY
  return credits / effectiveMultiplier * baseTokensPerCredit
}

/** 一位小数并去尾零(3.0 → '3',1.15 → '1.2')。 */
function trim1(value: number): string {
  const rounded = value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded
}

/** K/M 缩写:<1e3 原样;<1e6 → X.K;<1e9 → X.M(§4.4)。 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '∞'
  if (value < 1000) return String(Math.floor(value))
  if (value < 1e6) return `${trim1(value / 1e3)}K`
  if (value < 1e9) return `${trim1(value / 1e6)}M`
  return `${trim1(value / 1e9)}B`
}

/** 倍率显示:两位小数去尾零(0.5 → 'x0.5',0.345 → 'x0.35';epsilon 修正二进制半舍入)。 */
export function formatMultiplier(value: number): string {
  if (!Number.isFinite(value)) return 'x?'
  const cents = Math.max(0, Math.round((value + 1e-9) * 100))
  const whole = Math.trunc(cents / 100)
  const frac = cents % 100
  if (frac === 0) return `x${whole}`
  if (frac % 10 === 0) return `x${whole}.${frac / 10}`
  return `x${whole}.${String(frac).padStart(2, '0')}`
}

/** 积分显示:整数(小值保留 1 位小数)。 */
export function formatCredits(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}
