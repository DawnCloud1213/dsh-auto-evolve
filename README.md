# @dawn/dsh-auto-evolve

DSH 的 cordis 原生宿主插件（M3-a）。替代 M1 那套「解压多帧 zstd 会话日志」的胶水：**在 DSH 进程内**直接拿到会话历史，
按累计工具调用数节流写进 review 队列，再 detached 拉起 `bg-review.mjs` 做后台审查。审查、落草稿、记账本全部仍在 `bg-review.mjs` 里。

同一个包还带一个**进化看板**：会话页新增「进化」Tab，把技能触发次数、进化路线时间线和审查心跳摊开看（见下文）。

契约唯一事实源：`evolution/CONTRACT.md` §1 §2（安装后位于 `<evolutionDir>/CONTRACT.md`）。

## 文件

| 文件 | 说明 |
|:--|:--|
| `package.json` | 纯 ESM 包声明；`dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后自动挂进 profile layer stack |
| `cordis.patch.yml` | 一行 `insert`: `id: auto-evolve`, `name: '@dawn/dsh-auto-evolve'`, `config: {}` |
| `lib/index.js` | 宿主插件入口，`export { name, inject, apply }`（**不导出 Config**，参考 `@dawn/dsh-git-graphic`） |
| `lib/dashboard.js` | 看板宿主半边：只读聚合 `evolutionDir`，注册 `/api/evolve-dashboard/*` 路由 |
| `lib/client.js` | 看板浏览器端：`window.__ModuleLoader__.load` 格式，注册「进化」Tab（React，零构建） |
| `test/mock-ctx.mjs` | 最小假 ctx + 假 agent 的行为测试（队列结构、心跳、注入、降级不崩、写失败不抛） |
| `test/import-smoke.mjs` | 导入冒烟：导出齐全、无外部静态依赖、apply 可跑 |
| `test/dashboard-smoke.mjs` | 看板路由冒烟：4 个端点、聚合正确、坏行容错、非法 slug 400、dispose 干净 |
| `evolution/bg-review.mjs` | **后台审查器**：读队列 → 两段式 LLM 审查 → 落草稿 / 改写技能 / 记账本（独立进程，装到 `<evolutionDir>/`） |
| `evolution/lib/*.mjs` | 审查器依赖：`llm`（凭证+重试）、`session`（多帧 zstd）、`prompt`（模板）、`ledger`、`skills-index`、`skill-usage`、`curator` |
| `evolution/CONTRACT.md` | 插件 ↔ 审查器契约（队列格式、心跳字段、CLI 行为） |

## 行为

1. **`agent/turn-stopping`**
   - 每次轮次结束 `turnsSeen += 1`，写心跳。
   - 每轮先数一遍本轮新增的 `tool-call` 块（`itersSinceReview += 本轮累计 - 上轮累计`；会话被裁剪时增量记 0，不回退）。
   - 节流命中条件（全部满足）：`itersSinceReview >= nudgeInterval`、距上次触发 ≥ `cooldownMinutes`、当日触发数 < `dailyCap`。
   - 顺带做技能使用遥测：只扫本轮新增消息里的技能调用，动态加载 `<evolutionDir>/lib/skill-usage.mjs` 累加 `use_count`；遥测失败绝不影响主流程。
   - 命中后：`agent.session.deriveMessages()` → 防御性归一化 → 写
     `<evolutionDir>/review/queue/<sanitize(sessionId)>-<turn>.json`（先写 `.tmp` 再 `rename`，原子替换）→
     `spawn(nodePath, [bgReviewScript, '--queue-file', file, '--trigger', 'plugin'], { detached: true, stdio: 'ignore', windowsHide: true })` + `unref()`。
   - 同一 `(sessionId, turn)` 进程内只写一次；拉子进程失败只记 `lastError`，绝不影响会话。
2. **`system-prompt/assemble`（草稿提醒的唯一投递口）**
   - 宿主每步组装 system prompt 都会走这个 waterfall。插件扫 `<evolutionDir>/drafts/*.md`（只收 `status: draft`，最多 `draftsInjectLimit` 条），
     把「【后台沉淀草稿待审】」清单 + 处理指引 push 进 `assembly.contexts`，由宿主渲染成**运行时上下文快照**。
   - **不再用 `agent.inject()` 伪造用户消息**（v0.2.0 起）：那会冒充用户说话、被模型当新请求，历史版本还曾因 source kind 触发 `SessionFormatError` 炸掉整轮。
   - 每步都要 push（内容不变时渲染文本相同，宿主不会重复落盘；跳过反而会多落一份「没有本块」的快照）。
   - 文本必须打断 `{{...}}`（宿主模板插值）：草稿正文里的 `{{` 会被替换成带零宽空格的写法。
   - 异常一律吞掉并 `return next()`，绝不打断模型请求。
3. **`agent/session-start` / `agent/pre-step`（只留观测）**
   - 两者都不再注入任何东西：`session-start` 只刷新 `lastSessionStartAt/Source`，`pre-step` 只累加 `preStepChecks`，都原样透传 `next()`。
   - 保留它们是为了排查「重启恢复旧会话时 session-start 是否被错过」。
4. **心跳（观测用）**
   - `apply` 时写；之后每次 `turn-stopping` / `session-start` / 非子代理 `pre-step` 都刷新。
   - 字段：`{ plugin, version, pid, startedAt, lastTurnAt, turnsSeen, itersSinceReview, itersTotal, nudgeInterval, lastQueueFile, lastError, lastSessionStartAt, lastSessionStartSource, noticePushes, lastNoticeAt, lastNoticeTrigger, preStepChecks }`。
   - 排查用途：`lastSessionStartAt` 长期为 `null` 而 `preStepChecks` 在涨 = 重启时确实错过了 session-start；
     `noticePushes` / `lastNoticeAt` 说明草稿提醒到底推没推到模型上下文里。
5. **子代理 / 委派会话完全静默**
   - 判定：`agent.session.header.origin === 'subagent'` 或 `header.delegationDepth > 0`。
   - 这类会话的 `system-prompt/assemble` **不推**草稿清单（否则每起一个子代理就刷一遍待审，纯噪音 + 白烧 token）；
     `turn-stopping` **不累加 turnsSeen、不写心跳、不排 review**（否则委派会放大触发节奏，并对同一份历史重复审查）。
   - 读不到 header / 字段缺失时按主会话处理：宁可照常触发，也不静默失效。

所有回调都包在 `try/catch` 里：异常只 `ctx.logger.warn('auto-evolve: ...')` 并记 `lastError`，**不向宿主抛错**。

## 队列 JSON（写给 bg-review 的契约）

```json
{
  "schema": 1,
  "producer": "dsh-auto-evolve",
  "sessionId": "原始 session id",
  "turn": 12,
  "cwd": "<会话工作目录>",
  "createdAt": "2026-10-28T17:00:00.000Z",
  "messageCount": 42,
  "messages": [{ "role": "user", "parts": [{ "kind": "text", "text": "..." }] }],
  "transcript": "### turn 11\n[user] ...\n[assistant] ...\n"
}
```

归一化规则：只保留 `role = user | assistant`，并跳过 `source.kind` 以 `plugin:` 开头的消息（插件自己注入的提醒不算用户原话）；内容块 `text → kind: text`；`tool-call → kind: tool-call`（`name` + `args` 截断 300）；
`tool-result → kind: tool-result`（嵌套内容拍平后截断 800）；`reasoning` / `image` / `file` / 未知类型**一律忽略**。
消息最多 `maxMessages` 条、整体 ≤ 60000 字符（超了从头丢，保留最近上下文）。

## 配置

`cordis.patch.yml` 里 `config: {}` 保持为空，默认值在 `lib/index.js` 的 `resolveConfig()` 里合并；要覆盖就直接写在 `config:` 下。

| 键 | 默认值 | 说明 |
|:--|:--|:--|
| `enabled` | `true` | 总开关；`false` 时只写心跳，不写队列、不拉子进程 |
| `nudgeInterval` | `10` | 累计 N 次工具调用才可能触发一次审查（对齐 Hermes 的 `_skill_nudge_interval`） |
| `everyTurns` | `3` | **已废弃**，仅保留字段以兼容老配置（v0.2.x 按轮数触发） |
| `cooldownMinutes` | `30` | 两次触发之间的最小间隔（分钟），`0` = 不冷却 |
| `dailyCap` | `12` | 每自然日最多触发次数（本地日切） |
| `maxMessages` | `120` | 队列里最多保留多少条消息 |
| `evolutionDir` | `~/.dsh/evolution` | 自进化根目录（queue/drafts/心跳都在它下面） |
| `nodePath` | `DSH_NODE_PATH` → Windows 标准 Node → `node`（PATH） | 拉起 bg-review 用的 node |
| `bgReviewScript` | `<evolutionDir>/bg-review.mjs` | 后台审查脚本路径 |
| `draftsInjectLimit` | `5` | session-start 最多列出几条草稿 |

## 进化看板（会话页「进化」Tab）

同一个包同时提供看板：宿主半边在 `lib/dashboard.js`，浏览器端在 `lib/client.js`。

- **概况卡**：技能总数/活跃/归档、累计触发次数、路线事件（草稿/改写/转正/退役）、待审队列
- **审查心跳**：插件版本、pid、累计工具调用、每 N 次审查一轮、今日审查次数、最近结论与错误
- **技能触发次数榜**：按 `use_count` 降序，条形 + 状态徽章 + 是否已转正；点一行看技能正文
- **进化路线时间线**：`ledger.jsonl` 事件流，动作分色，带原因、置信度、模型、会话
- 纯只读、零构建；页面可见时 8 秒自动刷新

数据接口（POST + JSON，供 client fetch）：

| 路径 | 返回 |
|:--|:--|
| `/api/evolve-dashboard/overview` | 心跳 + 审查状态 + 汇总计数 |
| `/api/evolve-dashboard/skills` | 技能清单（按 useCount 降序） |
| `/api/evolve-dashboard/timeline` | 账本事件（默认 200 条，`{limit}` 可调） |
| `/api/evolve-dashboard/skill` | 单个技能正文 `{slug}` |

> 宿主半边通过 `ctx.inject(['webServer'])` 延迟挂载：headless 等没有 webServer 的宿主自动跳过，不影响审查主流程。
> 数据目录跟随 `config.evolutionDir`（默认 `~/.dsh/evolution`）。

## 审查链路（`evolution/`）

插件只负责「导出消息 + 拉进程」，真正干活的 `bg-review.mjs` 在 `evolution/` 里，**独立进程运行**（改审查逻辑不用重启 DSH）：

```
插件 turn-stopping → 写 <evolutionDir>/review/queue/*.json
  → detached spawn node bg-review.mjs --queue-file <file> --trigger plugin
      ├─ 读队列（优先 transcript）
      ├─ 两段式 LLM 审查（deepseek-chat，严格 JSON）
      ├─ none：只记账；draft（conf ≥ 0.6）：写 drafts/<slug>.md + ledger.jsonl
      ├─ 直接改写/转正已有技能（diff + 备份 + 校验）
      ├─ 删队列文件；写 review/last-result.json
      └─ 退出码恒 0（异常全吞，日志 review/bg-review.log）
```

审查器不需要安装依赖：只用 Node 内置模块。**插件会自动使用包里自带的 `evolution/bg-review.mjs`**，
运行数据（队列 / 草稿 / 账本 / 心跳）仍写到 `<evolutionDir>`（默认 `~/.dsh/evolution`，首次运行自动建目录）——
**装完重启即可，不用手动复制任何文件**。

> 想换成自己的审查器：把插件配置里的 `bgReviewScript` 指到任意路径（显式配置优先）。
> 旧版「手工复制到 `<evolutionDir>/`」的装法仍然兼容：包里找不到时才回退到 `<evolutionDir>/bg-review.mjs`。

运行前提：
- `node` ≥ 20：插件按 `DSH_NODE_PATH` → Windows 标准安装路径 → PATH 的顺序找。
- `~/.dsh/.credentials.yaml` 里有 `DEEPSEEK_API_KEY`（审查器自己读，**不读环境变量、不写日志**）。
- **数据外发**：队列文件含会话内容，会被发往 `api.deepseek.com` 做审查；不想发就把插件 `enabled: false`，或改 `evolution/lib/llm.mjs` 的 endpoint。
- 草稿不会自动生效：人在会话里看到「【后台沉淀草稿待审】」后决定转正 / 合并 / 丢弃。

## 安装

**方式 A：DSH 插件页直接装**（不需要 clone）——在插件管理里填 GitHub 地址（管理器按 `pnpm add` 的 spec 处理）：

```
https://github.com/DawnCloud1213/dsh-auto-evolve
```

**方式 B：手动接线**

1. `git clone https://github.com/DawnCloud1213/dsh-auto-evolve.git`
2. DSH profile 的 `package.json`：`dependencies` 加 `"@dawn/dsh-auto-evolve": "file:<clone 路径>"`，
   `dsh.profile.bundles` 数组加 `"@dawn/dsh-auto-evolve"`。
3. 该 profile 目录执行 `pnpm install`。
4. 重启 DSH 桌面应用（cordis 宿主插件在主进程加载，热更不生效）；桌面端再刷新页面（Ctrl+R）才会注入「进化」Tab。

> 审查链路随包分发、插件自动定位，**无需复制**；数据目录首次运行自动创建。

> 首次上线想更保守，可先在 `cordis.patch.yml` 的 `config:` 里写 `enabled: false`，确认能加载、心跳出现后再改回。

## 验证

```powershell
node --check lib/index.js
node --check evolution/bg-review.mjs
node test/import-smoke.mjs
node test/mock-ctx.mjs
node test/dashboard-smoke.mjs
```

装好后（真实 DSH 里）：

1. `~/.dsh/evolution/review/plugin-heartbeat.json` 出现，`turnsSeen` 随对话增长；
2. 累计满 10 次工具调用（`plugin-heartbeat.json` 里的 `itersSinceReview` 到 10）→ `~/.dsh/evolution/review/queue/<session>-<turn>.json` 出现；
3. 新开会话且 `drafts/` 里有 `status: draft` 的草稿 → 上下文出现「【后台沉淀草稿待审】」；
4. `~/.dsh/evolution/review/last-result.json` 由 `bg-review.mjs` 产出（审查链路见 `evolution/CONTRACT.md` §3）。

看板半边：

5. `POST http://127.0.0.1:9985/api/evolve-dashboard/overview` 返回 200 且 `counts.skills` 非 0；
6. 会话页出现「进化」Tab，技能榜与时间线有数据（触发次数为 0 说明遥测还没累加，正常）。

## 回退

profile 的 `package.json` 删掉依赖 + `dsh.profile.bundles` 删掉条目 → `pnpm install` → 重启。
本包目录留着不引用就不会加载；`<evolutionDir>/review/plugin-heartbeat.json` 停止更新即为「已卸载」证据。

## 注意

- 插件只负责**导出消息**，真正的 LLM 审查、草稿落盘、账本都在 `bg-review.mjs`：改审查逻辑不用重启 DSH。
- 队列文件含会话内容，会被 `bg-review.mjs` 发往云端模型（`deepseek-chat`）；不想发就 `enabled: false`。
- 不静态 `import` 任何外部包：`createUserMessage` 走 `import('@deepseek-ai/dsh-llm')`，失败则手造 `{ id: randomUUID(), role: 'user', ... }`，
  这样用 `file:` 依赖装进 profile 时不会因解析不到裸包名而加载失败。

