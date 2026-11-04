// @dawn/dsh-auto-evolve 测试:最小假 ctx + 假 agent,验证插件契约(§1 队列 JSON / §2 行为)。
//
// 运行: node test/mock-ctx.mjs        (node:test,全绿 = exit 0)
//
// 安全约定:所有用例的 evolutionDir 都指向 os.tmpdir() 下的临时目录,
// 绝不写真实 C:/Users/DawnCloud/.dsh/evolution(测试结束统一清理)。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

/** 本轮创建的临时根目录,测试结束全删。 */
const ROOTS = []
after(() => {
  for (const root of ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
})

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-auto-evolve-'))
  ROOTS.push(root)
  return root
}

/** 最小假 cordis ctx:on / logger / effect / emit,不依赖真实宿主。 */
function makeMockCtx() {
  const handlers = new Map()
  const warns = []
  return {
    warns,
    logger: {
      warn: (message) => warns.push(String(message)),
      info: () => {},
      debug: () => {},
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    effect(fn) {
      try {
        const dispose = fn()
        assert.equal(typeof dispose, 'function', 'effect 回调应返回清理函数')
      } catch (error) {
        warns.push('effect 注册抛错: ' + error)
      }
    },
    async emit(event, payload, hostCtx, next) {
      // 默认 next:模拟 waterfall 下游的"进入"结果,便于断言处理器是否原样透传。
      // 签名按宿主真实约定区分:system-prompt/assemble 是 (assembly, hostCtx, next),
      // 其余事件(agent/pre-step 等)是 (payload, next)。
      const nextFn = next ?? (async () => ({ kind: 'enter', messages: [] }))
      let result
      for (const handler of handlers.get(event) ?? []) {
        result = event === 'system-prompt/assemble'
          ? await handler(payload, hostCtx, nextFn)
          : await handler(payload, nextFn)
      }
      return result
    },
    handlerCount(event) {
      return (handlers.get(event) ?? []).length
    },
  }
}

// 故意造超长参数/结果,验证 300 / 800 截断。
const LONG_ARGS = '{"path":"' + 'x'.repeat(480) + '"}'
const LONG_RESULT = 'r'.repeat(1000)

/** 假会话消息:含 system / text / reasoning / tool-call / tool-result / 未知扩展块。 */
function sessionMessages() {
  return [
    { id: 'm-sys', role: 'system', content: [{ type: 'text', text: '你是一个 agent' }], source: { kind: 'plugin', plugin: 'system' } },
    { id: 'm-1', role: 'user', content: [{ type: 'text', text: '帮我看看这个 bug' }], source: { kind: 'user' } },
    {
      id: 'm-2',
      role: 'assistant',
      content: [
        { type: 'text', text: '我先读一下文件' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: LONG_ARGS },
        { type: 'reasoning', text: '内部思考,不该进队列' },
      ],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    {
      id: 'm-3',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: LONG_RESULT }], isError: false }],
      source: { kind: 'tool', callId: 'c1' },
    },
    { id: 'm-4', role: 'user', content: [{ type: 'text', text: '再改一下' }, { type: 'bogus-extension', payload: { a: 1 } }], source: { kind: 'user' } },
    { id: 'm-5', role: 'assistant', content: [{ type: 'text', text: '改好了' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
  ]
}

function makeMockAgent(options = {}) {
  const injected = []
  const messages = options.messages === undefined ? sessionMessages() : options.messages
  return {
    injected,
    session: {
      header: {
        id: options.sessionId === undefined ? 'sess-abc/weird' : options.sessionId,
        cwd: options.cwd === undefined ? 'C:/Users/DawnCloud/.dsh/profiles/desktop' : options.cwd,
        // 子代理判定字段:官方 SessionHeader 的 origin / delegationDepth
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
      },
      deriveMessages() {
        if (options.deriveError) throw options.deriveError
        return messages
      },
    },
    inject(message) {
      injected.push(message)
    },
  }
}

/** 假 bg-review.mjs:被 detached 拉起后把自己的 argv 写进同目录 spawned.json。 */
const FAKE_BG_REVIEW = [
  "import { writeFileSync } from 'node:fs'",
  "import { dirname, join } from 'node:path'",
  "import { fileURLToPath } from 'node:url'",
  "const out = join(dirname(fileURLToPath(import.meta.url)), 'spawned.json')",
  "writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }), 'utf8')",
  '',
].join('\n')

function setupQueueEnv(overrides = {}) {
  const root = makeRoot()
  const evolutionDir = path.join(root, 'evolution')
  mkdirSync(evolutionDir, { recursive: true })
  const bgReviewScript = path.join(evolutionDir, 'bg-review.mjs')
  writeFileSync(bgReviewScript, FAKE_BG_REVIEW, 'utf8')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir, nodePath: process.execPath, bgReviewScript, ...overrides })
  const agent = makeMockAgent()
  return {
    root,
    evolutionDir,
    ctx,
    agent,
    queueDir: path.join(evolutionDir, 'review', 'queue'),
    heartbeatFile: path.join(evolutionDir, 'review', 'plugin-heartbeat.json'),
  }
}

