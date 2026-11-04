# @dawn/dsh-auto-evolve

DSH 的 cordis 原生宿主插件（M3-a）。替代 M1 那套「解压多帧 zstd 会话日志」的胶水：**在 DSH 进程内**直接拿到会话历史，
按累计工具调用数节流写进 review 队列，再 detached 拉起 `bg-review.mjs` 做后台审查。审查、落草稿、记账本全部仍在 `bg-review.mjs` 里。

契约唯一事实源：`C:/Users/DawnCloud/.dsh/evolution/M3-PLUGIN-CONTRACT.md` §1 §2。

## 文件

| 文件 | 说明 |
|:--|:--|
| `package.json` | 纯 ESM 包声明；`dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后自动挂进 profile layer stack |
| `cordis.patch.yml` | 一行 `insert`: `id: auto-evolve`, `name: '@dawn/dsh-auto-evolve'`, `config: {}` |
| `lib/index.js` | 插件入口，`export { name, inject, apply }`（**不导出 Config**，参考 `@dawn/dsh-git-graphic`） |
| `test/mock-ctx.mjs` | 最小假 ctx + 假 agent 的行为测试（队列结构、心跳、注入、降级不崩、写失败不抛） |
| `test/import-smoke.mjs` | 导入冒烟：导出齐全、无外部静态依赖、apply 可跑 |

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
  "cwd": "C:/Users/DawnCloud/.dsh/profiles/desktop",
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
| `evolutionDir` | `C:/Users/DawnCloud/.dsh/evolution` | 自进化根目录（queue/drafts/心跳都在它下面） |
| `nodePath` | `C:/Program Files/nodejs/node.exe` | 拉起 bg-review 用的 node |
| `bgReviewScript` | `<evolutionDir>/bg-review.mjs` | 后台审查脚本路径 |
| `draftsInjectLimit` | `5` | session-start 最多列出几条草稿 |

## 安装（由 Lead 执行，勿在队友会话里直接改 profile）

1. `C:/Users/DawnCloud/.dsh/profiles/desktop/package.json`：`dependencies` 加 `"@dawn/dsh-auto-evolve": "file:E:/JUST_DO_IT/dsh-auto-evolve"`，
   `dsh.profile.bundles` 数组加 `"@dawn/dsh-auto-evolve"`。
2. 在该目录 `pnpm install`。
3. 重启 DSH 桌面应用（cordis 宿主插件在主进程加载，热更不生效）。

> 首次上线想更保守，可先在 `cordis.patch.yml` 的 `config:` 里写 `enabled: false`，确认能加载、心跳出现后再改回。

## 验证

```powershell
cd E:/JUST_DO_IT/dsh-auto-evolve
& 'C:/Program Files/nodejs/node.exe' --check lib/index.js
& 'C:/Program Files/nodejs/node.exe' test/import-smoke.mjs
& 'C:/Program Files/nodejs/node.exe' test/mock-ctx.mjs
```

装好后（真实 DSH 里）：

1. `~/.dsh/evolution/review/plugin-heartbeat.json` 出现，`turnsSeen` 随对话增长；
2. 累计满 10 次工具调用（`plugin-heartbeat.json` 里的 `itersSinceReview` 到 10）→ `~/.dsh/evolution/review/queue/<session>-<turn>.json` 出现；
3. 新开会话且 `drafts/` 里有 `status: draft` 的草稿 → 上下文出现「【后台沉淀草稿待审】」；
4. `~/.dsh/evolution/review/last-result.json` 由 `bg-review.mjs` 产出（审查链路见 M3 契约 §3）。

## 回退

profile 的 `package.json` 删掉依赖 + `dsh.profile.bundles` 删掉条目 → `pnpm install` → 重启。
本包目录留着不引用就不会加载；`review/plugin-heartbeat.json` 停止更新即为「已卸载」证据。

## 注意

- 插件只负责**导出消息**，真正的 LLM 审查、草稿落盘、账本都在 `bg-review.mjs`：改审查逻辑不用重启 DSH。
- 队列文件含会话内容，会被 `bg-review.mjs` 发往云端模型（`deepseek-chat`）；不想发就 `enabled: false`。
- 不静态 `import` 任何外部包：`createUserMessage` 走 `import('@deepseek-ai/dsh-llm')`，失败则手造 `{ id: randomUUID(), role: 'user', ... }`，
  这样用 `file:` 依赖装进 profile 时不会因解析不到裸包名而加载失败。

