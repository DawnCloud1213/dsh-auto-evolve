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
import { parseFrontmatter, readLedgerPromoted, isAgentMarker } from '../evolution/lib/skills-index.mjs'

const DEFAULT_EVOLUTION_DIR = path.join(os.homedir(), '.dsh', 'evolution')

/**
 * 技能正文的真实落盘位置，按「实际生效」优先排序。
 *
 * 2026-11-01 起 bg-review 转正 = 直接写 <skills>/<slug>/SKILL.md(热加载即生效),
 * 不再往 <evolutionDir>/promoted/ 抄副本。旧版只查 promoted/drafts/retired 三个目录,
 * 导致此后新落库的技能点开一律显示「还没有落盘的正文」。这里补上真实位置,
 * 并把历史副本降为兜底(副本可能是过时旧版)。
 */
const SKILL_BODY_ROOTS = [
  { dir: path.join(os.homedir(), '.dsh', 'skills'), source: 'skills' },
  { dir: path.join(os.homedir(), '.dsh', 'evolved-skills'), source: 'evolved' },
  { dir: path.join(os.homedir(), '.agents', 'skills'), source: 'external' },
]

/** 正文来源的中文标签。 */
const SOURCE_LABEL = {
  skills: '自沉淀库',
  evolved: '导入库',
  external: '外部安装',
  promoted: '转正快照',
  drafts: '草稿区',
  retired: '退役区',
}

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

/** 在真实技能库里定位 <root>/<slug>/SKILL.md,返回 { file, source } 或 null。 */
async function findSkillBody(slug) {
  if (!slug) return null
  for (const r of SKILL_BODY_ROOTS) {
    const file = path.join(r.dir, slug, 'SKILL.md')
    if (await pathExists(file)) return { file, source: r.source }
  }
  return null
}

/** 读一次 frontmatter(顺带拿到 createdBy 用于归属判定)。 */
async function readFrontmatter(file) {
  const text = await readText(file)
  if (!text) return {}
  return parseFrontmatter(text) || {}
}

/**
 * 归属判定,与 evolution/lib/skills-index.mjs#classifyOwner 同口径:
 * 外部库一律 external;导入库一律 agent;frontmatter 标记或账本转正记录算 agent;其余算用户。
 * 「宁可判成用户的」是有意的——判错成 agent 会让自动审查去改写用户手写的技能。
 */
function classifyOwner(source, createdBy, slug, promotedSet) {
  if (source === 'external') return 'external'
  if (source === 'evolved') return 'agent'
  // promoted 副本 = 当年转正时抄出来的产物,天然属于 agent
  if (source === 'promoted') return 'agent'
  if (isAgentMarker(createdBy)) return 'agent'
  if (promotedSet.has(slug)) return 'agent'
  return 'user'
}