async function fireTurn(ctx, agent, turnNo) {
  await ctx.emit('agent/turn-stopping', { agent, turn: turnNo, signal: undefined })
}

/** 触发 waterfall 式 agent/pre-step(第二个参数是 next);返回处理器透传给宿主的结果。 */
async function firePreStep(ctx, agent, next) {
  const nextFn = next ?? (async () => ({ kind: 'enter', messages: [] }))
  return ctx.emit('agent/pre-step', { agent, messages: [], turn: 1, signal: undefined }, undefined, nextFn)
}

/** 触发 system-prompt/assemble waterfall:返回(被插件改过的)assembly 与 next() 的返回值。 */
async function fireAssemble(ctx, agent, next) {
  const assembly = { sections: [], contexts: [] }
  const nextFn = next ?? (async () => assembly)
  const returned = await ctx.emit('system-prompt/assemble', assembly, { agent }, nextFn)
  return { assembly, returned }
}

/** 在临时 evolutionDir 下建一份 status: draft 草稿,返回 evolutionDir。 */
function setupDraftsRoot(fileName) {
  const root = makeRoot()
  const evolutionDir = path.join(root, 'evolution')
  const draftsDir = path.join(evolutionDir, 'drafts')
  mkdirSync(draftsDir, { recursive: true })
  writeFileSync(
    path.join(draftsDir, fileName),
    '---\nname: ' + fileName.replace(/\.md$/, '') + '\ndescription: 待审草稿 ' + fileName + '\nstatus: draft\n---\n',
    'utf8'
  )
  return evolutionDir
}

function queueFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

function readHeartbeat(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await delay(50)
  }
  return existsSync(file)
}

