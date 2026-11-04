// @dawn/dsh-auto-evolve 进化看板路由冒烟:4 个端点注册、数据聚合、非法参数、dispose.
// 运行: node test/dashboard-smoke.mjs  (或在仓库根 npm test)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { registerDashboardRoutes } from '../lib/dashboard.js'

const root = mkdtempSync(path.join(tmpdir(), 'dsh-dash-smoke-'))
try {
  // ---- 造假 evolution 目录 ----
  const evolution = path.join(root, 'evolution')
  mkdirSync(path.join(evolution, 'promoted'), { recursive: true })
  mkdirSync(path.join(evolution, 'drafts'), { recursive: true })
  mkdirSync(path.join(evolution, 'retired'), { recursive: true })
  mkdirSync(path.join(evolution, 'review', 'queue'), { recursive: true })

  writeFileSync(
    path.join(evolution, 'skill-usage.json'),
    JSON.stringify({
      version: 1,
      skills: {
        'alpha-skill': { use_count: 5, view_count: 2, patch_count: 1, state: 'active', created_by: 'agent', last_used_at: '2026-11-01T00:00:00.000Z' },
        'beta-skill': { use_count: 2, view_count: 0, patch_count: 0, state: 'active', created_by: 'external' },
      },
    }),
    'utf8',
  )
  writeFileSync(
    path.join(evolution, 'ledger.jsonl'),
    [
      JSON.stringify({ id: 'a1', ts: '2026-11-01T01:00:00.000Z', actor: 'bg-review', action: 'draft', skill: 'alpha-skill', reason: '某条原因', confidence: 0.9, model: 'deepseek-flash' }),
      JSON.stringify({ id: 'a2', ts: '2026-11-01T02:00:00.000Z', actor: 'bg-review', action: 'promote', skill: 'alpha-skill', reason: '转正' }),
      JSON.stringify({ id: 'a3', ts: '2026-11-01T03:00:00.000Z', actor: 'bg-review', action: 'refuse', skill: 'beta-skill', reason: 'owner=user' }),
      'not-json-line',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(path.join(evolution, 'promoted', 'alpha-skill.md'), '# Alpha 技能\n\n正文', 'utf8')
  writeFileSync(path.join(evolution, 'review', 'plugin-heartbeat.json'), JSON.stringify({ version: '0.4.0', itersTotal: 42, nudgeInterval: 10 }), 'utf8')
  writeFileSync(path.join(evolution, 'review', 'state.json'), JSON.stringify({ dayCount: 2, lastReviewAt: '2026-11-01T03:00:00.000Z', recent: [{ session: 's1', turn: 2, at: '2026-11-01T03:00:00.000Z', decision: 'draft' }] }), 'utf8')
  writeFileSync(path.join(evolution, 'review', 'last-result.json'), JSON.stringify({ decision: 'draft', model: 'deepseek-flash' }), 'utf8')
  writeFileSync(path.join(evolution, 'review', 'queue', 'a.json'), '{}', 'utf8')
  writeFileSync(path.join(evolution, 'review', 'queue', 'b.json'), '{}', 'utf8')

  // ---- 注册路由 ----
  const routes = new Map()
  const disposed = []
  const sctx = {
    webServer: {
      register(def) {
        routes.set(def.path, def.handler)
        return () => disposed.push(def.path)
      },
    },
  }
  const dispose = registerDashboardRoutes(sctx, { evolutionDir: evolution })
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      '/api/evolve-dashboard/overview',
      '/api/evolve-dashboard/skill',
      '/api/evolve-dashboard/skills',
      '/api/evolve-dashboard/timeline',
    ],
    '应注册 4 个路由',
  )

  function call(route, body) {
    return new Promise((resolve) => {
      const req = new EventEmitter()
      req.method = 'POST'
      const out = {}
      const res = {
        writeHead(status) { out.status = status },
        end(text) { out.body = text; resolve(out) },
      }
      routes.get(route)(req, res)
      req.emit('data', Buffer.from(JSON.stringify(body || {})))
      req.emit('end')
    })
  }

  // ---- overview ----
  const ov = JSON.parse((await call('/api/evolve-dashboard/overview', {})).body)
  assert.equal(ov.exists, true)
  assert.equal(ov.counts.skills, 2)
  assert.equal(ov.counts.promoted, 1)
  assert.equal(ov.counts.ledgerEntries, 3, '坏 jsonl 行应被跳过')
  assert.equal(ov.counts.totalUse, 7)
  assert.equal(ov.review.queuePending, 2)
  assert.equal(ov.heartbeat.version, '0.4.0')

  // ---- skills ----
  const sk = JSON.parse((await call('/api/evolve-dashboard/skills', {})).body)
  assert.equal(sk.ok, true)
  assert.equal(sk.skills.length, 2)
  assert.equal(sk.skills[0].slug, 'alpha-skill', '按 useCount 降序')
  assert.equal(sk.skills[0].useCount, 5)
  assert.equal(sk.skills[0].title, 'Alpha 技能', '应从 md 一级标题取 title')
  assert.equal(sk.skills[0].file.promoted, true)
  assert.equal(sk.skills[1].file.promoted, false)

  // ---- timeline ----
  const tl = JSON.parse((await call('/api/evolve-dashboard/timeline', { limit: 10 })).body)
  assert.equal(tl.entries.length, 3)
  assert.equal(tl.entries[0].id, 'a3', '最新在前')
  assert.deepEqual(tl.stats, { draft: 1, patch: 0, promote: 1, retire: 0, other: 1 })

  // ---- skill 正文 ----
  const doc = JSON.parse((await call('/api/evolve-dashboard/skill', { slug: 'alpha-skill' })).body)
  assert.equal(doc.ok, true)
  assert.equal(doc.source, 'promoted')
  assert.ok(doc.markdown.includes('Alpha 技能'))
  assert.equal(doc.usage.useCount, 5)

  // 没有正文的技能仍返回 ok,markdown 为 null
  const emptyDoc = JSON.parse((await call('/api/evolve-dashboard/skill', { slug: 'beta-skill' })).body)
  assert.equal(emptyDoc.ok, true)
  assert.equal(emptyDoc.markdown, null)

  // ---- 非法参数 ----
  const bad = await call('/api/evolve-dashboard/skill', { slug: '../etc/passwd' })
  assert.equal(bad.status, 400)
  assert.equal(JSON.parse(bad.body).ok, false)

  // ---- dispose ----
  dispose()
  assert.equal(disposed.length, 4, 'dispose 应注销全部路由')

  console.log('dashboard-smoke OK: 4 路由 / 聚合正确 / 坏行容错 / 非法 slug 400 / dispose 干净')
} finally {
  rmSync(root, { recursive: true, force: true })
}
