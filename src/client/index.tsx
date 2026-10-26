// 前端胶囊(§1):模型名 · 折后有效倍率 · 时段标签 / ≈ token(估算)。
// React 函数组件 + hooks,宿主共享 React(不打包);点击 = 手动刷新。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import zh from '../../locale/zh.json'
import en from '../../locale/en.json'
import { formatCompact, formatMultiplier, selectionModel } from '../shared'

const STATUS_PATH = '/plugins/dsh-workbuddy-token/status'
const REFRESH_PATH = '/plugins/dsh-workbuddy-token/refresh'
const POLL_MS = 30_000

interface StatusView {
  state?: 'ok' | 'stale' | 'invalid-credential' | 'no-credential' | 'loading'
  credits?: number
  period?: string
  model?: string
  modelStatus?: 'ok' | 'floating' | 'missing' | 'unknown'
  creditsText?: string
  multiplierText?: string
  tokensText?: string
  staleMinutes?: number
  probes?: { path: string, reason: string }[]
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

interface ModelDirectoryStore {
  getSnapshot: () => { current?: { model?: string } | null } | undefined
  subscribe: (listener: () => void) => () => void
}

interface ModelDirectoriesService {
  directoryFor: (sessionId: string) => { store: ModelDirectoryStore }
}

const NO_SUBSCRIBE = () => () => {}

const CSS = `
.dswbt-pill{display:inline-flex;flex-direction:column;gap:1px;padding:2px 8px;border-radius:8px;cursor:pointer;font-size:11px;line-height:1.4;color:inherit;user-select:none;flex:none}
.dswbt-pill:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.dswbt-top{display:flex;align-items:center;gap:4px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.dswbt-sub{white-space:nowrap;opacity:.7;font-variant-numeric:tabular-nums}
.dswbt-dim{opacity:.6;font-weight:500}
.dswbt-warn{opacity:.9}`

let styleInjected = false

function useStyle(): void {
  useEffect(() => {
    if (styleInjected || typeof document === 'undefined') return
    const element = document.createElement('style')
    element.id = 'dsh-workbuddy-token-style'
    element.textContent = CSS
    document.head.append(element)
    styleInjected = true
  }, [])
}

async function fetchStatus(model: string): Promise<StatusView | undefined> {
  try {
    const response = await fetch(`${STATUS_PATH}?model=${encodeURIComponent(model)}`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!response.ok) return undefined
    return await response.json() as StatusView
  } catch { return undefined }
}

function Capsule(props: {
  t: Translate
  useProjection?: (key: string) => unknown
  modelDirectory?: ModelDirectoryStore
}) {
  const { t, useProjection, modelDirectory } = props
  useStyle()
  const projection = useProjection === undefined ? undefined : useProjection('modelSelection')
  // A new session can still be on the catalog default, which the durable
  // modelSelection projection leaves empty until the user changes or sends.
  // Read the model picker's shared directory as the fallback (§1 current model).
  const directoryModel = useSyncExternalStore(
    modelDirectory?.subscribe ?? NO_SUBSCRIBE,
    () => {
      const current = modelDirectory?.getSnapshot()?.current
      return typeof current?.model === 'string' ? current.model : ''
    },
    () => '',
  )
  const model = selectionModel(projection) || directoryModel
  const [doc, setDoc] = useState<StatusView | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const view = await fetchStatus(model)
      if (!cancelled && view !== undefined) setDoc(view)
    }
    void load()
    const timer = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [model])

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setRefreshing(true)
    try {
      const response = await fetch(`${REFRESH_PATH}?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (response.ok) setDoc(await response.json() as StatusView)
    } catch { /* 刷新失败沿用旧值 */ } finally {
      busyRef.current = false
      setRefreshing(false)
    }
  }, [model])

  const state = doc?.state ?? 'loading'
  let top: React.ReactNode = null
  let sub: React.ReactNode = null
  let tooltip = t('refreshHint')

  if (state === 'loading') {
    top = <span>{refreshing ? '…' : t('loading')}</span>
  } else if (state === 'no-credential') {
    top = <span className="dswbt-warn">{t('noCredential')}</span>
    sub = <span>{t('noCredentialSub')}</span>
    tooltip = `${t('refreshHint')}\n${t('probed')}\n${(doc?.probes ?? []).map(probe => `${probe.path} (${t(`probe.${probe.reason}`)})`).join('\n')}`
  } else if (state === 'invalid-credential') {
    top = <span className="dswbt-warn">{t('invalidCredential')}</span>
    if (doc?.creditsText !== undefined) sub = <span>{doc.creditsText} {t('creditsUnit')}</span>
    tooltip = `${t('invalidCredentialLong')}\n${t('refreshHint')}`
  } else {
    const parts: React.ReactNode[] = []
    if (doc?.model !== undefined) parts.push(<span key="model">{doc.model}</span>)
    if (doc?.modelStatus === 'missing') parts.push(<span key="delisted" className="dswbt-dim">{t('modelDelisted')}</span>)
    else if (doc?.multiplierText !== undefined) parts.push(<span key="mult" className="dswbt-dim">{doc.multiplierText}</span>)
    else parts.push(<span key="mult" className="dswbt-dim">{t('rateUnknown')}</span>)
    if (doc?.period !== undefined) parts.push(<span key="period" className="dswbt-dim">{t(`period.${doc.period}`)}</span>)
    top = parts.length > 0 ? parts : <span>{t('loading')}</span>

    if (doc?.tokensText !== undefined && doc.modelStatus !== 'missing') {
      sub = <span>≈ {doc.tokensText} {t('tokensUnit')}{t('estimateSuffix')}</span>
    } else if (doc?.creditsText !== undefined) {
      sub = <span>{doc.creditsText} {t('creditsUnit')}{doc.modelStatus === 'missing' ? ` · ${t('modelDelisted')}` : ''}</span>
    }
    if (state === 'stale' && doc?.staleMinutes !== undefined) {
      tooltip = `${t('stale', { min: doc.staleMinutes })}\n${t('refreshHint')}`
      sub = <>{sub}<span className="dswbt-dim"> · {t('staleShort', { min: doc.staleMinutes })}</span></>
    }
  }

  return (
    <div className="dswbt-pill" onClick={() => { void refresh() }} title={tooltip} role="button" tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void refresh() } }}>
      <span className="dswbt-top">{top}</span>
      {sub === null ? null : <span className="dswbt-sub">{sub}</span>}
    </div>
  )
}

const clientInject = ['slots', 'locale']
const clientName = 'dsh-workbuddy-token'

interface ClientContext {
  effect(callback: () => unknown, label?: string): unknown
  inject?(names: string[], callback: (scope: ClientContext & { modelDirectories: ModelDirectoriesService }) => unknown): unknown
  locale: { register(namespace: string, dictionaries: Record<string, unknown>): unknown, bind(namespace: string): Translate }
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
}

function clientApply(ctx: ClientContext): void {
  try {
    const namespace = 'dsh-workbuddy-token'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddy-token: locale')
    const t = ctx.locale.bind(namespace)
    const registerCapsule = (modelDirectoryFor?: (sessionId: string) => ModelDirectoryStore | undefined) => {
      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-workbuddy-token-capsule',
        order: 5,
        locale: namespace,
        inject: (sessionId: string) => ({ t, modelDirectory: modelDirectoryFor?.(sessionId) }),
      }, Capsule)), 'dsh-workbuddy-token: capsule slot')
    }
    // 输入框工具行(与 dsh-connect-workbuddy 的积分读数同槽,order 错开)。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessions', 'remote', 'remote.session', 'modelDirectories'], scope => {
        const modelDirectoryFor = (sessionId: string) => {
          try { return scope.modelDirectories.directoryFor(sessionId).store } catch { return undefined }
        }
        registerCapsule(modelDirectoryFor)
      })
    } else {
      registerCapsule()
    }
  } catch (error) {
    console.error('[dsh-workbuddy-token] client failed to load:', error)
  }
}

export { clientApply as apply, clientInject as inject, clientName as name, Capsule, formatCompact, formatMultiplier }
