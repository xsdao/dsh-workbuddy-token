// dsh-workbuddy-token 桌面 profile 安装器。
//
// 背景:`dsh plugin add` 对 Electron 管理的 profile(如 desktop)返回
// "managed exclusively by the Electron application",DSH 自带的插件管理器
// 实际做法就是在 profile 目录里跑 pnpm 并把包名写进 dsh.profile.bundles——
// 本脚本做同一件事,外加安装后自检。零依赖,Node >= 22。
//
// 用法:node install.mjs [--profile <name>]   (默认 desktop)
// 幂等:重复运行无副作用(同值不改,仅追加新备份)。
// 安全:只读凭据;输出只有路径与失败原因,绝不打印 token/uid。

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_NAME = 'dsh-workbuddy-token'
const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))

const profileArg = process.argv.indexOf('--profile')
const profileName = profileArg >= 0 ? String(process.argv[profileArg + 1] ?? '') : 'desktop'
const profilesRoot = join(homedir(), '.dsh', 'profiles')
const profileDir = resolve(profilesRoot, profileName)
if (dirname(normalize(profileDir)) !== normalize(profilesRoot) || profileName === '' || profileName.includes('/') || profileName.includes('\\')) {
  console.error(`✗ 非法 profile 名:${profileName}`)
  process.exit(2)
}
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`✗ 不是 DSH profile(缺 package.json):${profileDir}`)
  process.exit(2)
}

console.log(`profile: ${profileDir}`)
const pnpmCheck = spawnSync('pnpm', ['--version'], { shell: true, encoding: 'utf8' })
if (pnpmCheck.status !== 0) {
  console.error('✗ 未找到 pnpm(https://pnpm.io/installation),DSH 插件管理也依赖它')
  process.exit(2)
}
console.log(`pnpm: ${pnpmCheck.stdout.trim()}`)

// 1. 备份(每次运行都追加一份,恢复 = 改回文件名并 pnpm install)
const stamp = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}-${String(new Date().getHours()).padStart(2, '0')}${String(new Date().getMinutes()).padStart(2, '0')}${String(new Date().getSeconds()).padStart(2, '0')}`
for (const name of ['package.json', 'pnpm-lock.yaml']) {
  const source = join(profileDir, name)
  if (existsSync(source)) {
    const backup = join(profileDir, `${name}.bak-${stamp}`)
    copyFileSync(source, backup)
    console.log(`备份: ${name} → ${backup.split(sep).pop()}`)
  }
}

// 2. 注册依赖(file: 指向本目录)与 bundle 行
const pkgPath = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bundles = pkg?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('✗ profile package.json 缺 dsh.profile.bundles 数组,结构异常,终止')
  process.exit(2)
}
pkg.dependencies ??= {}
pkg.dependencies[PLUGIN_NAME] = pathToFileURL(PLUGIN_ROOT).href
if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
// 必须落盘:不写回的话后面 pnpm 读到的还是磁盘上的旧 package.json
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`注册: dependencies[${PLUGIN_NAME}] = ${pkg.dependencies[PLUGIN_NAME]}`)

// 3. pnpm 安装(与 DSH 自带插件管理器同款动作)
const sourceVersion = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version
const installedVersionOf = () => {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8')).version
  } catch { return '(missing)' }
}
const installed = spawnSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit', shell: true })
if (installed.status !== 0) {
  console.error(`✗ pnpm install 失败(退出码 ${installed.status});package.json 已改,可用备份回滚`)
  process.exit(installed.status ?? 1)
}

// pnpm 对未变的 file: 依赖不重拷内容;版本对不上说明装的是旧副本,删掉重装一次
if (sourceVersion !== installedVersionOf()) {
  console.log(`已装副本 ${installedVersionOf()} 落后于源 ${sourceVersion},重拷…`)
  rmSync(join(profileDir, 'node_modules', PLUGIN_NAME), { recursive: true, force: true })
  const retry = spawnSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit', shell: true })
  if (retry.status !== 0) {
    console.error('✗ 重装失败,可用备份回滚')
    process.exit(retry.status ?? 1)
  }
}
// 终检:版本仍不一致说明装错了树,自检项不区分版本,这里必须硬失败
if (sourceVersion !== installedVersionOf()) {
  console.error(`✗ 安装后版本仍不一致(源 ${sourceVersion} vs 已装 ${installedVersionOf()}),检查 profile 依赖是否指向本目录`)
  process.exit(1)
}
console.log(`✓ 已装副本版本一致(${sourceVersion})`)

// 4. 自检(全部只读)。用 profile 里真实落位的副本,而不是源目录。
const lib = async relativePath => import(pathToFileURL(join(profileDir, 'node_modules', PLUGIN_NAME, relativePath)).href)
let failures = 0
try {
  const host = await lib('lib/index.js')
  if (typeof host.apply !== 'function' || host.name !== PLUGIN_NAME) throw new Error('宿主入口缺 apply/name')
  console.log('✓ 宿主模块可加载(apply/name 就位)')
} catch (error) {
  failures += 1
  console.error(`✗ 宿主模块加载失败:${error.message}`)
}
try {
  const clientHead = readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'lib', 'client.js'), 'utf8').slice(0, 200)
  // tsdown 会把 banner 美化成多行,这里按空白容忍匹配
  if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-workbuddy-token"/.test(clientHead)) throw new Error('缺 ModuleLoader 外壳')
  console.log('✓ 客户端 bundle 形态正确(ModuleLoader 外壳)')
} catch (error) {
  failures += 1
  console.error(`✗ 客户端检查失败:${error.message}`)
}
for (const relativePath of ['package.json', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json']) {
  if (!existsSync(join(profileDir, 'node_modules', PLUGIN_NAME, relativePath))) {
    failures += 1
    console.error(`✗ 缺文件:${relativePath}`)
  }
}
if (failures === 0) console.log('✓ exports 子路径齐全(package.json/cordis.patch.yml/locale)')

try {
  const host = await lib('lib/index.js')
  const { credential, probes } = host.discoverCredential({})
  if (credential === undefined) {
    console.warn('⚠ 未找到 WorkBuddy 凭据(插件可加载,胶囊将显示中性态):')
    for (const probe of probes) console.warn(`  ${probe.path} → ${probe.reason}`)
  } else {
    const expires = credential.expiresAtMs > 0 ? new Date(credential.expiresAtMs).toLocaleString() : '未知'
    console.log(`✓ 凭据已发现:${credential.sourcePath}(过期时间 ${expires},区域 ${credential.region ?? credential.domain ?? 'cn'})`)
  }
} catch (error) {
  console.warn(`⚠ 凭据自检跳过:${error.message}`)
}

console.log(failures === 0 ? '\n完成。重启 DSH Desktop 生效,输入框旁应出现胶囊。' : `\n完成,但有 ${failures} 项自检未过——重启 DSH 前先看上面的 ✗ 行。`)
process.exit(failures === 0 ? 0 : 1)
