// @dawn/dsh-auto-evolve — DSH 自进化宿主插件（M3-a-1 / M3-a-2 / M3-a-4）
//
// 契约来源: C:/Users/DawnCloud/.dsh/evolution/M3-PLUGIN-CONTRACT.md §1 §2
//
// 职责:
//   1) agent/turn-stopping —— 进程内按 turn 计数节流(everyTurns + cooldown + 日上限),
//      命中后 agent.session.deriveMessages() → 防御性归一化 → 写
//      <evolutionDir>/review/queue/<safeSessionId>-<turn>.json(先 .tmp 再 rename),
//      然后 detached spawn node bg-review.mjs --queue-file <file> --trigger plugin,
//      stdio:'ignore' + unref(),立刻返回,绝不阻塞会话。
//   2) agent/session-start —— 读 <evolutionDir>/drafts/*.md 里 frontmatter 带
//      status: draft 的草稿(最多 draftsInjectLimit 条),agent.inject 一段待审清单。
//   3) 心跳 —— apply 时与每次 turn-stopping 后写 <evolutionDir>/review/plugin-heartbeat.json,
//      作为"插件是否真的被加载"的证据。
//
// 约束:
//   - 纯 ESM,不静态 import 任何外部包(避免 pnpm file: 依赖解析问题)。只 import node: 内置模块。
//   - 不导出 Config(参考 @dawn/dsh-git-graphic): 配置用 apply(ctx, config) 手写默认值合并。
//   - 所有回调 try/catch,异常只 ctx.logger.warn + 心跳记 lastError,绝不抛出。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** cordis 插件标识(挂在 agent/turn-stopping 上的名字)。 */
const name = 'auto-evolve'
/** 不依赖任何服务;只用 ctx.logger 与事件。 */
const inject = []

const PLUGIN_ID = '@dawn/dsh-auto-evolve'
const SCHEMA_VERSION = 1

/** 单块截断上限(契约 §1)。 */
const MAX_TOOL_CALL_ARGS = 300
const MAX_TOOL_RESULT_CHARS = 800
/** 整份 transcript / 消息整体的字符预算(契约 §1)。 */
const MAX_TOTAL_CHARS = 60000
/** 嵌套块(如 tool-result.content)递归上限,防畸形数据爆栈。 */
const MAX_BLOCK_DEPTH = 4
/** 草稿 description 在注入文本里的截断长度。 */
const MAX_DRAFT_DESCRIPTION = 160
/** sessionId 进文件名前的最大长度。 */
const MAX_SEGMENT = 120

const DEFAULTS = {
  enabled: true,
  /** 累计多少次工具调用触发一次审查（对齐 Hermes 的 _skill_nudge_interval=10）。 */
  nudgeInterval: 10,
  /** 兼容旧配置：按 turn 计数（已废弃，仅保留字段避免老配置报错）。 */
  everyTurns: 3,
  cooldownMinutes: 30,
  dailyCap: 12,
  maxMessages: 120,
  evolutionDir: 'C:/Users/DawnCloud/.dsh/evolution',
  nodePath: 'C:/Program Files/nodejs/node.exe',
  /** 空 = 默认 <evolutionDir>/bg-review.mjs */
  bgReviewScript: '',
  draftsInjectLimit: 5,
}

/** 读自身 package.json 的 version(失败退回常量),供心跳使用。 */
let VERSION = '0.1.0'
try {
  const pkgFile = fileURLToPath(new URL('../package.json', import.meta.url))
  const parsed = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (typeof parsed?.version === 'string' && parsed.version) VERSION = parsed.version
} catch {
  /* 打包/裁剪场景读不到 package.json 不影响功能 */
}

// ---------------------------------------------------------------------------
// 纯工具函数
// ---------------------------------------------------------------------------

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > limit ? text.slice(0, limit) : text
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

/** 文件名安全化:保留 [A-Za-z0-9._-],其余折成 '_';防路径穿越与超长名字。 */
function sanitizeSegment(value) {
  const text = truncate(String(value ?? ''), MAX_SEGMENT)
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return safe || 'session'
}

