// lib/skill-usage.mjs — 技能使用遥测（对齐 Hermes tools/skill_usage.py）
//
// 设计要点（照抄 Hermes）：
//   · 遥测写在 sidecar JSON，绝不写进 SKILL.md frontmatter（不污染用户手写文件）
//   · 计数 bump 是 best-effort：任何异常都吞掉，绝不影响主流程
//   · 生命周期 active → stale → archived；pinned 跳过所有自动转换
//   · 时钟锚点 = max(last_used_at, last_viewed_at, last_patched_at)，全无则回落到 created_at
//   · 「从未使用」不等于「陈旧」：use_count=0 且还在 stale 窗口内的技能不归档
//   · 首次见到（没有持久记录）→ seed 一条并把时钟锚到现在，不当场归档
import fs from 'node:fs';
import path from 'node:path';

export const STATE_ACTIVE = 'active';
export const STATE_STALE = 'stale';
export const STATE_ARCHIVED = 'archived';

const nowIso = () => new Date().toISOString();
const parse = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };

export function emptyRecord(createdBy = null, createdAt = null) {
  const at = createdAt || nowIso();
  return {
    created_by: createdBy,
    use_count: 0, view_count: 0, patch_count: 0,
    last_used_at: null, last_viewed_at: null, last_patched_at: null,
    created_at: at, first_seen_at: nowIso(),
    state: STATE_ACTIVE, pinned: false, archived_at: null,
  };
}

/** 最新一次真实活动；created_at 不计入（否则从未用过的技能会被当成活跃）。 */
export function latestActivity(rec) {
  let best = null;
  for (const k of ['last_used_at', 'last_viewed_at', 'last_patched_at']) {
    const t = parse(rec && rec[k]);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best;
}

export function activityCount(rec) {
  const n = (k) => Number(rec && rec[k]) || 0;
  return n('use_count') + n('view_count') + n('patch_count');
}

function usagePath(evolutionDir) {
  return path.join(evolutionDir, 'skill-usage.json');
}

export function loadUsage(evolutionDir) {
  try {
    const data = JSON.parse(fs.readFileSync(usagePath(evolutionDir), 'utf8'));
    if (data && typeof data === 'object' && data.skills && typeof data.skills === 'object') return data;
  } catch { /* 不存在或坏了都当空 */ }
  return { version: 1, skills: {} };
}

/** 原子写 + 短暂重试（bg-review 与插件可能同时写）。失败只返回 false，绝不抛。 */
export function saveUsage(evolutionDir, data) {
  const file = usagePath(evolutionDir);
  const payload = JSON.stringify(data, null, 2) + '\n';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.mkdirSync(evolutionDir, { recursive: true });
      const tmp = file + '.tmp-' + process.pid + '-' + attempt;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      // 目标被占用时稍等重试
      const until = Date.now() + 40 * (attempt + 1);
      while (Date.now() < until) { /* 忙等几十毫秒，够用了 */ }
    }
  }
  return false;
}

/** 给技能库里还没记录的技能 seed 一条（时钟锚在文件 mtime，不当场判陈旧）。 */
export function seedMissing(evolutionDir, indexEntries) {
  const data = loadUsage(evolutionDir);
  let seeded = 0;
  for (const e of indexEntries || []) {
    if (data.skills[e.slug]) continue;
    // 时钟锚在「首次见到」这一刻，而不是文件 mtime：老技能不该一上线就被判陈旧
    const created = nowIso();
    data.skills[e.slug] = emptyRecord(e.owner, created);
    data.skills[e.slug].first_seen_at = created;
    seeded += 1;
  }
  if (seeded) saveUsage(evolutionDir, data);
  return seeded;
}