test('a) turn-stopping 第 3 轮命中:队列 JSON 结构 / 截断 / transcript', async () => {
  const env = setupQueueEnv()
  assert.equal(env.ctx.handlerCount('agent/turn-stopping'), 1)
  assert.equal(env.ctx.handlerCount('agent/session-start'), 1)

  await fireTurn(env.ctx, env.agent, 1)
  await fireTurn(env.ctx, env.agent, 2)
  assert.equal(queueFiles(env.queueDir).length, 0, '未到 everyTurns=3 不应写队列')

  await fireTurn(env.ctx, env.agent, 3)
  const files = queueFiles(env.queueDir)
  assert.deepEqual(files, ['sess-abc_weird-3.json'], '文件名为 <sanitize(sessionId)>-<turn>.json')

  const queue = JSON.parse(readFileSync(path.join(env.queueDir, files[0]), 'utf8'))
  assert.equal(queue.schema, 1)
  assert.equal(queue.producer, 'dsh-auto-evolve')
  assert.equal(queue.sessionId, 'sess-abc/weird', 'sessionId 保留原始值')
  assert.equal(queue.turn, 3)
  assert.equal(queue.cwd, 'C:/Users/DawnCloud/.dsh/profiles/desktop')
  assert.ok(!Number.isNaN(Date.parse(queue.createdAt)), 'createdAt 是 ISO 时间')
  assert.equal(queue.messageCount, 5, 'system 消息被过滤')
  assert.equal(queue.messages.length, 5)
  assert.deepEqual(queue.messages.map((message) => message.role), ['user', 'assistant', 'user', 'user', 'assistant'])
  for (const message of queue.messages) {
    assert.ok(Array.isArray(message.parts) && message.parts.length > 0, '每条消息都有 parts')
    for (const part of message.parts) {
      assert.ok(['text', 'tool-call', 'tool-result'].includes(part.kind), 'part.kind 只能是三种之一')
    }
  }
  const assistant = queue.messages[1]
  assert.deepEqual(assistant.parts.map((part) => part.kind), ['text', 'tool-call'], 'reasoning 块被忽略')
  assert.equal(assistant.parts[1].name, 'read')
  assert.equal(assistant.parts[1].args.length, 300, 'tool-call args 截断 300')
  assert.equal(queue.messages[2].parts[0].kind, 'tool-result')
  assert.equal(queue.messages[2].parts[0].text.length, 800, 'tool-result 截断 800')
  assert.equal(queue.messages[3].parts.length, 1, '未知扩展块被忽略')
  assert.ok(!JSON.stringify(queue).includes('内部思考'), 'reasoning 内容不得泄漏进队列')
  assert.ok(!JSON.stringify(queue).includes('bogus-extension'))

  assert.ok(queue.transcript.includes('### turn 3'), 'transcript 带 turn 标题')
  assert.ok(queue.transcript.includes('[user] 帮我看看这个 bug'))
  assert.ok(queue.transcript.includes('[assistant] 我先读一下文件'))
  assert.ok(queue.transcript.includes('[tool-call] read'))
  assert.ok(queue.transcript.includes('[tool-result]'))

  // 拉起 bg-review:argv 必须是 --queue-file <文件> --trigger plugin
  const marker = path.join(env.evolutionDir, 'spawned.json')
  assert.ok(await waitForFile(marker, 5000), '应 detached 拉起 bg-review 子进程')
  const spawned = JSON.parse(readFileSync(marker, 'utf8'))
  // 假脚本记录 process.argv.slice(2),即 node 与脚本路径之后的全部参数
  assert.deepEqual(spawned.argv, [
    '--queue-file',
    path.join(env.queueDir, 'sess-abc_weird-3.json'),
    '--trigger',
    'plugin',
  ])

  // 冷却期内不再触发(everyTurns 命中但 cooldown=30min 挡住)
  await fireTurn(env.ctx, env.agent, 4)
  await fireTurn(env.ctx, env.agent, 5)
  await fireTurn(env.ctx, env.agent, 6)
  assert.equal(queueFiles(env.queueDir).length, 1, 'cooldown 内不得再写队列')
})

test('b) 心跳文件:apply 即写,turnsSeen 递增,字段齐全', async () => {
  const env = setupQueueEnv()
  const initial = readHeartbeat(env.heartbeatFile)
  assert.equal(initial.plugin, '@dawn/dsh-auto-evolve')
  assert.equal(typeof initial.version, 'string')
  assert.equal(typeof initial.pid, 'number')
  assert.ok(!Number.isNaN(Date.parse(initial.startedAt)))
  assert.equal(initial.turnsSeen, 0)
  assert.equal(initial.lastTurnAt, null)
  assert.equal(initial.lastQueueFile, null)
  assert.equal(initial.lastError, null)

  await fireTurn(env.ctx, env.agent, 1)
  const afterOne = readHeartbeat(env.heartbeatFile)
  assert.equal(afterOne.turnsSeen, 1)
  assert.ok(!Number.isNaN(Date.parse(afterOne.lastTurnAt)), 'lastTurnAt 是 ISO 时间')

  await fireTurn(env.ctx, env.agent, 2)
  await fireTurn(env.ctx, env.agent, 3)
  const afterThree = readHeartbeat(env.heartbeatFile)
  assert.equal(afterThree.turnsSeen, 3, 'turnsSeen 随 turn-stopping 递增')
  assert.equal(afterThree.lastQueueFile, path.join(env.queueDir, 'sess-abc_weird-3.json'))

  await fireTurn(env.ctx, env.agent, 4)
  assert.equal(readHeartbeat(env.heartbeatFile).turnsSeen, 4)
})

