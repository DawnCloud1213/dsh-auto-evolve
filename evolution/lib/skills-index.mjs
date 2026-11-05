// lib/skills-index.mjs — 技能库索引 / 归属判定 / 定向替换 / 安全写入
// 对齐 Hermes：curator-managed 才可自动改写；用户手写与外部安装一律拒写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH_HOME = path.join(os.homedir(), '.dsh');

export const SKILL_ROOTS = [
  { dir: path.join(DSH_HOME, 'skills'), kind: 'skills' },
  { dir: path.join(DSH_HOME, 'evolved-skills'), kind: 'evolved' },
  { dir: path.join(os.homedir(), '.agents', 'skills'), kind: 'external' },
];

/** 自沉淀技能在 frontmatter 里的 createdBy 取值（视为 agent 所有）。 */
const AGENT_MARKERS = ['self-evolution', 'bg-review', 'auto-evolve', 'auto-promote'];

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let val = mm[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[mm[1]] = val;
  }
  return out;
}

/** ledger 里被 promote 过的 slug —— 说明这条技能是 agent 之前沉淀的。 */
export function readLedgerPromoted(ledgerFile) {
  const set = new Set();
  try {
    const lines = fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.action === 'promote' && row.skill) {
          set.add(String(row.skill));
          const to = String(row.to || '');
          const seg = to.split('/');
          if (seg.length > 1) set.add(seg[1]);
        }
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 没有 ledger */ }
  return set;
}

function classifyOwner(kind, createdBy, slug, promotedSet) {
  if (kind === 'external') return 'external';
  if (kind === 'evolved') return 'agent'; // 用户 2026-11-01 拍板：导入的自沉淀技能算 agent 的，可改
  if (AGENT_MARKERS.includes(String(createdBy || '').trim())) return 'agent';
  if (promotedSet.has(slug)) return 'agent';
  return 'user';
}

/** 扫描三个技能根，返回索引数组。 */
export function loadSkillIndex(ledgerFile) {
  const promoted = readLedgerPromoted(ledgerFile);
  const entries = [];
  for (const root of SKILL_ROOTS) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch { continue; }
    for (const d of dirs) {
      const file = path.join(root.dir, d.name, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const fmeta = parseFrontmatter(text) || {};
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
      entries.push({
        slug: d.name,
        file,
        root: root.kind,
        owner: classifyOwner(root.kind, fmeta.createdBy, d.name, promoted),
        createdBy: fmeta.createdBy || '',
        name: fmeta.name || d.name,
        description: String(fmeta.description || '').slice(0, 200),
        mtime,
        bytes: text.length,
      });
    }
  }
  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  return entries;
}

/** 渲染给模型看的清单（控制 token：只给 slug/owner/描述/最后修改）。 */
export function renderIndexForPrompt(entries, { maxItems = 60 } = {}) {
  const lines = [];
  for (const e of entries.slice(0, maxItems)) {
    const days = e.mtime ? Math.round((Date.now() - e.mtime) / 86400000) : null;
    lines.push(
      '- ' + e.slug + ' | owner=' + e.owner + ' | ' + days + 'd前改 | ' + (e.description || '（无描述）')
    );
  }
  if (entries.length > maxItems) lines.push('- ……另有 ' + (entries.length - maxItems) + ' 条未列出');
  return lines.join('\n');
}

export function readSkillFull(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fmeta = parseFrontmatter(text);
  return { text, frontmatter: fmeta, body: fmeta ? text.slice(text.indexOf('---', 3) + 3) : text };
}

/** 定向替换（对齐 Hermes 的 patch：唯一匹配才改）。 */
export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: 'no-edits' };
  let out = String(text);
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    const oldStr = typeof e.old_string === 'string' ? e.old_string : '';
    const newStr = typeof e.new_string === 'string' ? e.new_string : '';
    if (!oldStr) return { ok: false, error: 'edit#' + i + ': empty old_string' };
    if (oldStr === newStr) return { ok: false, error: 'edit#' + i + ': old_string equals new_string' };
    const first = out.indexOf(oldStr);
    if (first < 0) return { ok: false, error: 'edit#' + i + ': old_string not found' };
    const second = out.indexOf(oldStr, first + oldStr.length);
    if (second >= 0 && !e.replace_all) return { ok: false, error: 'edit#' + i + ': old_string matches multiple places; narrow it' };
    out = e.replace_all ? out.split(oldStr).join(newStr) : out.slice(0, first) + newStr + out.slice(first + oldStr.length);
  }
  return { ok: true, text: out };
}

/** 写入前校验：frontmatter 合法 + 正文非空 + 长度没有离谱变化。 */
export function validateSkillText(text, { oldText = null } = {}) {
  const t = String(text || '');
  if (t.length < 120) return { ok: false, error: 'too-short: ' + t.length + ' chars' };
  if (t.length > 60000) return { ok: false, error: 'too-long: ' + t.length + ' chars' };
  const fmeta = parseFrontmatter(t);
  if (!fmeta) return { ok: false, error: 'missing frontmatter' };
  if (!fmeta.name) return { ok: false, error: 'frontmatter missing name' };
  if (!fmeta.description) return { ok: false, error: 'frontmatter missing description' };
  if (oldText) {
    const ratio = t.length / Math.max(1, String(oldText).length);
    if (ratio > 2.5) return { ok: false, error: 'grew ' + ratio.toFixed(2) + 'x — refuse blind rewrite' };
    if (ratio < 0.4) return { ok: false, error: 'shrank to ' + ratio.toFixed(2) + 'x — refuse destructive edit' };
  }
  return { ok: true, frontmatter: fmeta };
}

/** 备份 + 原子写。返回备份路径（新文件时为 null）。 */
export function writeSkillSafely(file, text, backupDir) {
  let backupPath = null;
  if (fs.existsSync(file)) {
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, path.basename(path.dirname(file)) + '-' + ts + '.md');
    fs.copyFileSync(file, backupPath);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return backupPath;
}
