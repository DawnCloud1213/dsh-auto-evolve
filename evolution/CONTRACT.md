# 插件 ↔ bg-review 契约（唯一事实源）

> 版本 1 · 2026-10-28。插件（`lib/index.js`）与审查器（`evolution/bg-review.mjs`）都按此实现。

## 0. 目录布局

| 路径 | 说明 |
|:--|:--|
| 仓库根目录 | 插件包源码（`package.json` / `cordis.patch.yml` / `lib/` / `test/`） |
| `evolution/` | 审查器源码：`bg-review.mjs`、`lib/`；**随包分发**，插件自动定位 `<pkg>/evolution/bg-review.mjs`（显式 `bgReviewScript` 优先，包里找不到才回退 `<evolutionDir>/bg-review.mjs`），无需手动复制 |
| `<evolutionDir>` | 运行期数据目录，默认 `~/.dsh/evolution`；`review/`、`drafts/`、`ledger.jsonl` 都在它下面 |

Node：优先环境变量 `DSH_NODE_PATH`，否则用 PATH 里的 `node`。
凭证文件：`~/.dsh/.credentials.yaml`（正则提取 `DEEPSEEK_API_KEY`，**不读环境变量、不硬编码密钥**）。

## 1. 队列文件（插件写 → bg-review 读）

目录：`<evolutionDir>/review/queue/`，文件名 `<sanitize(sessionId)>-<turn>.json`。
内容必须**无损 JSON**：

```json
{
  "schema": 1,
  "producer": "dsh-auto-evolve",
  "sessionId": "原始 session id",
  "turn": 12,
  "cwd": "<会话工作目录>",
  "createdAt": "2026-10-28T17:00:00.000Z",
  "messageCount": 42,
  "messages": [
    { "role": "user", "parts": [{ "kind": "text", "text": "..." }] },
    { "role": "assistant", "parts": [
        { "kind": "text", "text": "..." },
        { "kind": "tool-call", "name": "pwsh", "args": "{...截断 300 字}" }
    ] },
    { "role": "user", "parts": [{ "kind": "tool-result", "text": "...截断 800 字" }] }
  ],
  "transcript": "### turn 11\n[user] ...\n[assistant] ...\n"
}
```

规则：
- `messages` 由插件从 `agent.session.deriveMessages()` **防御性归一化**产出：只保留 role=user/assistant；content blocks 里 `text` → kind=text，`tool-call` → kind=tool-call（name + args 字符串截断 300），`tool-result`（role=user 的 tool 结果块）→ kind=tool-result（截断 800）；无法识别的块忽略。整体最多 `maxMessages` 条消息、总字符 ≤ 60000（超了从头丢）。
- `transcript` 是插件端渲染好的纯文本，格式 `[role] text`，供 bg-review 直接用。
- **bg-review 优先用 transcript**（非空 string 且 ≥ 200 字符），否则自己从 messages 渲染；两者都空则记 last-result 并退出 0。
- bg-review 处理完（成功或失败）**删除该队列文件**；处理不了可留但必须写 last-result。
- 同一 (sessionId, turn) 只处理一次（`review/state.json` 记 reviewed 键）。

## 2. 插件行为契约

- 包名 `@dawn/dsh-auto-evolve`，入口 `lib/index.js`，纯 ESM，**export { name, inject, apply }**（不导出 Config，参考 `@dawn/dsh-git-graphic`）。
- 挂 `agent/turn-stopping`：按累计工具调用数节流（`nudgeInterval=10` + cooldown 30min + 日上限 12），命中则：
  1) `agent.session.deriveMessages()` → 归一化 → 写队列文件；
  2) `spawn(nodePath, [bgReviewScript, "--queue-file", file, "--trigger", "plugin"], {detached:true, stdio:"ignore", windowsHide:true})` + `unref()`，绝不阻塞/抛错。
- 挂 `system-prompt/assemble`：扫 `drafts/*.md`（frontmatter 有 `status: draft`），把「后台沉淀草稿待审」清单 push 进 `assembly.contexts` 作为运行时上下文快照（不伪造 user 消息）。
- 心跳：每次 apply / turn-stopping 写 `<evolutionDir>/review/plugin-heartbeat.json`：
  `{plugin:"@dawn/dsh-auto-evolve",version,pid,startedAt,lastTurnAt,turnsSeen,itersSinceReview,lastQueueFile,lastError,...}`。这是重启后验证加载的依据。
- 子代理/委派会话完全静默（不计数、不注入、不审查）。
- 所有回调 try/catch，失败只 `ctx.logger.warn`；禁止同步抛错。
- 配置通过 apply 的 config 参数读取，缺失用默认值（不依赖 schema 校验）。

## 3. bg-review.mjs 契约

命令行：
- `--queue-file <path>`（主路径；插件调用，跳过 M1 频率闸门，只做幂等 + 最小内容门槛）
- `--session-id <id> [--force] [--dry-run]`（手动/兼容路径：从 `~/.dsh/sessions/*/<id>/session.v4.jsonl.zstd` 多帧解压）
- `--trigger plugin|stop|manual`（仅记录到 last-result）

行为：
1. 读入 transcript（见 §1）；
2. 拼审查 prompt（严格 JSON 输出）；
3. 调 `https://api.deepseek.com/chat/completions`，model `deepseek-chat`，key 从 `~/.dsh/.credentials.yaml` 取 `DEEPSEEK_API_KEY`；temperature 0.2、max_tokens 3000、`response_format: json_object`，时间戳记 tokens；
4. 决策 none / draft（confidence ≥ 0.6）→ 写 `drafts/<slug>.md`（frontmatter 带 `status: draft`、confidence、evidence）+ `ledger.jsonl` 一行；
5. 永远写 `review/last-result.json`：`{at, trigger, sessionId, turn, decision, skill?, reason, tokens, model, error?, queueFile?}`；
6. 异常/超时全部吞掉，**进程退出码恒 0**；日志追加 `review/bg-review.log`；
7. 支持 `--dry-run`：打印决策不落盘。

复用：`lib/llm.mjs`（凭证 + chat + 重试 + 超时）、`lib/session.mjs`（多帧 zstd + 事件→transcript）、`lib/ledger.mjs`（append + sha256）、`lib/prompt.mjs`（prompt 模板）、`lib/skills-index.mjs`（技能索引与安全改写）、`lib/skill-usage.mjs`（使用遥测）、`lib/curator.mjs`（陈旧技能治理）。

## 4. 验证

- 插件：`node test/mock-ctx.mjs`（假 ctx/假 agent 触发 turn-stopping + assemble，断言队列结构、心跳、提醒文本、缺 deriveMessages 时不炸）、`import-smoke.mjs`、`dashboard-smoke.mjs`。
- 审查器：`node --check evolution/bg-review.mjs`；手造 queue 文件跑 `--queue-file`，断言 drafts / last-result / ledger 产出；重复跑确认幂等跳过；空 transcript 断言静默退出 0。