test('c) system-prompt/assemble:把待审草稿推入运行时上下文(仅 status: draft,最多 5 条)', async () => {
  const root = makeRoot()
  const evolutionDir = path.join(root, 'evolution')
  const draftsDir = path.join(evolutionDir, 'drafts')
  mkdirSync(draftsDir, { recursive: true })
  for (let index = 1; index <= 7; index += 1) {
    writeFileSync(
      path.join(draftsDir, 'draft-' + index + '.md'),
      '---\nname: draft-' + index + '\ndescription: 草稿 ' + index + ' 的说明\nstatus: draft\n---\n\n# 草稿 ' + index + '\n',
      'utf8'
    )
  }
  writeFileSync(path.join(draftsDir, 'active-one.md'), '---\nname: active-one\ndescription: 已转正\nstatus: active\n---\n', 'utf8')
  writeFileSync(path.join(draftsDir, 'no-frontmatter.md'), '# 没有 frontmatter\n', 'utf8')

  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  assert.equal(ctx.handlerCount('system-prompt/assemble'), 1, '应挂 assemble 监听')
  const agent = makeMockAgent()
  const { assembly, returned } = await fireAssemble(ctx, agent)

  assert.equal(returned, assembly, 'assemble 必须原样透传 next() 结果')
  assert.equal(agent.injected.length, 0, '不再伪造用户消息(agent.inject 已弃用)')
  assert.equal(assembly.contexts.length, 1, '应推入一段运行时上下文')
  const section = assembly.contexts[0]
  assert.equal(section.name, 'auto-evolve:draft-notice')
  assert.equal(typeof section.text, 'string')
  const text = section.text
  assert.ok(text.includes('【后台沉淀草稿待审】'))
  assert.ok(text.includes('共 7 条'), '统计全部 draft 数量')
  assert.ok(text.includes('draft-1.md'))
  assert.ok(text.includes('draft-5.md'))
  assert.ok(!text.includes('draft-6.md'), '超过 draftsInjectLimit=5 的不列出')
  assert.ok(!text.includes('active-one.md'), '非 draft 草稿不列出')
  assert.ok(!text.includes('no-frontmatter.md'), '无 frontmatter 文件不列出')
  assert.ok(text.includes('self-evolution'), '提醒里带处理指引')
})

test('c2) context 文本必须打断 {{...}} 插值,否则宿主组装整轮失败', async () => {
  const root = makeRoot()
  const evolutionDir = path.join(root, 'evolution')
  const draftsDir = path.join(evolutionDir, 'drafts')
  mkdirSync(draftsDir, { recursive: true })
  writeFileSync(
    path.join(draftsDir, 'draft-braces.md'),
    '---\nname: draft-braces\ndescription: 带 {{evil}} 插值的草稿\nstatus: draft\n---\n',
    'utf8'
  )
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  const { assembly } = await fireAssemble(ctx, makeMockAgent())
  assert.equal(assembly.contexts.length, 1)
  const text = assembly.contexts[0].text
  assert.ok(!text.includes('{{'), '裸 {{ 必须被打断: ' + text)
  assert.ok(text.includes('\u200B'), '用零宽字符打断模板语法')
})

