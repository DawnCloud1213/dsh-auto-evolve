// @dawn/dsh-auto-evolve — 进化看板半边(host 平面)
//
// 由 lib/index.js 在 apply 期通过 ctx.inject(['webServer']) 挂载:只读聚合
// <evolutionDir> 下的自进化数据,注册 /api/evolve-dashboard/* HTTP 路由,供桌面端
// client(会话页"进化"Tab)用 fetch 拉取。
//
// headless 等没有 webServer 的宿主不会执行到这里,审查主流程完全不受影响。
// 本文件不写任何文件,纯只读。

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DEFAULT_EVOLUTION_DIR = path.join(os.homedir(), '.dsh', 'evolution')

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function readJson(file) {
  const text = await readText(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function listNames(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function countFiles(names, ext) {
  return names.filter((n) => typeof n === 'string' && n.toLowerCase().endsWith(ext)).length
}

/** 从技能 .md 正文里取一级标题,取不到就退回 slug。 */
async function readTitle(file, fallback) {
  const text = await readText(file)
  if (!text) return fallback
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const m = firstLine.match(/^#\s+(.+?)\s*$/)
  return m ? m[1].trim() : fallback
}

function truncate(text, max) {
  const s = String(text == null ? '' : text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

// ---------- 数据加载 ----------

async function loadUsage(dir) {
  const raw = await readJson(path.join(dir, 'skill-usage.json'))
  const skills = raw && raw.skills && typeof raw.skills === 'object' ? raw.skills : {}
  return { version: raw && raw.version, skills }
}

async function loadLedger(dir) {
  const text = await readText(path.join(dir, 'ledger.jsonl'))
  if (!text) return []
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s)
      if (rec && typeof rec === 'object') out.push(rec)
    } catch {
      /* 坏行跳过,不阻塞整条时间线 */
    }
  }
  return out
}

async function loadSkillFiles(dir) {
  const [promotedNames, draftNames, retiredNames] = await Promise.all([
    listNames(path.join(dir, 'promoted')),
    listNames(path.join(dir, 'drafts')),
    listNames(path.join(dir, 'retired')),
  ])
  const toSet = (names) =>
    new Set(
      names
        .filter((n) => typeof n === 'string' && n.toLowerCase().endsWith('.md'))
        .map((n) => n.slice(0, -3)),
    )
  return {
    promoted: toSet(promotedNames),
    drafts: toSet(draftNames),
    retired: toSet(retiredNames),
    counts: {
      promoted: countFiles(promotedNames, '.md'),
      drafts: countFiles(draftNames, '.md'),
      retired: countFiles(retiredNames, '.md'),
    },
  }
}

/** 合并 skill-usage.json 与目录文件,得到前端要的清单。 */
async function buildSkills(dir) {
  const [usage, files] = await Promise.all([loadUsage(dir), loadSkillFiles(dir)])
  const slugs = new Set([...Object.keys(usage.skills), ...files.promoted, ...files.drafts, ...files.retired])

  const list = Array.from(slugs).map((slug) => {
    const rec = usage.skills[slug] || {}
    const inPromoted = files.promoted.has(slug)
    const inDrafts = files.drafts.has(slug)
    const inRetired = files.retired.has(slug)
    return {
      slug,
      useCount: Number(rec.use_count) || 0,
      viewCount: Number(rec.view_count) || 0,
      patchCount: Number(rec.patch_count) || 0,
      state: rec.state || (inRetired ? 'retired' : inDrafts ? 'draft' : 'active'),
      createdBy: rec.created_by || null,
      pinned: Boolean(rec.pinned),
      createdAt: rec.created_at || rec.first_seen_at || null,
      lastUsedAt: rec.last_used_at || null,
      lastViewedAt: rec.last_viewed_at || null,
      lastPatchedAt: rec.last_patched_at || null,
      file: { promoted: inPromoted, draft: inDrafts, retired: inRetired },
      title: null,
    }
  })

  await Promise.all(
    list.map(async (item) => {
      const name = item.slug + '.md'
      if (item.file.promoted) item.title = await readTitle(path.join(dir, 'promoted', name), item.slug)
      else if (item.file.draft) item.title = await readTitle(path.join(dir, 'drafts', name), item.slug)
      else if (item.file.retired) item.title = await readTitle(path.join(dir, 'retired', name), item.slug)
    }),
  )

  list.sort((a, b) => {
    if (b.useCount !== a.useCount) return b.useCount - a.useCount
    if (Number(b.patchCount) !== Number(a.patchCount)) return Number(b.patchCount) - Number(a.patchCount)
    return a.slug.localeCompare(b.slug)
  })

  return { skills: list, usageVersion: usage.version, fileCounts: files.counts }
}

function summarizeTimeline(entries) {
  const stats = { draft: 0, patch: 0, promote: 0, retire: 0, other: 0 }
  for (const e of entries) {
    const action = String((e && e.action) || '').toLowerCase()
    if (action in stats && action !== 'other') stats[action] += 1
    else stats.other += 1
  }
  return stats
}

async function buildTimeline(dir, limit) {
  const raw = await loadLedger(dir)
  const max = Math.max(1, Math.min(Number(limit) || 200, 2000))
  const entries = raw
    .slice()
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, max)
    .map((e) => ({
      id: e.id || null,
      ts: e.ts || null,
      actor: e.actor || null,
      action: String(e.action || '').toLowerCase() || null,
      skill: e.skill || null,
      reason: truncate(e.reason, 320),
      confidence: typeof e.confidence === 'number' ? e.confidence : null,
      model: e.model || null,
      session: e.session || null,
      file: e.file || null,
    }))
  return { entries, stats: summarizeTimeline(raw), total: raw.length }
}

async function buildOverview(dir) {
  const reviewDir = path.join(dir, 'review')
  const [usage, ledger, files, heartbeat, state, lastResult, queueNames] = await Promise.all([
    loadUsage(dir),
    loadLedger(dir),
    loadSkillFiles(dir),
    readJson(path.join(reviewDir, 'plugin-heartbeat.json')),
    readJson(path.join(reviewDir, 'state.json')),
    readJson(path.join(reviewDir, 'last-result.json')),
    listNames(path.join(reviewDir, 'queue')),
  ])

  const records = Object.values(usage.skills)
  const active = records.filter((r) => (r && (r.state || 'active')) === 'active').length

  return {
    generatedAt: new Date().toISOString(),
    evolutionDir: dir,
    exists: await pathExists(dir),
    heartbeat: heartbeat || null,
    review: {
      lastReviewed: (state && state.lastReviewed) || null,
      lastReviewAt: (state && state.lastReviewAt) || null,
      dayKey: (state && state.dayKey) || null,
      dayCount: (state && state.dayCount) || 0,
      recent: Array.isArray(state && state.recent) ? state.recent.slice(0, 12) : [],
      lastResult: lastResult || null,
      queuePending: queueNames.filter((n) => typeof n === 'string' && n.toLowerCase().endsWith('.json')).length,
    },
    counts: {
      skills: Object.keys(usage.skills).length,
      active,
      archived: Object.keys(usage.skills).length - active,
      promoted: files.counts.promoted,
      drafts: files.counts.drafts,
      retired: files.counts.retired,
      ledgerEntries: ledger.length,
      totalUse: records.reduce((n, r) => n + (Number(r && r.use_count) || 0), 0),
    },
  }
}

async function buildSkillDoc(dir, slug) {
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(String(slug))) {
    return { ok: false, error: { code: 'bad-args', message: '无效的技能名' } }
  }
  const candidates = [
    { dir: 'promoted', source: 'promoted' },
    { dir: 'drafts', source: 'drafts' },
    { dir: 'retired', source: 'retired' },
  ]
  let found = null
  for (const c of candidates) {
    const file = path.join(dir, c.dir, slug + '.md')
    const text = await readText(file)
    if (text !== null) {
      found = { markdown: truncate(text, 262144), source: c.source, file }
      break
    }
  }
  const usage = await loadUsage(dir)
  const rec = usage.skills[slug] || null
  return {
    ok: true,
    slug,
    markdown: found ? found.markdown : null,
    source: found ? found.source : null,
    usage: rec
      ? {
          useCount: Number(rec.use_count) || 0,
          viewCount: Number(rec.view_count) || 0,
          patchCount: Number(rec.patch_count) || 0,
          state: rec.state || 'active',
          createdBy: rec.created_by || null,
          createdAt: rec.created_at || null,
          lastUsedAt: rec.last_used_at || null,
        }
      : null,
  }
}

// ---------- 挂载入口 ----------

/**
 * 注册 /api/evolve-dashboard/* 路由。
 * @param {object} sctx 已注入 webServer 的 cordis 上下文
 * @param {{ evolutionDir?: string, log?: (msg: string) => void }} [options]
 * @returns {() => void} 清理函数(dispose 时注销全部路由)
 */
export function registerDashboardRoutes(sctx, options) {
  const opts = options || {}
  const dir = opts.evolutionDir || process.env.DSH_EVOLUTION_DIR || DEFAULT_EVOLUTION_DIR
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  const handlers = {
    '/api/evolve-dashboard/overview': async () => buildOverview(dir),
    '/api/evolve-dashboard/skills': async () => {
      const built = await buildSkills(dir)
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        skills: built.skills,
        usageVersion: built.usageVersion,
        fileCounts: built.fileCounts,
      }
    },
    '/api/evolve-dashboard/timeline': async (body) => {
      const built = await buildTimeline(dir, body && body.limit)
      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        entries: built.entries,
        stats: built.stats,
        total: built.total,
      }
    },
    '/api/evolve-dashboard/skill': async (body) => buildSkillDoc(dir, body && body.slug),
  }

  try {
    const disposers = Object.entries(handlers).map(([route, run]) =>
      sctx.webServer.register({
        kind: 'exact',
        path: route,
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
            const body = await readJsonBody(req, 64 * 1024)
            const out = await run(body)
            if (out && out.ok === false) return sendJson(res, 400, out)
            sendJson(res, 200, out)
          } catch (err) {
            sendJson(res, 500, { ok: false, error: { code: 'internal', message: String((err && err.message) || err) } })
          }
        },
      }),
    )
    return () => disposers.forEach((d) => d())
  } catch (error) {
    log('进化看板路由注册失败: ' + String((error && error.message) || error))
    return () => {}
  }
}