/** 本地日期 YYYY-MM-DD(日上限按本地日切)。 */
function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function positiveInt(value, fallback, min = 1) {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num < min) return fallback
  return Math.floor(num)
}

/** 手写默认值合并:不依赖 schemastery Config 校验(Config 导出是可选的)。 */
function resolveConfig(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const evolutionDir = firstString(src.evolutionDir) || DEFAULTS.evolutionDir
  const cooldown = src.cooldownMinutes === undefined ? DEFAULTS.cooldownMinutes : Number(src.cooldownMinutes)
  return {
    enabled: src.enabled === undefined ? DEFAULTS.enabled : Boolean(src.enabled),
    nudgeInterval: positiveInt(src.nudgeInterval, DEFAULTS.nudgeInterval),
    everyTurns: positiveInt(src.everyTurns, DEFAULTS.everyTurns),
    cooldownMinutes: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULTS.cooldownMinutes,
    dailyCap: positiveInt(src.dailyCap, DEFAULTS.dailyCap),
    maxMessages: positiveInt(src.maxMessages, DEFAULTS.maxMessages),
    evolutionDir,
    nodePath: firstString(src.nodePath) || DEFAULTS.nodePath,
    bgReviewScript: firstString(src.bgReviewScript) || path.join(evolutionDir, 'bg-review.mjs'),
    draftsInjectLimit: positiveInt(src.draftsInjectLimit, DEFAULTS.draftsInjectLimit),
  }
}

function safeStringify(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return ''
  }
}

/** 把 tool-result 的嵌套 content 拍平成文本(只取 text,未知块忽略)。 */
function flattenResultText(blocks, depth) {
  if (!Array.isArray(blocks) || depth > MAX_BLOCK_DEPTH) return ''
  const chunks = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text) chunks.push(block.text)
    else if (block.type === 'tool-result') {
      const nested = flattenResultText(block.content, depth + 1)
      if (nested) chunks.push(nested)
    }
  }
  return chunks.join('\n')
}

/**
 * 内容块归一化(契约 §1):text → kind=text;tool-call → kind=tool-call(name + args 截断 300);
 * tool-result → kind=tool-result(拍平后截断 800);reasoning/image/file/未知类型一律忽略。
 */
function normalizeBlocks(blocks, depth = 0) {
  const parts = []
  if (!Array.isArray(blocks) || depth > MAX_BLOCK_DEPTH) return parts
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text) parts.push({ kind: 'text', text })
        break
      }
      case 'tool-call': {
        const callName = typeof block.name === 'string' ? block.name : ''
        const args = truncate(safeStringify(block.arguments), MAX_TOOL_CALL_ARGS)
        parts.push({ kind: 'tool-call', name: callName, args })
        break
      }
      case 'tool-result': {
        const text = truncate(flattenResultText(block.content, depth + 1), MAX_TOOL_RESULT_CHARS)
        if (text) parts.push({ kind: 'tool-result', text })
        break
      }
      default:
        // reasoning / image / file / 未知扩展块:忽略
        break
    }
  }
  return parts
}

function partChars(part) {
  if (part.kind === 'text') return part.text.length
  if (part.kind === 'tool-result') return part.text.length
  if (part.kind === 'tool-call') return part.name.length + 8 + part.args.length
  return 0
}

function messagesChars(messages) {
  let total = 0
  for (const message of messages) {
    for (const part of message.parts) total += partChars(part)
  }
  return total
}

/**
 * 消息归一化:只留 role=user/assistant,空消息丢弃;最多 maxMessages 条、总字符 ≤ 60000
 * (超预算从头丢,保留最近上下文)。
 */