test('d) deriveMessages 抛错 / 缺失时不崩,心跳记 lastError', async () => {
  // d-1:deriveMessages 抛错
  const root = makeRoot()
  const evolutionDir = path.join(root, 'evolution')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  const broken = makeMockAgent({ deriveError: new Error('derive boom') })
  for (const turnNo of [1, 2, 3]) await fireTurn(ctx, broken, turnNo)
  const heartbeat = readHeartbeat(path.join(evolutionDir, 'review', 'plugin-heartbeat.json'))
  assert.equal(heartbeat.turnsSeen, 3, '失败也要正常计数')
  assert.ok(String(heartbeat.lastError).includes('derive boom'), 'lastError 记录异常')
  assert.ok(ctx.warns.length > 0, '异常应走 logger.warn')
  assert.equal(queueFiles(path.join(evolutionDir, 'review', 'queue')).length, 0, '取消息失败不得写队列')

  // d-2:agent.session 存在但没有 deriveMessages(老版本/降级场景)
  const evolutionDir2 = path.join(makeRoot(), 'evolution')
  const ctx2 = makeMockCtx()
  plugin.apply(ctx2, { evolutionDir: evolutionDir2 })
  const legacy = makeMockAgent()
  legacy.session = { header: { id: 'legacy-session', cwd: 'C:/tmp' } }
  for (const turnNo of [1, 2, 3]) await fireTurn(ctx2, legacy, turnNo)
  const heartbeat2 = readHeartbeat(path.join(evolutionDir2, 'review', 'plugin-heartbeat.json'))
  assert.ok(String(heartbeat2.lastError).includes('deriveMessages'), '缺失 deriveMessages 也要记 lastError')
  assert.equal(queueFiles(path.join(evolutionDir2, 'review', 'queue')).length, 0)

  // d-3:连 agent 都没有(事件载荷异常)
  const evolutionDir3 = path.join(makeRoot(), 'evolution')
  const ctx3 = makeMockCtx()
  plugin.apply(ctx3, { evolutionDir: evolutionDir3 })
  for (const turnNo of [1, 2, 3]) await fireTurn(ctx3, undefined, turnNo)
  const heartbeat3 = readHeartbeat(path.join(evolutionDir3, 'review', 'plugin-heartbeat.json'))
  assert.ok(String(heartbeat3.lastError).includes('agent.session'), '空 agent 也只记 lastError,不抛')
})

test('e) 队列写失败(非法 evolutionDir)不抛,只 warn', async () => {
  // e-1:evolutionDir 的父路径是普通文件 → mkdir ENOTDIR
  const root = makeRoot()
  const blocker = path.join(root, 'blocker.txt')
  writeFileSync(blocker, 'not a directory', 'utf8')
  const badEvolutionDir = path.join(blocker, 'evolution')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir: badEvolutionDir })
  const agent = makeMockAgent()
  for (const turnNo of [1, 2, 3]) await fireTurn(ctx, agent, turnNo) // 不应抛出
  assert.ok(ctx.warns.length > 0, '写失败必须留下 warn')
  assert.ok(
    ctx.warns.some((warning) => warning.includes('ENOTDIR') || warning.includes('写心跳失败') || warning.includes('turn-stopping')),
    'warn 应指向真实的 IO 失败: ' + ctx.warns.join(' | ')
  )

  // e-2:不存在的盘符(契约要求的场景)
  const ctx2 = makeMockCtx()
  plugin.apply(ctx2, { evolutionDir: 'Q:/dsh-auto-evolve-no-such-drive/evolution' })
  const agent2 = makeMockAgent()
  for (const turnNo of [1, 2, 3]) await fireTurn(ctx2, agent2, turnNo) // 不抛即通过
})

test('f) enabled=false 时只写心跳,不写队列、不拉子进程', async () => {
  const env = setupQueueEnv({ enabled: false })
  for (const turnNo of [1, 2, 3, 4]) await fireTurn(env.ctx, env.agent, turnNo)
  assert.equal(queueFiles(env.queueDir).length, 0)
  assert.equal(existsSync(path.join(env.evolutionDir, 'spawned.json')), false)
  const heartbeat = readHeartbeat(env.heartbeatFile)
  assert.equal(heartbeat.turnsSeen, 4, '关掉后仍统计 turn 并写心跳')
  assert.equal(heartbeat.lastQueueFile, null)
})

