// 零依赖自测(cost-meter 同款 assert 风格),跑在构建产物 lib/index.js 上:
// node test/verify.mjs(先 pnpm build)。

import assert from 'node:assert/strict'
import { basename, dirname, join, normalize } from 'node:path'
import * as plugin from '../lib/index.js'

const {
  activePromotion, computeTokens, discoverCredential, formatCompact, formatCredits, formatMultiplier,
  parseCreditMultiplier, parseCreditsTotal, parseCredential, parseRoster, billingHeaders, regionOf,
  selectionModel,
} = plugin

// ---------- 格式化(§4.4 / §1) ----------
assert.equal(formatCompact(999), '999')
assert.equal(formatCompact(1000), '1K')
assert.equal(formatCompact(3_200_000), '3.2M')
assert.equal(formatCompact(3_000_000), '3M')
assert.equal(formatCompact(Number.POSITIVE_INFINITY), '∞')
assert.equal(formatMultiplier(0.5), 'x0.5')
assert.equal(formatMultiplier(1), 'x1')
assert.equal(formatMultiplier(0.345), 'x0.35')
assert.equal(formatCredits(4027.1), '4027')
assert.equal(formatCredits(99.55), '99.6')

// ---------- 倍率解析(§3.2 credits 字符串) ----------
assert.equal(parseCreditMultiplier('x0.69'), 0.69)
assert.equal(parseCreditMultiplier('X1'), 1)
assert.equal(parseCreditMultiplier(undefined), undefined)
assert.equal(parseCreditMultiplier('free'), undefined)

// ---------- 积分解析(§3.1,preciseField 分支) ----------
const account = (over = {}) => ({
  PackageName: '运营裂变包', CycleCapacityRemain: 1, CycleCapacityRemainPrecise: '2.35',
  CapacityRemain: 9, ...over,
})
const accountsBody = { code: 0, data: { Response: { Data: { Accounts: [account(), account({ CycleCapacityRemain: 3.4, CycleCapacityRemainPrecise: undefined, CapacityRemain: 100 })] } } } }
// 第一条取 Precise 字符串 2.35;第二条 Precise 缺失回退数值字段 3.4
assert.equal(parseCreditsTotal(accountsBody), 2.35 + 3.4)
const nestedBody = { code: 0, data: { Response: { Data: { Data: { Accounts: [account({ CycleCapacityRemain: -5, CycleCapacityRemainPrecise: undefined })] } } } } }
assert.equal(parseCreditsTotal(nestedBody), 0) // 额外 Data 层 + 负 remain 钳零
assert.equal(parseCreditsTotal({ code: 0, data: {} }), undefined)

// ---------- 凭据解析与发现(§2 / §6) ----------
const cpaCredential = {
  auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'codebuddy.cn', region: 'cn' },
  account: { uid: 'u1', enterpriseId: 'e1', nickname: 'n' },
}
const parsed = parseCredential(cpaCredential, 'X/workbuddy-1.json')
assert.equal(parsed.credential.accessToken, 'at')
assert.equal(parsed.credential.uid, 'u1')
assert.equal(parsed.credential.enterpriseId, 'e1')
assert.equal(parseCredential({ auth: { accessToken: { $wbEncrypted: true } } }, 'X').reason, 'encrypted')
assert.equal(parseCredential({ auth: {} }, 'X').reason, 'no-token')
assert.equal(regionOf({ domain: 'workbuddy.ai', region: undefined }), 'global')
assert.equal(regionOf({ domain: 'codebuddy.cn', region: undefined }), 'cn')
assert.equal(regionOf({ domain: 'x', region: 'global' }), 'global')
assert.equal(selectionModel({ next: { provider: 'workbuddy', model: 'glm-5.2' } }), 'glm-5.2')
assert.equal(selectionModel({ next: null, lastUsed: { provider: 'workbuddy', model: 'auto' } }), 'auto')
assert.equal(selectionModel({ next: null, lastUsed: null }), '')
assert.equal(selectionModel(undefined), '')

const future = Date.now() + 3_600_000
const mkFs = (files) => ({
  readFileSync: path => {
    const hit = Object.entries(files).find(([key]) => normalize(key) === normalize(path))
    if (hit === undefined) throw new Error('ENOENT')
    return hit[1]
  },
  readdirSync: dir => Object.keys(files).filter(key => dirname(normalize(key)) === normalize(dir)).map(key => basename(key)),
})
const cpaJson = expires => JSON.stringify({ auth: { accessToken: 'a', refreshToken: 'r', expiresAt: expires, domain: 'codebuddy.cn' }, account: { uid: 'u', enterpriseId: 'e' } })
const fsA = mkFs({ 'C:/cpa/workbuddy-aaa.json': cpaJson(future), 'C:/cpa/workbuddy-bbb.json': cpaJson(future + 1_000_000) })
const found = discoverCredential({ cpaDir: 'C:/cpa', fs: fsA, desktop: ['C:/desk/info'], nowMs: Date.now() })
assert.equal(normalize(found.credential.sourcePath), normalize('C:/cpa/workbuddy-bbb.json')) // §5.5 取 expiresAt 最大且未过期
const fsEncrypted = mkFs({ 'C:/cpa/workbuddy-aaa.json': '{"auth":{"accessToken":{"$wbEncrypted":1}}}', 'C:/desk/workbuddy-desktop.info': cpaJson(future) })
const found2 = discoverCredential({ cpaDir: 'C:/cpa', fs: fsEncrypted, desktop: ['C:/desk/workbuddy-desktop.info'], nowMs: Date.now() })
assert.equal(normalize(found2.credential.sourcePath), normalize('C:/desk/workbuddy-desktop.info')) // 一级全加密 → 二级桌面端
assert.ok(found2.probes.some(probe => probe.reason === 'encrypted'))
const found3 = discoverCredential({ cpaDir: 'C:/cpa', fs: mkFs({}), desktop: ['C:/desk/info'], nowMs: Date.now() })
assert.equal(found3.credential, undefined)
assert.ok(found3.probes.length >= 1) // 三级:都没有 → 只留探测记录,不崩(§6.3)

