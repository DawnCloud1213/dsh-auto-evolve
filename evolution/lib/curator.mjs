// lib/curator.mjs — 技能库维护（对齐 Hermes curator：小步、可恢复、永不真删）
//
// 陈旧度判定与 Hermes 一致：不用文件 mtime，用 skill-usage.json 里的真实活动时钟
//   anchor = max(last_used_at, last_viewed_at, last_patched_at) || created_at
//   · 60 天没真实活动 → 标记 stale（只标记，不动文件）
//   · 90 天没真实活动 → 归档，移进 evolution/retired/（原样保留，可移回）
//   · 从未使用过的技能不算陈旧；pinned 与 user/external 技能一律不碰
//   · 每天最多跑一次（state.lastCuratorAt）
import fs from 'node:fs';
import path from 'node:path';
import { applyTransitions, markArchived, loadUsage } from './skill-usage.mjs';

export const STALE_AFTER_DAYS = 60;
export const RETIRE_AFTER_DAYS = 90;

export function maybeRunCurator({ evolutionDir, skillsIndex, state, persist, staleDays = STALE_AFTER_DAYS, archiveDays = RETIRE_AFTER_DAYS }) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (state && state.lastCuratorAt && String(state.lastCuratorAt).slice(0, 10) === today) {
      return { ran: false, reason: 'already-ran-today', archived: [], counts: null };
    }

    const counts = applyTransitions(evolutionDir, skillsIndex, { staleDays, archiveDays });
    const retiredDir = path.join(evolutionDir, 'retired');
    const archived = [];
    const byName = new Map((skillsIndex || []).map((e) => [e.slug, e]));

    for (const slug of counts.archivedNames) {
      const entry = byName.get(slug);
      if (!entry || entry.owner !== 'agent') continue; // 归属兜底：用户手写/外部安装永不归档
      const destDir = path.join(retiredDir, slug);
      if (fs.existsSync(destDir)) continue;
      try {
        fs.mkdirSync(retiredDir, { recursive: true });
        fs.renameSync(path.dirname(entry.file), destDir);
        markArchived(evolutionDir, slug);
        archived.push({ slug, from: path.dirname(entry.file), to: destDir });
      } catch (e) {
        // 单个移不动就跳过，下次再试；绝不中断维护
      }
    }

    if (state) {
      state.lastCuratorAt = new Date().toISOString();
      state.lastCuratorCounts = { ...counts, archivedNames: archived.map((a) => a.slug) };
      if (typeof persist === 'function') persist(state);
    }
    return { ran: true, counts, archived, usage: loadUsage(evolutionDir) };
  } catch (e) {
    return { ran: false, reason: 'error: ' + String(e && e.message ? e.message : e), archived: [] };
  }
}