test('g) 日上限 dailyCap 生效', async () => {
  const env = setupQueueEnv({ everyTurns: 1, cooldownMinutes: 0, dailyCap: 2 })
  for (const turnNo of [1, 2, 3, 4]) await fireTurn(env.ctx, env.agent, turnNo)
  const files = queueFiles(env.queueDir)
  assert.equal(files.length, 2, 'dailyCap=2 只允许两次,实际: ' + files.join(','))
  assert.deepEqual(files, ['sess-abc_weird-1.json', 'sess-abc_weird-2.json'])
  assert.equal(readHeartbeat(env.heartbeatFile).turnsSeen, 4)
})

test('h) 子代理会话 turn-stopping:不写队列、turnsSeen 不涨', async () => {
  // everyTurns=1 + cooldown=0:主会话每轮都会触发,便于对照
  const env = setupQueueEnv({ everyTurns: 1, cooldownMinutes: 0 })

  const byOrigin = makeMockAgent({ sessionId: 'sub-origin', origin: 'subagent' })
  for (const turnNo of [1, 2, 3]) await fireTurn(env.ctx, byOrigin, turnNo)
  assert.equal(queueFiles(env.queueDir).length, 0, 'origin=subagent 不得写队列')
  assert.equal(readHeartbeat(env.heartbeatFile).turnsSeen, 0, 'origin=subagent 不得累加 turnsSeen')

  const byDepth = makeMockAgent({ sessionId: 'sub-depth', delegationDepth: 2 })
  for (const turnNo of [1, 2, 3]) await fireTurn(env.ctx, byDepth, turnNo)
  assert.equal(queueFiles(env.queueDir).length, 0, 'delegationDepth>0 不得写队列')
  assert.equal(readHeartbeat(env.heartbeatFile).turnsSeen, 0, 'delegationDepth>0 不得累加 turnsSeen')

  // 对照组:同一 ctx 下的主会话必须照常工作
  const main = makeMockAgent({ sessionId: 'main-1' })
  await fireTurn(env.ctx, main, 1)
  assert.equal(readHeartbeat(env.heartbeatFile).turnsSeen, 1, '主会话正常计数')
  assert.deepEqual(queueFiles(env.queueDir), ['main-1-1.json'], '主会话正常排 review')
})

test('i) 子代理会话:不推草稿提醒', async () => {
  const evolutionDir = setupDraftsRoot('draft-x.md')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  const heartbeatFile = path.join(evolutionDir, 'review', 'plugin-heartbeat.json')

  const byOrigin = makeMockAgent({ sessionId: 'sub-origin', origin: 'subagent' })
  assert.equal((await fireAssemble(ctx, byOrigin)).assembly.contexts.length, 0, 'origin=subagent 不得推送')

  const byDepth = makeMockAgent({ sessionId: 'sub-depth', delegationDepth: 1 })
  assert.equal((await fireAssemble(ctx, byDepth)).assembly.contexts.length, 0, 'delegationDepth>0 不得推送')

  // 对照组:主会话必须拿到同一份草稿
  const main = makeMockAgent({ sessionId: 'main-2' })
  const { assembly } = await fireAssemble(ctx, main)
  assert.equal(assembly.contexts.length, 1, '主会话照常推送')
  assert.ok(assembly.contexts[0].text.includes('draft-x.md'), '推送文本含草稿文件名')
  assert.equal(readHeartbeat(heartbeatFile).noticePushes, 1, '只有主会话计数')
})

