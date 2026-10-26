// 冒烟测试:用 stub 宿主上下文跑真实 apply(),直连上游各发 1 次只读请求,
// 再走本地路由读 status。手动运行:node test/smoke.mjs [modelId](会真实联网,只读)。

import { apply } from '../lib/index.js'

const disposers = []
const routes = new Map()
const ctx = {
  effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
}
const webCtx = {
  effect: ctx.effect,
  webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
}
ctx.inject = (names, callback) => { callback(webCtx) }

apply(ctx, {})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
await wait(10_000) // 等启动那次积分+config 拉取(15s 超时上限)

const model = process.argv[2] ?? 'glm-5.2'
const respond = () => { let payload = ''; return { writeHead: () => {}, end: body => { payload = body } , get body() { return payload } } }
const res = respond()
await routes.get('/plugins/dsh-workbuddy-token/status')({ method: 'GET', url: `/plugins/dsh-workbuddy-token/status?model=${encodeURIComponent(model)}` }, res)
console.log(`status ${res.body}`)

const refreshed = respond()
await routes.get('/plugins/dsh-workbuddy-token/refresh')({
  method: 'POST',
  url: `/plugins/dsh-workbuddy-token/refresh?model=${encodeURIComponent(model)}`,
  headers: { host: 'localhost' },
}, refreshed)
console.log(`refresh ${refreshed.body}`)

for (const dispose of disposers) dispose()
process.exit(0)