// ---------- 请求头(§3 六件套 + UA) ----------
const headers = billingHeaders(parsed.credential)
assert.equal(headers.Authorization, 'Bearer at')
assert.equal(headers['X-User-Id'], 'u1')
assert.equal(headers['X-Enterprise-Id'], 'e1')
assert.equal(headers['X-Tenant-Id'], 'e1')
assert.equal(headers['X-Domain'], 'codebuddy.cn')
assert.equal(headers['User-Agent'], 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0')

// ---------- 目录 + 活动(§3.2) ----------
const nightEntry = {
  id: 'glm-52-night-discount-202607', kind: 'discount', enabled: true, modelIds: ['glm-5.2'],
  discount: { factor: 0.5 },
  schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai', validFrom: '2026-07-01T00:00:00+08:00', validUntil: '2027-01-01T00:00:00+08:00' },
  badge: { label: '夜间5折' },
}
const peakEntry = {
  id: 'deepseek-v4-peak', enabled: true, modelIds: ['deepseek-v4'],
  discount: { factor: 0.5 },
  schedule: { daily: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }], timezone: 'Asia/Shanghai' },
  hover: { textZh: '工作日高峰时段原价,其余时段五折' },
}
const badgeOnly = { id: 'hy4-badge', enabled: true, modelIds: ['hy4-preview'], discount: { factor: null }, schedule: { daily: [{ start: '23:00', end: '07:00' }] } }
const disabled = { id: 'off', enabled: false, modelIds: ['glm-5.2'], discount: { factor: 0.1 }, schedule: { daily: [{ start: '00:00', end: '23:59' }] } }
const expiredPromo = { id: 'space-bunny', enabled: true, modelIds: ['glm-5.2'], discount: { factor: 0.1 }, schedule: { daily: [{ start: '00:00', end: '23:59' }], validUntil: '2026-01-01T00:00:00+08:00' } }
const configBody = {
  data: {
    models: [
      { id: 'glm-5.2', name: 'GLM 5.2', credits: 'x0.69' },
      { id: 'auto', name: 'Auto' },
      { id: 'big', name: 'Big', credits: 'x3.31' },
      { id: 'cheap', name: 'Cheap', credits: 'x0.21' },
    ],
    modelPromotions: [nightEntry, peakEntry, badgeOnly, disabled, expiredPromo],
  },
}
const { roster, warnings } = parseRoster(configBody)
assert.equal(roster.models.length, 4)
assert.equal(roster.models[0].multiplier, 0.69)
assert.equal(roster.models[1].multiplier, undefined) // auto = 浮动
assert.equal(roster.promotions.length, 3) // factor:null 徽标与 enabled:false 在解析层跳过;过期条目保留,判定时过滤(§5.2)
assert.equal(warnings.length, 0)

const at = iso => new Date(iso)
const night = activePromotion(roster.promotions, 'glm-5.2', at('2026-10-26T23:30:00+08:00'))
assert.equal(night.factor, 0.5) // 23:30 命中夜间窗
assert.equal(night.periodKey, 'night')
assert.equal(activePromotion(roster.promotions, 'glm-5.2', at('2026-10-26T12:00:00+08:00')), undefined) // 白天无命中
assert.equal(activePromotion(roster.promotions, 'glm-5.2', at('2026-10-26T07:00:00+08:00'))?.factor, 0.5) // 07:00 仍在跨午夜窗口内
assert.equal(activePromotion(roster.promotions, 'glm-5.2', at('2026-10-26T07:50:00+08:00'))?.factor ?? 1, 1) // 07:50 窗口结束(结束值排他)
assert.equal(activePromotion(roster.promotions, 'glm-5.2', at('2026-10-27T00:30:00+09:00'))?.factor ?? 1, 0.5) // 时区按条目自带 Asia/Shanghai
const peak = activePromotion(roster.promotions, 'deepseek-v4', at('2026-10-26T10:00:00+08:00'))
assert.equal(peak === undefined ? 1 : peak.factor, 1) // 「原价」条目:窗口内不打折
assert.equal(activePromotion(roster.promotions, 'deepseek-v4', at('2026-10-26T20:00:00+08:00'))?.factor, 0.5) // 窗口外五折
assert.equal(parseRoster({ data: { models: [], modelPromotions: [] } }), undefined) // 结构不认识 → 降级
assert.equal(parseRoster('junk'), undefined)

// ---------- 换算(§4) ----------
const tokens = computeTokens(4027.1, 0.69 * 0.5, 1000)
assert.equal(formatCompact(tokens), '11.7M') // DESIGN §1 示例口径(未舍入倍率计算)
assert.equal(formatCompact(computeTokens(4027.1, 0, 1000)), '∞') // factor 0 = 免费 → 不限量
assert.equal(formatMultiplier(0.69 * 0.5), 'x0.35') // 显示层两位小数

console.log('dsh-workbuddy-token: all self-checks passed')