test('j) 每步 assemble 都 push,且内容稳定(宿主靠快照文本去重)', async () => {
  const evolutionDir = setupDraftsRoot('draft-j.md')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  assert.equal(ctx.handlerCount('agent/pre-step'), 1, 'pre-step 观测监听应已注册')
  const agent = makeMockAgent({ sessionId: 'sess-j' })
  const heartbeatFile = path.join(evolutionDir, 'review', 'plugin-heartbeat.json')

  const first = await fireAssemble(ctx, agent)
  const second = await fireAssemble(ctx, agent)
  assert.equal(first.assembly.contexts.length, 1, '第一步 push')
  assert.equal(second.assembly.contexts.length, 1, '第二步也要 push(跳过反而多落一份快照)')
  assert.equal(first.assembly.contexts[0].text, second.assembly.contexts[0].text, '内容必须逐字节稳定')

  let heartbeat = readHeartbeat(heartbeatFile)
  assert.equal(heartbeat.noticePushes, 2)
  assert.equal(heartbeat.lastNoticeTrigger, 'system-prompt')

  const nextResult = { kind: 'enter', messages: [] }
  assert.equal(await firePreStep(ctx, agent, async () => nextResult), nextResult, 'pre-step 原样透传')
  await fireAssemble(ctx, agent) // 真实顺序:pre-step 之后才组装 prompt(心跳由 assemble 落盘)
  heartbeat = readHeartbeat(heartbeatFile)
  assert.equal(heartbeat.preStepChecks, 1, 'pre-step 到达留痕')
  assert.equal(heartbeat.noticePushes, 3)
})

test('k) 草稿区为空:不推上下文、心跳不涨、next 结果原样透传', async () => {
  const root = makeRoot()
  const evolutionDir = path.join(root, 'evolution')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  const heartbeatFile = path.join(evolutionDir, 'review', 'plugin-heartbeat.json')
  const agent = makeMockAgent({ sessionId: 'sess-k' })
  const nextResult = { kind: 'enter', messages: ['原样透传'] }
  const res = await fireAssemble(ctx, agent, async () => nextResult)

  assert.equal(res.returned, nextResult, 'assemble 返回值必须是 next() 的结果')
  assert.equal(res.assembly.contexts.length, 0, '没有草稿就不推')
  const heartbeat = readHeartbeat(heartbeatFile)
  assert.equal(heartbeat.noticePushes, 0)
  assert.equal(heartbeat.lastNoticeAt, null)
  assert.equal(heartbeat.lastNoticeTrigger, null)
})

test('l) 子代理 pre-step/assemble:零副作用、返回值透传', async () => {
  const evolutionDir = setupDraftsRoot('draft-l.md')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  const heartbeatFile = path.join(evolutionDir, 'review', 'plugin-heartbeat.json')
  const before = readHeartbeat(heartbeatFile)
  const nextResult = { kind: 'enter', messages: [] }
  const next = async () => nextResult

  const byOrigin = makeMockAgent({ sessionId: 'sub-pre-origin', origin: 'subagent' })
  assert.equal(await firePreStep(ctx, byOrigin, next), nextResult, 'pre-step 原样透传')
  assert.equal((await fireAssemble(ctx, byOrigin)).assembly.contexts.length, 0, 'origin=subagent 不推送')

  const byDepth = makeMockAgent({ sessionId: 'sub-pre-depth', delegationDepth: 2 })
  assert.equal(await firePreStep(ctx, byDepth, next), nextResult, 'pre-step 原样透传')
  assert.equal((await fireAssemble(ctx, byDepth)).assembly.contexts.length, 0, 'delegationDepth>0 不推送')

  const after = readHeartbeat(heartbeatFile)
  assert.equal(after.noticePushes, 0, '子代理不产生提醒计数')
  assert.equal(after.preStepChecks, before.preStepChecks, '子代理不消耗 preStepChecks')
  assert.equal(after.lastNoticeAt, before.lastNoticeAt)
  assert.equal(after.lastSessionStartAt, before.lastSessionStartAt)
})