/** 计数 bump：best-effort，失败静默。 */
function bump(evolutionDir, slug, countKey, tsKey) {
  try {
    const data = loadUsage(evolutionDir);
    const name = String(slug || '').trim();
    if (!name) return false;
    const rec = data.skills[name] || emptyRecord(null, null);
    rec[countKey] = (Number(rec[countKey]) || 0) + 1;
    rec[tsKey] = nowIso();
    // 被使用过就复活（对齐 Hermes 的 reactivate）
    if (rec.state === STATE_STALE) rec.state = STATE_ACTIVE;
    if (rec.state === STATE_ARCHIVED) { rec.state = STATE_ACTIVE; rec.archived_at = null; }
    data.skills[name] = rec;
    return saveUsage(evolutionDir, data);
  } catch { return false; }
}

export const bumpView = (d, slug) => bump(d, slug, 'view_count', 'last_viewed_at');
export const bumpUse = (d, slug) => bump(d, slug, 'use_count', 'last_used_at');
export const bumpPatch = (d, slug) => bump(d, slug, 'patch_count', 'last_patched_at');

/**
 * 生命周期自动转换（对齐 Hermes curator.apply_automatic_transitions）。
 * 返回 { checked, seeded, marked_stale, archived, reactivated, archivedNames }。
 */
export function applyTransitions(evolutionDir, indexEntries, { staleDays = 60, archiveDays = 90 } = {}) {
  const seeded = seedMissing(evolutionDir, indexEntries);
  const data = loadUsage(evolutionDir);
  const now = Date.now();
  const staleCutoff = now - staleDays * 86400000;
  const archiveCutoff = now - archiveDays * 86400000;
  const counts = { checked: 0, seeded, marked_stale: 0, archived: 0, reactivated: 0, archivedNames: [] };

  for (const e of indexEntries || []) {
    const rec = data.skills[e.slug];
    if (!rec) continue;
    counts.checked += 1;
    // 只维护 agent 自己的技能；用户手写与外部安装一律不动（pinned 同理）
    if (rec.pinned || rec.created_by === 'user' || rec.created_by === 'external' || e.owner !== 'agent') continue;
    const anchor = latestActivity(rec) || parse(rec.created_at) || now;
    const current = rec.state || STATE_ACTIVE;
    // 从未使用 ≠ 陈旧：窗口内不归档
    if ((Number(rec.use_count) || 0) === 0 && activityCount(rec) === 0 && anchor > staleCutoff) {
      if (current === STATE_STALE) { rec.state = STATE_ACTIVE; counts.reactivated += 1; }
      continue;
    }
    if (anchor <= archiveCutoff && current !== STATE_ARCHIVED) {
      // 只报名单：移文件由调用方完成，成功后再 markArchived（避免状态与磁盘不一致）
      counts.archived += 1;
      counts.archivedNames.push(e.slug);
    } else if (anchor <= staleCutoff && current === STATE_ACTIVE) {
      rec.state = STATE_STALE;
      counts.marked_stale += 1;
    } else if (anchor > staleCutoff && current === STATE_STALE) {
      rec.state = STATE_ACTIVE;
      counts.reactivated += 1;
    }
  }
  saveUsage(evolutionDir, data);
  return counts;
}

/** 归档后回写状态（调用方移完文件再调用）。 */
export function markArchived(evolutionDir, slug) {
  try {
    const data = loadUsage(evolutionDir);
    const rec = data.skills[slug];
    if (!rec) return false;
    rec.state = STATE_ARCHIVED;
    rec.archived_at = rec.archived_at || nowIso();
    return saveUsage(evolutionDir, data);
  } catch { return false; }
}

/** 从会话消息里抠出本轮 skill 工具调用（name=skill，参数含技能名）。 */
export function extractSkillCalls(messages) {
  const names = new Set();
  if (!Array.isArray(messages)) return [];
  for (const msg of messages) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool-call') continue;
      const toolName = String(block.name || '');
      if (toolName !== 'skill' && toolName !== 'skill_view') continue;
      let args = block.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      const slug = args && (args.name || args.skill);
      if (slug) names.add(String(slug).trim());
    }
  }
  return Array.from(names);
}
