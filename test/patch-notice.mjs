// @dawn/dsh-auto-evolve 后台改写回执:assemble 注入 + 去重(同一条改写只提醒一次)
// 运行: node test/patch-notice.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const root = mkdtempSync(path.join(tmpdir(), 'dsh-patch-notice-'))
try {
  const evolutionDir = path.join(root, 'evolution')
  const reviewDir = path.join(evolutionDir, 'review')
  mkdirSync(reviewDir, { recursive: true })

  const resultFile = path.join(reviewDir, 'last-result.json')
  const seenFile = path.join(reviewDir, 'patch-notice-seen.json')

  /** 装一份最小 ctx,收集 system-prompt/assemble 监听器。 */
  function makeCtx() {
    const handlers = new Map()
    const ctx = {
      logger: { warn: () => {} },
      on(event, fn) {
        handlers.set(event, fn)
        return () => {}
      },
      effect(fn) {
        try { fn() } catch { /* ignore */ }
      },
    }
    return { ctx, handlers }
  }

  /** 跑一次 assemble,返回 push 进 contexts 的条目。 */
  async function assembleOnce(handlers, agent) {
    const handler = handlers.get('system-prompt/assemble')
    assert.ok(handler, '应注册 system-prompt/assemble')
    const assembly = { contexts: [] }
    let nextCalled = 0
    await handler(assembly, { agent }, () => { nextCalled += 1 })
    assert.equal(nextCalled, 1, 'assemble 必须调用 next()')
    return assembly.contexts
  }

  const agent = { session: { header: { id: 'sess-main', cwd: root } } }

  // ---- 场景 1:没有 last-result.json 时不注入 ----
  {
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    const contexts = await assembleOnce(handlers, agent)
    assert.equal(contexts.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '无回执文件不应注入')
    console.log('OK 1: 没有 last-result.json → 不注入')
  }

  // ---- 场景 2:decision=patch → 注入一次;同一条第二次 assemble 不重复 ----
  {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, JSON.stringify({
      at: '2026-11-25T04:26:36.396Z',
      decision: 'patch',
      skill: 'demo-skill',
      confidence: 0.87,
      edits: 3,
      sha256: 'abc123deadbeef',
      reason: '把踩坑结论并进技能',
    }), 'utf8')

    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })

    const first = await assembleOnce(handlers, agent)
    const notices = first.filter((c) => c.name === 'auto-evolve:patch-notice')
    assert.equal(notices.length, 1, '第一次 assemble 应注入回执')
    const text = notices[0].text
    assert.ok(text.includes('【后台技能打磨回执】'), '应含回执标题')
    assert.ok(text.includes('demo-skill'), '应含技能 slug')
    assert.ok(text.includes('改动 3 处'), '应含改动处数')
    assert.ok(text.includes('置信度 0.87'), '应含置信度')
    assert.ok(text.includes('🔧 鲸鱼打磨 +1'), '应含硬信号文案')
    assert.ok(text.includes('不写技能名/路径/具体触发词'), '应含规则说明')
    assert.ok(!text.includes('{{'), '文本不能有裸 {{ (会导致模板插值抛错)')
    console.log('OK 2: decision=patch → 注入回执,文案字段正确')

    const second = await assembleOnce(handlers, agent)
    assert.equal(second.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '第二次不应重复注入')
    console.log('OK 3: 同一条改写第二次 assemble 不重复注入')

    // 去重状态已落盘且跨进程可见
    const seen = JSON.parse(readFileSync(seenFile, 'utf8'))
    assert.ok(Array.isArray(seen.seen) && seen.seen.length === 1, '去重键应落盘')
    assert.ok(seen.seen[0].includes('demo-skill'), '去重键应含 slug')
    assert.ok(seen.seen[0].includes('abc123deadbeef'), '去重键应含 sha256')
    console.log('OK 4: 去重键落 evolutionDir 状态文件,跨进程可见')

    // ---- 场景 3:全新一套 ctx(模拟插件重启/另一个进程)仍不重复 ----
    const rebooted = makeCtx()
    mod.apply(rebooted.ctx, { evolutionDir })
    const afterReboot = await assembleOnce(rebooted.handlers, agent)
    assert.equal(afterReboot.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '重启后同一改写过不应再报')
    console.log('OK 5: 插件重启(新 ctx)后同一条改写仍不重复注入')
  }

  // ---- 场景 4:新的 sha256(又改了一次)→ 应再次提醒 ----
  {
    writeFileSync(resultFile, JSON.stringify({
      at: '2026-11-25T05:00:00.000Z',
      decision: 'patch',
      skill: 'demo-skill',
      confidence: 0.91,
      edits: 1,
      sha256: 'fff999newsha',
    }), 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    const contexts = await assembleOnce(handlers, agent)
    const notices = contexts.filter((c) => c.name === 'auto-evolve:patch-notice')
    assert.equal(notices.length, 1, '不同 sha256 的新改写应再提醒一次')
    assert.ok(notices[0].text.includes('置信度 0.91'))
    const seen = JSON.parse(readFileSync(seenFile, 'utf8'))
    assert.equal(seen.seen.length, 2, '去重表应累积两条')
    console.log('OK 6: 同一技能再次改写(新 sha256)→ 重新提醒')
  }

  // ---- 场景 5:非 patch 决策不注入 ----
  for (const decision of ['skipped', 'error', 'refused', 'create', 'dry-run']) {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, JSON.stringify({ at: '2026-11-25T06:00:00.000Z', decision, skill: 'x', confidence: 0.5, edits: 1, sha256: 'k' }), 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    const contexts = await assembleOnce(handlers, agent)
    assert.equal(contexts.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, decision + ' 不应注入')
  }
  console.log('OK 7: 非 patch 决策(skipped/error/refused/create/dry-run)一律不注入')

  // ---- 场景 6:坏 JSON / decision=patch 但缺 skill → 不注入且不抛 ----
  {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, '{ this is not json', 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    const contexts = await assembleOnce(handlers, agent)
    assert.equal(contexts.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '坏 JSON 不应注入')

    writeFileSync(resultFile, JSON.stringify({ decision: 'patch', confidence: 0.5 }), 'utf8')
    const c2 = makeCtx()
    mod.apply(c2.ctx, { evolutionDir })
    const contexts2 = await assembleOnce(c2.handlers, agent)
    assert.equal(contexts2.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '缺 skill 不应注入')
    console.log('OK 8: 坏 JSON / 缺 skill 字段 → 静默跳过,不抛异常')
  }

  // ---- 场景 7:子代理会话跳过 ----
  {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, JSON.stringify({ at: '2026-11-25T07:00:00.000Z', decision: 'patch', skill: 's', confidence: 0.8, edits: 2, sha256: 'sub' }), 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    const subAgent = { session: { header: { id: 'sess-sub', origin: 'subagent' } } }
    const contexts = await assembleOnce(handlers, subAgent)
    assert.equal(contexts.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '子代理会话不注入')
    assert.equal(contexts.length, 0, '子代理会话不应有任何注入')
    console.log('OK 9: 子代理会话完全跳过(不注入、不烧 token)')
  }

  // ---- 场景 8:开关关闭时不注入 ----
  {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, JSON.stringify({ at: '2026-11-25T08:00:00.000Z', decision: 'patch', skill: 's', confidence: 0.8, edits: 2, sha256: 'off' }), 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir, patchNoticeEnabled: false })
    const contexts = await assembleOnce(handlers, agent)
    assert.equal(contexts.filter((c) => c.name === 'auto-evolve:patch-notice').length, 0, '开关关闭不注入')
    console.log('OK 10: patchNoticeEnabled=false 时不注入')
  }

  // ---- 场景 9:心跳记录回执注入证据 ----
  {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, JSON.stringify({ at: '2026-11-25T09:00:00.000Z', decision: 'patch', skill: 'hbeat', confidence: 0.77, edits: 4, sha256: 'hb1' }), 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    await assembleOnce(handlers, agent)
    const hb = JSON.parse(readFileSync(path.join(reviewDir, 'plugin-heartbeat.json'), 'utf8'))
    assert.equal(hb.patchNoticePushes, 1, '心跳应记注入次数')
    assert.ok(String(hb.lastPatchNoticeKey).includes('hbeat'), '心跳应记最近回执键')
    assert.ok(hb.lastPatchNoticeAt, '心跳应记注入时间')
    console.log('OK 11: 心跳记录 patchNoticePushes/lastPatchNoticeKey/lastPatchNoticeAt')
  }

  // ---- 场景 10:草稿提醒与回执可共存 ----
  {
    rmSync(seenFile, { force: true })
    writeFileSync(resultFile, JSON.stringify({ at: '2026-11-25T10:00:00.000Z', decision: 'patch', skill: 'both', confidence: 0.8, edits: 1, sha256: 'both1' }), 'utf8')
    const draftsDir = path.join(evolutionDir, 'drafts')
    mkdirSync(draftsDir, { recursive: true })
    writeFileSync(path.join(draftsDir, 'co-exist.md'), '---\ndescription: 与回执共存的草稿\nstatus: draft\n---\n# 草稿\n', 'utf8')
    const { ctx, handlers } = makeCtx()
    mod.apply(ctx, { evolutionDir })
    const contexts = await assembleOnce(handlers, agent)
    const names = contexts.map((c) => c.name)
    assert.ok(names.includes('auto-evolve:draft-notice'), '草稿提醒应仍在')
    assert.ok(names.includes('auto-evolve:patch-notice'), '回执应同时存在')
    assert.equal(contexts.length, 2, '两个上下文块各自独立')
    console.log('OK 12: 草稿提醒 + 打磨回执可共存,互不覆盖')
  }

  console.log('')
  console.log('patch-notice OK: 12 组断言全过（注入 / 去重 / 跨进程 / 新改写重报 / 非 patch 跳过 / 坏数据 / 子代理 / 开关 / 心跳 / 共存）')
} finally {
  rmSync(root, { recursive: true, force: true })
}