test('m) 心跳含观测字段且随事件刷新', async () => {
  const evolutionDir = setupDraftsRoot('draft-m.md')
  const ctx = makeMockCtx()
  plugin.apply(ctx, { evolutionDir })
  const heartbeatFile = path.join(evolutionDir, 'review', 'plugin-heartbeat.json')

  let heartbeat = readHeartbeat(heartbeatFile)
  for (const field of ['lastSessionStartAt', 'lastSessionStartSource', 'noticePushes', 'lastNoticeAt', 'lastNoticeTrigger', 'preStepChecks']) {
    assert.ok(Object.prototype.hasOwnProperty.call(heartbeat, field), '心跳缺字段 ' + field)
  }
  assert.equal(heartbeat.lastSessionStartAt, null)
  assert.equal(heartbeat.lastSessionStartSource, null)
  assert.equal(heartbeat.noticePushes, 0)
  assert.equal(heartbeat.lastNoticeAt, null)
  assert.equal(heartbeat.lastNoticeTrigger, null)
  assert.equal(heartbeat.preStepChecks, 0)

  const agent = makeMockAgent({ sessionId: 'sess-m' })
  await ctx.emit('agent/session-start', { agent, source: 'resume' })
  heartbeat = readHeartbeat(heartbeatFile)
  assert.ok(!Number.isNaN(Date.parse(heartbeat.lastSessionStartAt)), 'lastSessionStartAt 是 ISO 时间')
  assert.equal(heartbeat.lastSessionStartSource, 'resume', '记录 source(重启恢复场景应是 resume)')
  assert.equal(heartbeat.noticePushes, 0, 'session-start 不再注入')
  const firstStartAt = heartbeat.lastSessionStartAt

  await fireAssemble(ctx, agent)
  heartbeat = readHeartbeat(heartbeatFile)
  assert.equal(heartbeat.noticePushes, 1, 'assemble 推入后计数')
  assert.ok(!Number.isNaN(Date.parse(heartbeat.lastNoticeAt)))
  assert.equal(heartbeat.lastNoticeTrigger, 'system-prompt')

  const secondAgent = makeMockAgent({ sessionId: 'sess-m2' })
  await ctx.emit('agent/session-start', { agent: secondAgent, source: 'start' })
  heartbeat = readHeartbeat(heartbeatFile)
  assert.equal(heartbeat.lastSessionStartSource, 'start')
  assert.ok(heartbeat.lastSessionStartAt >= firstStartAt, 'lastSessionStartAt 随事件刷新')
})

test('n) 插件自己注入的消息不进 review 队列(source.kind 以 plugin: 开头)', async () => {
  const env = setupQueueEnv()
  const agent = makeMockAgent({
    sessionId: 'sess-plugin-src',
    messages: [
      { id: 'u-1', role: 'user', content: [{ type: 'text', text: '真用户说的话' }], source: { kind: 'user' } },
      {
        id: 'p-1',
        role: 'user',
        content: [{ type: 'text', text: '【后台沉淀草稿待审】共 2 条：drafts/a.md' }],
        source: { kind: 'plugin:auto-evolve' },
      },
      {
        id: 'rc-1',
        role: 'user',
        content: [{ type: 'text', text: '<runtime-context>草稿待审清单也在这里</runtime-context>' }],
        source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
      },
      {
        id: 'ai-1',
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>AGENTS.md 全文</system-reminder>' }],
        source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
      },
      {
        id: 'a-1',
        role: 'assistant',
        content: [{ type: 'text', text: '好的' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    ],
  })

  await fireTurn(env.ctx, agent, 1)
  await fireTurn(env.ctx, agent, 2)
  await fireTurn(env.ctx, agent, 3)

  const files = queueFiles(env.queueDir)
  assert.equal(files.length, 1, '第 3 轮应写出 1 个队列文件')
  const queue = JSON.parse(readFileSync(path.join(env.queueDir, files[0]), 'utf8'))
  assert.equal(queue.messageCount, 2, '注入消息被过滤,只剩 user + assistant')
  assert.ok(!JSON.stringify(queue).includes('后台沉淀草稿待审'), '插件自己的提醒不得进 review 语料')
  assert.ok(!JSON.stringify(queue).includes('runtime-context'), '运行时上下文快照不得进 review 语料')
  assert.ok(!JSON.stringify(queue).includes('AGENTS.md'), '指令注入不得进 review 语料')
  assert.ok(queue.transcript.includes('真用户说的话'), '真实用户消息保留')
  assert.ok(queue.transcript.includes('[assistant] 好的'))
})