/** 账本里被转正过的 slug 集合(转正的真凭据,不再依赖 promoted 副本是否还存在)。 */
async function loadLedgerPromotedSlugs(dir) {
  try {
    return readLedgerPromoted(path.join(dir, 'ledger.jsonl'))
  } catch {
    return new Set()
  }
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

/** 取正文里第一个一级标题(跳过 frontmatter)。 */
function firstHeading(text, fallback) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  let seenOpen = false
  let inFrontmatter = false
  for (const line of lines) {
    const t = line.trim()
    if (!seenOpen) {
      if (t !== '---') break
      seenOpen = true
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (t === '---') inFrontmatter = false
      continue
    }
    const m = line.match(/^#\s+(.+?)\s*$/)
    if (m) return m[1].trim()
  }
  return fallback
}

/** 合并 skill-usage.json、账本、真实技能库与副本目录,得到前端要的清单。 */
async function buildSkills(dir) {
  const [usage, files, promotedSet] = await Promise.all([
    loadUsage(dir),
    loadSkillFiles(dir),
    loadLedgerPromotedSlugs(dir),
  ])
  const slugs = new Set([...Object.keys(usage.skills), ...files.promoted, ...files.drafts, ...files.retired])

  const list = await Promise.all(
    Array.from(slugs).map(async (slug) => {
      const rec = usage.skills[slug] || {}
      const live = await findSkillBody(slug)
      const text = live ? await readText(live.file) : null
      const fmeta = (text && parseFrontmatter(text)) || {}
      const inDrafts = files.drafts.has(slug)
      const inRetired = files.retired.has(slug)
      // 「已转正」以账本 promote 记录为准(旧版只看 promoted 副本是否还在,会漏掉新落库的)
      const inPromoted = promotedSet.has(slug) || files.promoted.has(slug)
      // 正文实际位置:真实技能库优先,evolution 副本兜底
      let location = live ? live.source : null
      if (!location) {
        if (inDrafts) location = 'drafts'
        else if (inRetired) location = 'retired'
        else if (files.promoted.has(slug)) location = 'promoted'
      }
      return {
        slug,
        useCount: Number(rec.use_count) || 0,
        viewCount: Number(rec.view_count) || 0,
        patchCount: Number(rec.patch_count) || 0,
        state: rec.state || (inRetired ? 'retired' : inDrafts ? 'draft' : 'active'),
        createdBy: fmeta.createdBy || rec.created_by || null,
        pinned: Boolean(rec.pinned),
        createdAt: rec.created_at || rec.first_seen_at || null,
        lastUsedAt: rec.last_used_at || null,
        lastViewedAt: rec.last_viewed_at || null,
        lastPatchedAt: rec.last_patched_at || null,
        promoted: inPromoted,
        owner: classifyOwner(live ? live.source : location, fmeta.createdBy, slug, promotedSet),
        location,
        sourceLabel: location ? SOURCE_LABEL[location] || location : null,
        file: {
          promoted: inPromoted,
          draft: inDrafts,
          retired: inRetired,
          live: live ? live.source : null,
        },
        title: text ? firstHeading(text, slug) : null,
      }
    }),
  )

  // 没有真实正文的(只在 evolution 副本里),标题从副本取
  await Promise.all(
    list.map(async (item) => {
      if (item.title) return
      const name = item.slug + '.md'
      if (files.promoted.has(item.slug)) item.title = await readTitle(path.join(dir, 'promoted', name), item.slug)
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
  // 1) 先找真实落盘位置(自沉淀库/导入库/外部库)——那才是当前生效版本
  let found = null
  const live = await findSkillBody(slug)
  if (live) {
    const text = await readText(live.file)
    if (text !== null) {
      found = {
        markdown: truncate(text, 262144),
        source: live.source,
        file: live.file,
        fmeta: parseFrontmatter(text) || {},
      }
    }
  }
  // 2) 再退回 evolution 下的历史副本(可能是过时旧版,仅兜底)
  if (!found) {
    const candidates = [
      { dir: 'promoted', source: 'promoted' },
      { dir: 'drafts', source: 'drafts' },
      { dir: 'retired', source: 'retired' },
    ]
    for (const c of candidates) {
      const file = path.join(dir, c.dir, slug + '.md')
      const text = await readText(file)
      if (text !== null) {
        found = {
          markdown: truncate(text, 262144),
          source: c.source,
          file,
          fmeta: parseFrontmatter(text) || {},
        }
        break
      }
    }
  }
  const [usage, promotedSet] = await Promise.all([loadUsage(dir), loadLedgerPromotedSlugs(dir)])
  const rec = usage.skills[slug] || null
  const createdBy = (found && found.fmeta && found.fmeta.createdBy) || (rec && rec.created_by) || ''
  return {
    ok: true,
    slug,
    markdown: found ? found.markdown : null,
    source: found ? found.source : null,
    sourceLabel: found ? SOURCE_LABEL[found.source] || found.source : null,
    owner: classifyOwner(found ? found.source : null, createdBy, slug, promotedSet),
    promoted: promotedSet.has(slug),
    file: found ? found.file : null,
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

// 供自测直接调用(不经过 HTTP):node -e "import(...).then(m => m.buildSkillDoc(...))"
export { buildSkills, buildSkillDoc }