function normalizeMessages(rawMessages, maxMessages) {
  const collected = []
  if (!Array.isArray(rawMessages)) return collected
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.role !== 'user' && raw.role !== 'assistant') continue
    // 只留"人说的话":宿主/插件注入的上下文一律不算用户原话,否则 review 会拿自己写的提醒来审
    const rawSourceKind = raw.source && typeof raw.source.kind === 'string' ? raw.source.kind : ''
    if (rawSourceKind.startsWith('plugin:')) continue
    if (rawSourceKind === 'runtime-context' || rawSourceKind === 'agent-instructions') continue
    if (rawSourceKind === 'skill-catalog' || rawSourceKind === 'time-context') continue
    const parts = normalizeBlocks(raw.content)
    if (parts.length === 0) continue
    collected.push({ role: raw.role, parts })
  }
  const kept = collected.length > maxMessages ? collected.slice(-maxMessages) : collected.slice()
  let total = messagesChars(kept)
  while (kept.length > 0 && total > MAX_TOTAL_CHARS) {
    const dropped = kept.shift()
    total -= messagesChars([dropped])
  }
  return kept
}

/** 渲染成 bg-review 可直接吃的纯文本 transcript(契约 §1 格式)。 */
function renderTranscript(messages, turn) {
  const lines = ['### turn ' + turn]
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === 'tool-call') lines.push('[tool-call] ' + part.name + ' ' + part.args)
      else if (part.kind === 'tool-result') lines.push('[tool-result] ' + part.text)
      else lines.push('[' + message.role + '] ' + part.text)
    }
  }
  return lines.join('\n') + '\n'
}

/** 数一份消息数组里累计的 tool-call 块（Hermes 用 _iters_since_skill 计迭代，这里用同一口径）。 */
function countToolCalls(messages) {
  let n = 0
  if (!Array.isArray(messages)) return n
  for (const msg of messages) {
    const content = msg && msg.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool-call') n += 1
    }
  }
  return n
}

/** 原子写 JSON:先写同目录 .tmp,再 rename 覆盖(Windows 上 rename 会替换已存在文件)。 */
function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid + '-' + randomUUID().slice(0, 8)
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 清理失败不影响主流程 */
    }
    throw error
  }
}

/** 取 frontmatter(首个 --- 块)。 */
function matchFrontmatter(text) {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  return matched ? matched[1] : null
}

/**
 * 是否是子代理/委派会话(SessionHeader.origin === 'subagent' 或 delegationDepth > 0)。
 * 子代理会话要完全静默:
 *   - 每起一个子代理都会触发 session-start,注入草稿清单纯属噪音 + 白烧 token;
 *   - 子代理的 turn 若算进 turnsSeen,会把"每 N 轮"的节奏随委派次数放大,并对同一份历史重复发起 review。
 * 读不到 header(或字段缺失)一律 false:宁可照常触发,也不静默失效。
 */
