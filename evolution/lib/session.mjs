// lib/session.mjs — 会话日志读取（多帧 zstd）与 transcript 构造
// 多帧 zstd 解帧代码直接复用 M1 方案 §3.1；transcript 构造复用 §5.2（补了边界处理）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

/** 解多帧 zstd（Node 原生 zstdDecompressSync 只解第一帧，必须按 magic 扫帧）。 */
export function readSessionFile(file) {
  const raw = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; ;) {
    const j = raw.indexOf(ZSTD_MAGIC, i);
    if (j < 0) break;
    starts.push(j);
    i = j + 4;
  }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const seg = raw.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : raw.length);
    try { parts.push(zlib.zstdDecompressSync(seg)); } catch { /* 跳过坏帧 */ }
  }
  const text = Buffer.concat(parts).toString('utf8');
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 遍历 sessions/*\<session-id>\session.v4.jsonl.zstd 找会话文件，不猜 cwd 编码。 */
export function findSessionFile(sessionId, root = DEFAULT_SESSIONS_ROOT) {
  if (!sessionId) return null;
  const candidates = [
    path.join(root, sessionId, 'session.v4.jsonl.zstd'),
  ];
  try {
    for (const enc of fs.readdirSync(root, { withFileTypes: true })) {
      if (!enc.isDirectory()) continue;
      candidates.push(path.join(root, enc.name, String(sessionId), 'session.v4.jsonl.zstd'));
    }
  } catch { /* root 不存在就只试直接命中 */ }
  for (const f of candidates) {
    try { if (fs.statSync(f).isFile()) return f; } catch { /* ignore */ }
  }
  return null;
}

export function loadSessionEvents(sessionId, root = DEFAULT_SESSIONS_ROOT) {
  const file = findSessionFile(sessionId, root);
  if (!file) throw new Error('session file not found for id: ' + sessionId);
  const events = readSessionFile(file);
  return { file, events };
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** 从队列 messages（parts 或 content 两种形态）渲染成 [role] text 纯文本。 */
export function renderMessages(messages, { maxChars = 24000 } = {}) {
  if (!Array.isArray(messages)) return '';
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : 'unknown';
    const blocks = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : [];
    const lines = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      const kind = b.kind || b.type || '';
      if (kind === 'text' || kind === 'input_text') {
        const t = blockText(b);
        if (t) lines.push('[' + role + '] ' + t);
      } else if (kind === 'tool-call') {
        const name = b.name || b.toolName || 'tool';
        const args = typeof b.args === 'string' ? b.args : typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.args || b.arguments || {});
        lines.push('[tool-call] ' + name + ' ' + String(args).slice(0, 300));
      } else if (kind === 'tool-result' || kind === 'tool_result') {
        lines.push('[tool-result] ' + blockText(b).slice(0, 800));
      } else if (kind === 'reasoning') {
        /* 思考过程不进 transcript，避免干扰审查 */
      } else {
        const t = blockText(b);
        if (t) lines.push('[' + role + '] ' + t);
      }
    }
    if (lines.length) out.push(lines.join('\n'));
  }
  let s = out.join('\n\n');
  if (s.length > maxChars) s = s.slice(-maxChars);
  return s;
}

/** 从事件流抽取最近 N 轮的 transcript（M1 §5.2）。 */
export function extractTranscript(events, { maxTurns = 2, maxChars = 24000 } = {}) {
  const turns = [];
  let cur = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'turn/start') {
      cur = { turn: e.data && e.data.turn, lines: [] };
      turns.push(cur);
    } else if (cur) {
      if (e.type === 'user/message') {
        const content = (e.data && e.data.content) || [];
        const text = content.map((c) => blockText(c)).join('\n').trim();
        if (text) cur.lines.push({ role: 'user', text });
      } else if (e.type === 'assistant/message') {
        const content = (e.data && e.data.message && e.data.message.content) || [];
        const text = content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n').trim();
        if (text) cur.lines.push({ role: 'assistant', text });
        for (const c of content) {
          if (c && c.type === 'tool-call') cur.lines.push({ role: 'tool-call', text: String(c.name || 'tool') + ' ' + String(c.arguments || '').slice(0, 200) });
        }
      } else if (e.type === 'tool/result') {
        const content = (e.data && e.data.message && e.data.message.content) || [];
        const text = content.map((c) => blockText(c)).join('\n').trim();
        if (text) cur.lines.push({ role: 'tool-result', text: text.slice(0, 600) });
      }
    }
  }
  const picked = turns.slice(-maxTurns);
  let out = '';
  for (const t of picked) {
    out += '\n### turn ' + t.turn + '\n';
    for (const l of t.lines) out += '[' + l.role + '] ' + l.text + '\n';
  }
  if (out.length > maxChars) out = out.slice(-maxChars);
  return { text: out, turns: picked.map((t) => t.turn) };
}

/** 队列 transcript 优选：transcript 字符串（≥200 字符）→ messages 渲染 → 空串。 */
export function queueTranscript(queue) {
  const t = typeof queue.transcript === 'string' ? queue.transcript.trim() : '';
  if (t.length >= 200) return { text: t, source: 'queue.transcript' };
  const rendered = renderMessages(queue.messages);
  return { text: rendered, source: rendered ? 'queue.messages' : 'none' };
}

/** 事件流里最近 n 条用户输入原文（用于尾部截断把用户诉求截掉时补回）。 */
export function recentUserMessages(events, n = 2) {
  const out = [];
  for (const e of events) {
    if (!e || e.type !== 'user/message') continue;
    const content = (e.data && e.data.content) || [];
    const text = content.map((c) => blockText(c)).join('\n').trim();
    if (text) out.push(text.slice(0, 3000));
  }
  return out.slice(-n);
}

/** 数用户发言行（[user] 开头且不是 tool-result）。 */
export function countUserLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => /^\[user\]/.test(l.trim())).length;
}

/** 从 transcript 的 "### turn N" 标记抽 turn 号。 */
export function turnsFromTranscript(text) {
  const out = [];
  const re = /###\s*turn\s+(\d+)/g;
  let m;
  while ((m = re.exec(text || '')) !== null) out.push(Number(m[1]));
  return out;
}

/** 事件流里最后一个轮次号（优先 turn/end）。 */
export function lastTurnFromEvents(events) {
  let last = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'turn/end' || e.type === 'turn/start') {
      const n = e.data && e.data.turn;
      if (typeof n === 'number') last = n;
    }
  }
  return last;
}
