// 凭据发现链(§6,三级,第一个成功即用):CPA 目录 glob → WorkBuddy 桌面端登录文件 → 都没有。
// 全程只读;探测记录只有路径与原因码,绝不带 token/uid。

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isExpired, parseCredential, type Credential, type Probe } from './shared'

export function defaultCpaDir(): string {
  return join(homedir(), '.cli-proxy-api')
}

/** 桌面端登录文件候选(win32/macOS/Linux,dsh-connect-workbuddy 同款路径表)。 */
export function desktopAuthCandidates(home = homedir()): string[] {
  const rel = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info']
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', ...rel)]
  if (process.platform === 'win32') {
    return [join(home, 'AppData', 'Local', ...rel), join(home, 'AppData', 'Roaming', ...rel)]
  }
  return [join(home, '.config', ...rel), join(home, '.local', 'share', ...rel)]
}

export interface Discovery {
  credential?: Credential
  probes: Probe[]
}

export interface FsLike {
  readFileSync: (path: string, encoding: 'utf8') => string
  readdirSync: (path: string) => string[]
}

const nodeFs: FsLike = { readFileSync, readdirSync }

function parseJsonFile(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * 发现凭据。CPA 目录按 §5.5 取 expiresAt 最大且未过期的 workbuddy-*.json(文件名
 * 含账号 UUID,glob 发现、禁止写死);CPA 无可用文件再走桌面端候选的第一条可用
 * 文件。全部过期时兜底取最晚过期的一条,让上游 401 来定性(§5.4 异常态)。
 */
export function discoverCredential(options: { cpaDir?: string, fs?: FsLike, desktop?: string[], nowMs?: number } = {}): Discovery {
  const { cpaDir = defaultCpaDir(), desktop = desktopAuthCandidates(), nowMs = Date.now() } = options
  const fs = options.fs ?? nodeFs
  const probes: Probe[] = []
  const read = (path: string): string | undefined => {
    try { return fs.readFileSync(path, 'utf8') } catch { return undefined }
  }
  const probe = (path: string, credential: { credential?: Credential, reason?: Probe['reason'] }): Credential | 'expired' | undefined => {
    if (credential.credential === undefined) {
      probes.push({ path, reason: credential.reason ?? 'no-token' })
      return undefined
    }
    if (isExpired(credential.credential, nowMs)) {
      probes.push({ path, reason: 'expired' })
      return 'expired'
    }
    return credential.credential
  }

  // 一级:CPA 目录。
  let best: Credential | undefined
  let expiredBest: Credential | undefined
  try {
    const names = fs.readdirSync(cpaDir).filter(name => /^workbuddy-.+\.json$/i.test(name)).sort()
    for (const name of names) {
      const path = join(cpaDir, name)
      const text = read(path)
      if (text === undefined) { probes.push({ path, reason: 'unreadable' }); continue }
      const outcome = probe(path, parseCredential(parseJsonFile(text), path))
      if (outcome === 'expired') {
        const parsed = parseCredential(parseJsonFile(text), path).credential!
        if (expiredBest === undefined || parsed.expiresAtMs > expiredBest.expiresAtMs) expiredBest = parsed
      } else if (outcome !== undefined && (best === undefined || outcome.expiresAtMs > best.expiresAtMs)) {
        best = outcome
      }
    }
  } catch {
    probes.push({ path: cpaDir, reason: 'missing' })
  }
  if (best !== undefined) return { credential: best, probes }

  // 二级:WorkBuddy 桌面端登录文件。
  for (const path of desktop) {
    const text = read(path)
    if (text === undefined) { probes.push({ path, reason: 'unreadable' }); continue }
    const outcome = probe(path, parseCredential(parseJsonFile(text), path))
    if (outcome !== undefined && outcome !== 'expired') return { credential: outcome, probes }
  }

  // 三级:都没有。
  if (expiredBest !== undefined) return { credential: expiredBest, probes }
  return { probes }
}