function isSubagentSession(agent) {
  const header = agent?.session?.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

// ---------------------------------------------------------------------------
// 草稿提醒:用「运行时上下文快照」投递,不再伪造用户消息
// ---------------------------------------------------------------------------
//
// 历史教训(v0.1.0~0.1.3):
//   ① 用 agent.inject 造 role:'user' 消息时,source.kind 写成 v3 老包装 {kind:'plugin'} 会被
//      会话格式 v4 拒绝(SessionFormatError),并在落盘阶段废掉整轮 → IM 渠道表现为「失联」;
//   ② 就算 kind 修对,它依然是「用户说的话」:模型当新请求去做长任务,review 导出也可能把它
//      当成用户原话(自己审自己)。
// 现在的做法(参照 @furongjun1999/dsh-memory 的 auto-recall):挂 system-prompt/assemble
// waterfall,往 assembly.contexts 里 push 一段带 name 的文本 → 宿主把它渲染成
// 「运行时上下文快照」,与角色无关、不冒充用户,也不参与「用户是否发过消息」的判定。

/** 断掉 {{...}} 插值:宿主对 context 文本做严格模板插值,裸 {{ 会让整轮请求失败。 */
function escapePromptBraces(text) {
  return String(text).replace(/\{\{/g, '{\u200B{')
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const log = (message) => {
    try {
      ctx?.logger?.warn?.('auto-evolve: ' + message)
    } catch {
      /* logger 不可用也不能抛 */
    }
  }

  // ---- 进程内状态(整个插件生命周期,不落盘;心跳是它的对外投影) ----
  let turnsSeen = 0
  const startedAt = new Date().toISOString()
  let lastTurnAt = null
  /** 距上次审查累计的工具调用数（Hermes 的 _iters_since_skill 等价物）。 */
  let itersSinceReview = 0
  /** 会话累计工具调用数（用来算每轮增量：本轮总数 - 上次总数）。 */
  let itersTotal = 0
  let lastToolCallCount = 0
  /** 已扫描过的消息条数（技能使用遥测只统计本轮新增） */
  let lastScannedMessages = 0
  let lastQueueFile = null
  let lastError = null
  let lastTriggerAt = 0
  let dayKey = localDayKey()
  let dayCount = 0
  const queuedTurns = new Set()

  // ---- 观测状态:心跳是排查"草稿提醒有没有送到"的唯一线索 ----
  let lastSessionStartAt = null
  let lastSessionStartSource = null
  /** 草稿提醒推入运行时上下文快照的次数(每步都会 push,内容不变时宿主不会重复落盘) */
  let noticePushes = 0
  let lastNoticeAt = null
  /** 'system-prompt' | null */
  let lastNoticeTrigger = null
  let preStepChecks = 0

  const reviewDir = path.join(cfg.evolutionDir, 'review')
  const queueDir = path.join(reviewDir, 'queue')
  const draftsDir = path.join(cfg.evolutionDir, 'drafts')
  const heartbeatFile = path.join(reviewDir, 'plugin-heartbeat.json')

  /** 动态加载 evolution/lib/skill-usage.mjs（插件在 node_modules 里，不能静态 import 用户目录）。 */
  let usageModulePromise = null
  function loadUsageModule() {
    if (!usageModulePromise) {
      try {
        const file = path.join(cfg.evolutionDir, 'lib', 'skill-usage.mjs')
        usageModulePromise = import(pathToFileURL(file).href).catch(() => null)
      } catch {
        usageModulePromise = Promise.resolve(null)
      }
    }
    return usageModulePromise
  }

  function recordError(stage, error) {
    const detail = String((error && (error.message || error)) ?? error)
    lastError = stage + ': ' + detail
    log(lastError)
  }

  /** 心跳:重启后验证"插件确实加载、turn 确实在涨、最近一次错误"的唯一依据。 */
  function writeHeartbeat() {
    try {
      writeJsonAtomic(heartbeatFile, {
        plugin: PLUGIN_ID,
        version: VERSION,
        pid: process.pid,
        startedAt,
        lastTurnAt,
        turnsSeen,
        itersSinceReview,
        itersTotal,
        nudgeInterval: cfg.nudgeInterval,
        lastQueueFile,
        lastError,
        // 观测字段:排查"草稿提醒有没有送到"的关键证据
        lastSessionStartAt,
        lastSessionStartSource,
        noticePushes,
        lastNoticeAt,
        lastNoticeTrigger,
        preStepChecks,
      })
    } catch (error) {
      log('写心跳失败: ' + String((error && (error.message || error)) ?? error))
    }
  }

  // 可选清理钩子:本插件没有需要释放的资源,但保留合法的 effect 注册点。
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {}, 'auto-evolve: cleanup')
    } catch (error) {
      recordError('effect 注册失败', error)
    }
  }

  writeHeartbeat()

  // ---------------- 节流 ----------------

  function shouldTrigger() {
    // 对齐 Hermes：累计工具调用数达标才审，不是按对话轮数
    if (itersSinceReview < cfg.nudgeInterval) return false
    const now = Date.now()
    if (lastTriggerAt !== 0 && now - lastTriggerAt < cfg.cooldownMinutes * 60000) return false
    const today = localDayKey()
    if (today !== dayKey) {
      dayKey = today
      dayCount = 0
    }
    return dayCount < cfg.dailyCap
  }

  // ---------------- 会话读取 ----------------

  function readSessionId(agent) {
    return firstString(
      agent?.session?.header?.id,
      agent?.session?.id,
      agent?.id,
      'unknown-session'
    ) || 'unknown-session'
  }

  function readCwd(agent) {
    return firstString(agent?.session?.header?.cwd, agent?.session?.cwd, process.cwd()) || process.cwd()
  }

  function readMessages(agent) {
    const session = agent?.session
    if (!session) throw new Error('agent.session 不可用')
    if (typeof session.deriveMessages !== 'function') throw new Error('agent.session.deriveMessages 不可用')
    const messages = session.deriveMessages()
    if (!Array.isArray(messages)) throw new Error('deriveMessages() 未返回数组')
    return messages
  }

  // ---------------- 拉起 bg-review ----------------

  function spawnReview(queueFile) {
    try {
      const child = spawn(cfg.nodePath, [cfg.bgReviewScript, '--queue-file', queueFile, '--trigger', 'plugin'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      // 异步 ENOENT 等错误必须有监听者,否则会以未捕获的 'error' 事件掀翻主进程。
      child.on('error', (error) => {
        recordError('拉起 bg-review 失败', error)
      })
      child.unref()
    } catch (error) {
      recordError('拉起 bg-review 失败', error)
    }
  }

  // ---------------- 队列文件 ----------------

  async function queueAndSpawn(agent, turn, preloadedMessages) {
    const turnNo = Number.isFinite(Number(turn)) ? Math.trunc(Number(turn)) : 0
    const sessionId = readSessionId(agent)
    const dedupeKey = sessionId + '#' + turnNo
    if (queuedTurns.has(dedupeKey)) return false

    let messages = preloadedMessages
    if (!messages) {
      const rawMessages = readMessages(agent)
      messages = normalizeMessages(rawMessages, cfg.maxMessages)
    }
    if (messages.length === 0) {
      log('本轮没有可导出的 user/assistant 消息,跳过 review')
      return false
    }
    const transcript = renderTranscript(messages, turnNo)
    const queueFile = path.join(queueDir, sanitizeSegment(sessionId) + '-' + turnNo + '.json')

    writeJsonAtomic(queueFile, {
      schema: SCHEMA_VERSION,
      producer: 'dsh-auto-evolve',
      sessionId,
      turn: turnNo,
      cwd: readCwd(agent),
      createdAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
      transcript,
    })

    queuedTurns.add(dedupeKey)
    lastQueueFile = queueFile
    lastTriggerAt = Date.now()
    dayCount += 1
    itersSinceReview = 0
    spawnReview(queueFile)
    return true
  }

  // ---------------- 事件:turn-stopping ----------------

  ctx.on('agent/turn-stopping', async (payload) => {
    const { agent, turn } = payload ?? {}
    // 子代理会话完全静默:不累加 turnsSeen、不写心跳、不排 review(见 isSubagentSession 注释)。
    if (isSubagentSession(agent)) return
    turnsSeen += 1
    lastTurnAt = new Date().toISOString()
    try {
      if (cfg.enabled) {
        // 本轮新增工具调用 = 当前累计数 - 上次累计数（会话裁剪时 delta 记 0，不回退）
        let messages = null
        try {
          const raw = readMessages(agent)
          const callsNow = countToolCalls(raw)
          const delta = Math.max(0, callsNow - lastToolCallCount)
          if (delta > 0) {
            itersSinceReview += delta
            itersTotal += delta
          }
          lastToolCallCount = Math.max(lastToolCallCount, callsNow)
          messages = normalizeMessages(raw, cfg.maxMessages)

          // 技能使用遥测：只扫本轮新增消息，记一次 use_count（对齐 Hermes 的 bump_use）
          try {
            const fresh = raw.length >= lastScannedMessages ? raw.slice(lastScannedMessages) : raw
            lastScannedMessages = raw.length
            if (fresh.length) {
              const usageMod = await loadUsageModule()
              if (usageMod && typeof usageMod.extractSkillCalls === 'function') {
                for (const slug of usageMod.extractSkillCalls(fresh)) {
                  usageMod.bumpUse(cfg.evolutionDir, slug)
                }
              }
            }
          } catch { /* 遥测失败绝不影响主流程 */ }
        } catch (error) {
          recordError('统计工具迭代失败', error)
        }
        if (shouldTrigger()) await queueAndSpawn(agent, turn, messages)
      }
    } catch (error) {
      recordError('turn-stopping 处理失败', error)
    } finally {
      writeHeartbeat()
    }
  })

  // ---------------- 事件:session-start(注入待审草稿) ----------------

  function readDrafts() {
    let entries
    try {
      entries = readdirSync(draftsDir, { withFileTypes: true })
    } catch {
      return [] // 没有 drafts 目录就是没草稿,正常情况
    }
    const drafts = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      try {
        const text = readFileSync(path.join(draftsDir, entry.name), 'utf8').slice(0, 8000)
        const frontmatter = matchFrontmatter(text)
        if (!frontmatter) continue
        if (!/^status:\s*["']?draft["']?\s*$/im.test(frontmatter)) continue
        const description = truncate(
          (frontmatter.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim(),
          MAX_DRAFT_DESCRIPTION
        )
        drafts.push({ file: entry.name, description })
      } catch {
        /* 单份草稿读失败跳过 */
      }
    }
    drafts.sort((a, b) => a.file.localeCompare(b.file))
    return drafts
  }

  /** 草稿待审清单文案:session-start 与 pre-step 兜底共用同一份。 */
  function buildDraftNoticeText(drafts) {
    const listed = drafts.slice(0, cfg.draftsInjectLimit)
    const lines = ['【后台沉淀草稿待审】共 ' + drafts.length + ' 条（' + draftsDir + '）：']
    for (const draft of listed) {
      lines.push('- ' + draft.file + (draft.description ? ': ' + draft.description : '（无 description）'))
    }
    if (drafts.length > listed.length) {
      lines.push('- ……另有 ' + (drafts.length - listed.length) + ' 条未列出，可自行查看目录')
    }
    lines.push('')
    lines.push(
      '处理：逐条读草稿——有价值 → 按 self-evolution 流程转正到 ~/.dsh/skills/<slug>/SKILL.md 并在 ledger.jsonl 记账；' +
        '无价值 → 删除草稿。已经处理过的草稿忽略本条即可。'
    )
    return lines.join('\n')
  }

  // ---------------- 事件:session-start(只留观测,不再注入) ----------------
  ctx.on('agent/session-start', async (payload) => {
    const { agent, source } = payload ?? {}
    if (isSubagentSession(agent)) return
    // 留证据:实测 DSH 重启恢复旧会话时这个事件可能早于插件 apply(监听器错过),心跳是唯一线索。
    lastSessionStartAt = new Date().toISOString()
    lastSessionStartSource = typeof source === 'string' && source ? source : null
    writeHeartbeat()
  })

  // ---------------- 事件:system-prompt/assemble(草稿提醒的唯一投递口) ----------------
  //
  // 宿主每步组装 system prompt 都会走这个 waterfall。把提醒 push 进 assembly.contexts,
  // 宿主会渲染成一段「运行时上下文快照」——不是用户消息,也不冒充用户说话。要点:
  //   · 每步都要 push:内容不变时渲染文本相同,宿主不会重复落盘;跳过反而会多落一份「没有本块」的快照;
  //   · 子代理会话完全跳过(每次起子代理都塞一遍纯属噪音 + 烧 token);
  //   · 任何异常都吞掉并 return next(),绝不能打断模型请求;
  //   · 文本必须打断 {{...}},否则宿主模板插值会直接抛错、整轮失败。
  ctx.on('system-prompt/assemble', async (assembly, hostCtx, next) => {
    try {
      const agent = hostCtx?.agent
      if (!isSubagentSession(agent)) {
        const drafts = readDrafts()
        if (drafts.length > 0 && assembly && Array.isArray(assembly.contexts)) {
          assembly.contexts.push({
            name: 'auto-evolve:draft-notice',
            text: escapePromptBraces(buildDraftNoticeText(drafts)),
          })
          noticePushes += 1
          lastNoticeAt = new Date().toISOString()
          lastNoticeTrigger = 'system-prompt'
        }
      }
    } catch (error) {
      recordError('草稿提醒注入失败', error)
    } finally {
      writeHeartbeat()
    }
    return next()
  })

  // ---------------- 事件:pre-step(仅观测心跳,不改动任何东西) ----------------
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent } = payload ?? {}
    if (isSubagentSession(agent)) return next()
    preStepChecks += 1
    return next()
  })
}

export { name, inject, apply }
