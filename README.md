# dsh-workbuddy-token

DSH(DeepSeek Harness)插件:在输入框旁显示 WorkBuddy 剩余积分按「当前模型 × 当前时段」折后倍率换算的 token 估算。

```
┌──────────────────────────────┐
│ glm-5.2 · x0.35 · 夜间        │
│ ≈ 11.7M tokens(估算)         │
└──────────────────────────────┘
  点击胶囊 = 手动刷新(立即拉积分 + 配置两个接口)
```

- 只读:只调 `/v2/billing/meter/get-user-resource` 与 `/v3/config`,不做任何签到/领取/2api 写操作
- 直连上游(`www.codebuddy.cn` / `www.workbuddy.ai`,按凭据 region/domain 路由),不经过 CPA 代理
- 零硬编码数据:模型表、倍率、活动每次刷新全量重建,有效性实时判定
- 请求纪律:积分默认 5 分钟 1 次、配置默认 2 小时 1 次,失败 1→2→4→8 分钟指数退避
- 凭据发现:CPA 目录(`~/.cli-proxy-api/workbuddy-*.json`,glob 发现)→ WorkBuddy 桌面端登录文件;日志与 UI 绝不输出 token

## 配置(profile 插件配置)

| 键 | 默认 | 说明 |
|---|---|---|
| `creditsIntervalSec` | 300 | 积分刷新间隔(秒,最小 60) |
| `configIntervalSec` | 7200 | 模型/活动配置刷新间隔(秒,最小 600) |
| `cpaDir` | `~/.cli-proxy-api` | CPA 凭据目录 |
| `baseTokensPerCredit` | 50000 | 基准费率:x1 倍率下 1 积分对应的 token 数(2026-10-29 用真实用量实测校准:58.96M token ↔ 201.8 积分,加权倍率 x0.169;官方未公布,后续可再校准) |

## 安装到 DSH Desktop profile

```bash
node install.mjs                 # 默认 desktop profile;--profile <name> 可指定其他
```

自动完成:备份 profile 的 `package.json`/`pnpm-lock.yaml` → 注册 `file:` 依赖并加入 `dsh.profile.bundles` → `pnpm install` → 自检(宿主/客户端模块加载、exports 齐全、凭据发现)。幂等,可重复运行。

说明:DSH Desktop 的 profile 由 Electron 应用独占管理,`dsh plugin add` 会拒绝;本脚本走的是 DSH 自带插件管理器的同款路径(改 profile package.json + pnpm)。回滚:用安装时生成的 `.bak-<时间戳>` 文件覆盖回去再 `pnpm install`。

## 构建与测试

```bash
pnpm i && pnpm build   # lib/index.js + lib/client.js
pnpm test              # node test/verify.mjs,断言换算/窗口/解析逻辑
```

## 三态显示

- 正常:实时数据;第二行常驻剩余积分(WorkBuddy 模型附 token 估算);auto 等浮动倍率模型显示区间
- 降级:上游失败时显示最后成功缓存并标注「X 分钟前」
- 异常:凭据失效(401/403)提示重新登录;当前模型已从目录消失显示「已下架」,积分照常;选中的是非 WorkBuddy 模型时不猜倍率、只显示剩余积分
