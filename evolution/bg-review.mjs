#!/usr/bin/env node
// bg-review.mjs — 后台技能审查器（M1 核心 + M3 队列入口）
// 入口：
//   --queue-file <path>   插件主路径：跳过 M1 频率闸门，只做幂等 + 最小内容门槛
//   --session-id <id>     手动/兼容路径：多帧 zstd 会话日志
//   --force               绕过幂等/频率限制
//   --dry-run             只打印，不写 drafts/ledger/state（仍写 last-result 便于观测）
//   --trigger plugin|stop|manual  仅记录
// 退出码恒 0（任何异常都吞掉并写 review/last-result.json）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chatJson, DEFAULT_MODEL } from './lib/llm.mjs';
import { resolveReviewTarget } from './lib/review-config.mjs';
import {
  findSessionFile,
  readSessionFile,
  extractTranscript,
  queueTranscript,
  countUserLines,
  recentUserMessages,
  lastTurnFromEvents,
  DEFAULT_SESSIONS_ROOT,
} from './lib/session.mjs';
import { appendLedger, sha256, newId } from './lib/ledger.mjs';
import { buildStage1Prompt, buildCreatePrompt, buildPatchPrompt, buildReviewPrompt } from './lib/prompt.mjs';
import { loadSkillIndex, renderIndexForPrompt, readSkillFull, applyEdits, validateSkillText, writeSkillSafely } from './lib/skills-index.mjs';
import { maybeRunCurator } from './lib/curator.mjs';
import { bumpPatch } from './lib/skill-usage.mjs';

const EVOLUTION_DIR = process.env.DSH_EVOLUTION_DIR || path.join(os.homedir(), '.dsh', 'evolution');
const REVIEW_DIR = path.join(EVOLUTION_DIR, 'review');
const QUEUE_DIR = path.join(REVIEW_DIR, 'queue');
const DRAFTS_DIR = path.join(EVOLUTION_DIR, 'drafts');
const LEDGER_FILE = path.join(EVOLUTION_DIR, 'ledger.jsonl');
const STATE_FILE = path.join(REVIEW_DIR, 'state.json');
const RESULT_FILE = path.join(REVIEW_DIR, 'last-result.json');
const LOG_FILE = path.join(REVIEW_DIR, 'bg-review.log');

const MIN_TRANSCRIPT_CHARS = 600;
const MIN_USER_MESSAGES = 2;
const MIN_SESSION_EVENTS = 40;
const STOP_EVERY = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const DAILY_CAP = 6;
const DRAFT_MIN_CONFIDENCE = 0.6;
const LOG_MAX_BYTES = 1024 * 1024;
const TRUNCATE_KEEP_BYTES = 256 * 1024;

// ---------- 基础工具 ----------
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }

function appendLog(line) {
  try {
    ensureDir(REVIEW_DIR);
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) {
        const buf = fs.readFileSync(LOG_FILE);
        let tail = buf.subarray(Math.max(0, buf.length - TRUNCATE_KEEP_BYTES));
        const nl = tail.indexOf(0x0a);
        if (nl >= 0) tail = tail.subarray(nl + 1);
        fs.writeFileSync(LOG_FILE, '--- log rotated at ' + new Date().toISOString() + ' ---\n' + tail.toString('utf8'), 'utf8');
      }
    } catch { /* 日志文件不存在 */ }
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n', 'utf8');
  } catch { /* 日志失败也不能影响退出码 */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

function parseArgs(argv) {
  const opts = { queueFile: null, sessionId: null, force: false, dryRun: false, trigger: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inlineVal = eq > 0 ? a.slice(eq + 1) : null;
    const nextVal = () => (inlineVal != null ? inlineVal : argv[++i]);
    if (name === '--queue-file') opts.queueFile = nextVal();
    else if (name === '--session-id') opts.sessionId = nextVal();
    else if (name === '--force') opts.force = true;
    else if (name === '--dry-run') opts.dryRun = true;
    else if (name === '--trigger') opts.trigger = nextVal();
    else if (name === '--help' || name === '-h') opts.help = true;
  }
  if (!opts.trigger) opts.trigger = opts.queueFile ? 'plugin' : 'manual';
  return opts;
}

// ---------- 幂等 / 状态 ----------
function isDuplicate(state, sessionId, turn) {
  if (!state || !sessionId) return false;
  const lr = state.lastReviewed;
  if (lr && String(lr.session) === String(sessionId) && String(lr.turn) === String(turn)) return true;
  const recent = Array.isArray(state.recent) ? state.recent : [];
  return recent.some((r) => r && String(r.session) === String(sessionId) && String(r.turn) === String(turn));
}

function markReviewed(state, sessionId, turn, extra) {
  const at = new Date().toISOString();
  state.lastReviewed = { session: sessionId, turn, at };
  const recent = Array.isArray(state.recent) ? state.recent : [];
  recent.unshift({ session: sessionId, turn, at, decision: extra && extra.decision });
  state.recent = recent.slice(0, 100);
  state.lastReviewAt = at;
  const day = localDayKey();
  if (state.dayKey !== day) { state.dayKey = day; state.dayCount = 0; }
  state.dayCount = Number(state.dayCount || 0) + 1;
  return state;
}

// ---------- 草稿/账本 ----------
function sanitizeSlug(input) {
  let s = String(input == null ? '' : input).toLowerCase().trim();
  s = s.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 60);
}

function fm(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 200);
}

function renderDraft(obj, meta) {
  const lines = [
    '---',
    'name: ' + fm(obj.skill, 100),
    'description: ' + fm(obj.description, 300),
    'whenToUse: ' + fm(obj.whenToUse, 300),
    'createdBy: bg-review',
    'createdAt: ' + meta.at,
    'evidence: ' + fm(obj.evidence, 200),
    'confidence: ' + meta.confidence,
    'status: draft',
    '---',
    '',
    '# ' + fm(obj.title || obj.skill, 200),
    '',
    String(obj.body || '').trim(),
    '',
  ];
  return lines.join('\n');
}

function renderSupplement(obj, meta) {
  return [
    '',
    '',
    '## 补充证据 ' + meta.date,
    '',
    '- confidence: ' + meta.confidence,
    '- 来源: session ' + meta.sessionId + ' / turn ' + meta.turn + ' / trigger ' + meta.trigger,
    '- 证据: ' + fm(obj.evidence, 400),
    '',
  ].join('\n');
}

// ---------- 主流程 ----------
const result = {
  at: new Date().toISOString(),
  trigger: 'manual',
  sessionId: null,
  turn: null,
  decision: null,
  reason: '',
  tokens: { in: 0, out: 0 },
  model: DEFAULT_MODEL,
};

let finished = false;
function finalize(partial, opts) {
  if (finished) return;
  finished = true;
  Object.assign(result, partial || {});
  if (opts && opts.dryRun) result.dryRun = true;
  try { writeJson(RESULT_FILE, result); } catch (e) { appendLog('FATAL write last-result: ' + String(e && e.message ? e.message : e)); }
  try { appendLog('finish ' + JSON.stringify({ decision: result.decision, sessionId: result.sessionId, turn: result.turn, tokens: result.tokens, error: result.error || null, skipped: result.skipped || null })); } catch { /* ignore */ }
}

function deleteQueue(file) {
  try { if (file) fs.unlinkSync(file); } catch { /* ignore */ }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  result.trigger = opts.trigger;
  appendLog('start ' + JSON.stringify({ queueFile: opts.queueFile, sessionId: opts.sessionId, force: opts.force, dryRun: opts.dryRun, trigger: opts.trigger, evolutionDir: EVOLUTION_DIR }));

  if (opts.help) {
    console.log('用法: node bg-review.mjs [--queue-file <path>] [--session-id <id>] [--force] [--dry-run] [--trigger plugin|stop|manual]');
    return finalize({ decision: 'skipped', skipped: 'help', reason: 'help printed' }, opts);
  }

  ensureDir(REVIEW_DIR);
  ensureDir(QUEUE_DIR);
  ensureDir(DRAFTS_DIR);

  const state = readJson(STATE_FILE) || {};

  try {
    // ---------- 1. 取 transcript ----------
    let transcript = '';
    let transcriptSource = 'none';
    let sessionId = opts.sessionId ? String(opts.sessionId) : null;
    let turn = null;
    let turns = [];
    let queueFile = null;
    let events = null;

    if (opts.queueFile) {
      queueFile = path.resolve(opts.queueFile);
      result.queueFile = queueFile;
      let raw;
      try {
        raw = fs.readFileSync(queueFile, 'utf8');
      } catch (e) {
        return finalize({ decision: 'error', error: 'queue-file-unreadable: ' + String(e && e.message ? e.message : e), reason: 'cannot read queue file' }, opts);
      }
      let queue;
      try {
        queue = JSON.parse(raw);
      } catch (e) {
        return finalize({ decision: 'error', error: 'bad-queue-json: ' + String(e && e.message ? e.message : e), reason: 'queue file is not valid JSON', queueFile }, opts);
      }
      sessionId = queue.sessionId != null ? String(queue.sessionId) : sessionId;
      turn = Number.isFinite(Number(queue.turn)) ? Number(queue.turn) : null;
      const qt = queueTranscript(queue);
      transcript = qt.text || '';
      transcriptSource = qt.source;

      // 幂等（重复 session+turn 只处理一次）
      if (!opts.force && isDuplicate(state, sessionId, turn)) {
        deleteQueue(queueFile);
        return finalize({ decision: 'skipped', skipped: 'duplicate', reason: 'same session+turn already reviewed', sessionId, turn, transcriptSource, transcriptChars: transcript.length }, opts);
      }
      // 内容门槛
      const userLines = countUserLines(transcript);
      if (transcript.length < MIN_TRANSCRIPT_CHARS || userLines < MIN_USER_MESSAGES) {
        deleteQueue(queueFile);
        return finalize({
          decision: 'skipped', skipped: 'transcript-too-short',
          reason: 'transcript too short: ' + transcript.length + ' chars / ' + userLines + ' user messages (need >= ' + MIN_TRANSCRIPT_CHARS + ' chars and >= ' + MIN_USER_MESSAGES + ')',
          sessionId, turn, transcriptSource, transcriptChars: transcript.length, userLines,
        }, opts);
      }
      result.sessionId = sessionId;
      result.turn = turn;
      result.transcriptSource = transcriptSource;
      result.transcriptChars = transcript.length;
    } else if (opts.sessionId) {
      const found = findSessionFile(opts.sessionId, DEFAULT_SESSIONS_ROOT);
      if (!found) {
        return finalize({ decision: 'skipped', skipped: 'session-file-not-found', reason: 'no session.v4.jsonl.zstd for id ' + opts.sessionId, sessionId: opts.sessionId }, opts);
      }
      events = readSessionFile(found);
      result.sessionFile = found;
      result.eventCount = events.length;
      const sessionLastTurn = lastTurnFromEvents(events);
      if (events.length < MIN_SESSION_EVENTS) {
        return finalize({ decision: 'skipped', skipped: 'too-few-events', reason: 'events ' + events.length + ' < ' + MIN_SESSION_EVENTS + ' (M1 §5.1)', sessionId: opts.sessionId, turn: sessionLastTurn, transcriptSource: 'session-events' }, opts);
      }

      // M1 频率闸门：只在 hook（trigger=stop）路径生效，manual 是显式人工触发
      if (opts.trigger === 'stop' && !opts.force) {
        state.stops = Number(state.stops || 0) + 1;
        if (state.stops % STOP_EVERY !== 0) {
          try { writeJson(STATE_FILE, state); } catch { /* ignore */ }
          return finalize({ decision: 'skipped', skipped: 'stop-throttle', reason: 'stop #' + state.stops + ' not multiple of ' + STOP_EVERY, sessionId: opts.sessionId, turn: sessionLastTurn, transcriptSource: 'session-events' }, opts);
        }
        if (state.lastReviewAt && Date.now() - Date.parse(state.lastReviewAt) < COOLDOWN_MS) {
          try { writeJson(STATE_FILE, state); } catch { /* ignore */ }
          return finalize({ decision: 'skipped', skipped: 'cooldown', reason: 'within 30min cooldown of ' + state.lastReviewAt, sessionId: opts.sessionId, turn: sessionLastTurn, transcriptSource: 'session-events' }, opts);
        }
        const day = localDayKey();
        if (state.dayKey === day && Number(state.dayCount || 0) >= DAILY_CAP) {
          try { writeJson(STATE_FILE, state); } catch { /* ignore */ }
          return finalize({ decision: 'skipped', skipped: 'daily-cap', reason: 'daily cap ' + DAILY_CAP + ' reached', sessionId: opts.sessionId, turn: sessionLastTurn, transcriptSource: 'session-events' }, opts);
        }
      }

      // 从事件构造 transcript；用户消息不足时放宽到更多轮
      let ex = extractTranscript(events, { maxTurns: 2, maxChars: 24000 });
      if (countUserLines(ex.text) < MIN_USER_MESSAGES) {
        const ex4 = extractTranscript(events, { maxTurns: 4, maxChars: 24000 });
        if (countUserLines(ex4.text) > countUserLines(ex.text)) ex = ex4;
        if (countUserLines(ex.text) < MIN_USER_MESSAGES) {
          const ex8 = extractTranscript(events, { maxTurns: 8, maxChars: 24000 });
          if (countUserLines(ex8.text) > countUserLines(ex.text)) ex = ex8;
        }
      }
      transcript = ex.text || '';
      // 尾部截断可能把用户诉求挤掉（长工具循环时）：从更早用户消息补回来，保证审查有意图可依据
      if (countUserLines(transcript) < MIN_USER_MESSAGES) {
        const earlyUsers = recentUserMessages(events, 2);
        if (earlyUsers.length) {
          const header = '### 更早的用户输入\n' + earlyUsers.map((t) => '[user] ' + t).join('\n') + '\n';
          const room = Math.max(1000, 24000 - header.length);
          transcript = header + transcript.slice(-room);
        }
      }
      turns = ex.turns || [];
      turn = lastTurnFromEvents(events);
      if (turn == null && turns.length) turn = turns[turns.length - 1];
      transcriptSource = 'session-events';

      if (transcript.length < MIN_TRANSCRIPT_CHARS || countUserLines(transcript) < MIN_USER_MESSAGES) {
        return finalize({
          decision: 'skipped', skipped: 'transcript-too-short',
          reason: 'transcript too short: ' + transcript.length + ' chars / ' + countUserLines(transcript) + ' user messages',
          sessionId, turn, transcriptSource, transcriptChars: transcript.length, userLines: countUserLines(transcript),
        }, opts);
      }

      // 幂等
      if (!opts.force && isDuplicate(state, sessionId, turn)) {
        return finalize({ decision: 'skipped', skipped: 'duplicate', reason: 'same session+turn already reviewed', sessionId, turn, transcriptSource, transcriptChars: transcript.length }, opts);
      }

      result.sessionId = sessionId;
      result.turn = turn;
      result.transcriptSource = transcriptSource;
      result.transcriptChars = transcript.length;
      result.userLines = countUserLines(transcript);
      result.turns = turns;
    } else {
      return finalize({ decision: 'error', error: 'no-input', reason: 'need --queue-file or --session-id' }, opts);
    }

    if (!turns.length) {
      const m = /###\s*turn\s+(\d+)/g;
      let mm;
      while ((mm = m.exec(transcript)) !== null) turns.push(Number(mm[1]));
    }
    if (turn == null && turns.length) turn = turns[turns.length - 1];
    result.turn = turn;

    appendLog('transcript ' + JSON.stringify({ source: transcriptSource, chars: transcript.length, userLines: countUserLines(transcript), turns, turn }));

    if (opts.dryRun) {
      console.log('[dry-run] trigger=' + opts.trigger + ' session=' + sessionId + ' turn=' + turn);
      console.log('[dry-run] transcript source=' + transcriptSource + ' chars=' + transcript.length + ' userLines=' + countUserLines(transcript));
      console.log('[dry-run] turns=' + JSON.stringify(turns));
      console.log('[dry-run] transcript 预览(尾部 400 字):\n' + transcript.slice(-400));
    }

    // ---------- 2. 第一段：只带技能库清单，决定 none / create / patch ----------
    // 审查走「跟随主提供商 + 主模型」：目标模型、端点、密钥、思考强度统一由 review-config 解析。
    const target = resolveReviewTarget();
    result.reviewTarget = {
      provider: target.provider,
      model: target.model,
      endpoint: target.endpoint,
      reasoningEffort: target.reasoningEffort,
      viaReasoning: target.viaReasoning,
      source: target.source,
      problems: target.problems,
    };
    appendLog('review-target ' + JSON.stringify({
      provider: target.provider, model: target.model, endpoint: target.endpoint,
      reasoningEffort: target.reasoningEffort, viaReasoning: target.viaReasoning,
      source: target.source, problems: target.problems,
    }));
    result.model = target.model;
    if (target.problems.length > 0) console.log('[review-target] ' + target.problems.join(' | '));
    if (!target.apiKey) {
      return finalize({ decision: 'error', error: 'no-api-key: ' + target.problems.join('; '), reason: 'cannot resolve review model credentials' }, opts);
    }
    const apiKey = target.apiKey;

    const WRITE_MIN_CONFIDENCE = 0.7;
    const index = loadSkillIndex(LEDGER_FILE);
    const indexText = renderIndexForPrompt(index);
    result.skillCount = index.length;

    if (opts.dryRun) {
      console.log('[dry-run] 审查目标: provider=' + target.provider + ' model=' + target.model + ' endpoint=' + target.endpoint);
      console.log('[dry-run] 思考强度: ' + (target.viaReasoning ? target.reasoningEffort + ' (reasoning_effort)' : '不发送') + ' | 来源=' + JSON.stringify(target.source));
      console.log('[dry-run] 不调用模型、不写库。技能库条数=' + index.length);
      console.log('[dry-run] 清单预览(前15行):');
      console.log(indexText.split('\n').slice(0, 15).join('\n'));
      return finalize({ decision: 'dry-run', reason: 'dry-run: 未调用模型', skillCount: index.length, sessionId, turn, transcriptSource }, opts);
    }

    // 维护层：每天最多一次，归档 90 天没动过的自沉淀技能（永不真删）
    try {
      const cur = maybeRunCurator({ evolutionDir: EVOLUTION_DIR, skillsIndex: index, state, persist: (s) => writeJson(STATE_FILE, s) });
      if (cur.ran && cur.counts) {
        appendLog('curator: ' + JSON.stringify({ counts: cur.counts, archived: cur.archived.map((a) => a.slug) }));
        for (const a of cur.archived) {
          appendLedger(LEDGER_FILE, { id: newId(8), ts: new Date().toISOString(), actor: 'curator', action: 'archive', skill: a.slug, reason: '超过归档阈值无真实使用记录', file: path.relative(EVOLUTION_DIR, a.to) });
        }
      }
    } catch (e) {
      appendLog('curator failed: ' + String(e && e.message ? e.message : e));
    }

    const stage1Prompt = buildStage1Prompt({ transcript, indexText });
    let res1;
    try {
      res1 = await chatJson({
        prompt: stage1Prompt, apiKey, endpoint: target.endpoint, model: target.model,
        reasoningEffort: target.viaReasoning ? target.reasoningEffort : null, temperature: 0.2,
        maxTokens: 8000, timeoutMs: 90000, retries: 2, backoffMs: [2000, 6000], totalMs: 180000,
      });
    } catch (e) {
      return finalize({ decision: 'error', error: 'stage1-llm-failed: ' + String(e && e.message ? e.message : e), reason: 'stage1 model call failed', sessionId, turn, transcriptSource }, opts);
    }
    result.model = res1.model;
    result.tokens = { in: res1.usage.in, out: res1.usage.out };
    result.stage1 = { attempts: res1.attempts, ms: res1.ms, tokens: { in: res1.usage.in, out: res1.usage.out } };

    const d1 = (res1.json || {});
    const action = ['none', 'create', 'patch'].includes(String(d1.action)) ? String(d1.action) : 'none';
    const conf = Number.isFinite(Number(d1.confidence)) ? Number(d1.confidence) : 0;
    const reason = fm(d1.reason || '', 300);
    const evidence = fm(d1.evidence || '', 400);
    result.stage1Decision = { action, target: fm(d1.target, 80), confidence: conf, reason };

    const finishSkip = (skipped, extra) => {
      if (!opts.dryRun) {
        if (queueFile) deleteQueue(queueFile);
        markReviewed(state, sessionId, turn, { decision: 'skipped-' + skipped });
        writeJson(STATE_FILE, state);
      }
      console.log('[decision] skipped(' + skipped + ') — ' + ((extra && extra.reason) || reason));
      return finalize(Object.assign({ decision: 'skipped', skipped, sessionId, turn, transcriptSource, confidence: conf }, extra || {}), opts);
    };

    const finishNone = (note) => {
      if (!opts.dryRun) {
        if (queueFile) deleteQueue(queueFile);
        markReviewed(state, sessionId, turn, { decision: note === 'low-confidence' ? 'skipped-low-confidence' : 'none' });
        writeJson(STATE_FILE, state);
      }
      console.log('[decision] none — ' + (reason || 'no reusable signal'));
      return finalize({
        decision: note === 'low-confidence' ? 'skipped' : 'none', skipped: note === 'low-confidence' ? 'low-confidence' : undefined,
        reason: reason || 'model found no reusable skill signal', confidence: conf, sessionId, turn, transcriptSource,
      }, opts);
    };

    if (action === 'none') return finishNone('none');
    if (conf < WRITE_MIN_CONFIDENCE) {
      appendLog('stage1 confidence ' + conf + ' < ' + WRITE_MIN_CONFIDENCE + ' → 放弃直接写库');
      return finishNone('low-confidence');
    }
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(String(d1.target || ''))) {
      return finishSkip('bad-target', { reason: 'target is not a valid kebab-case slug: ' + fm(d1.target, 80) });
    }

    // ---------- 3. 闸门：归属 / 新建还是改 / 写前读 ----------
    let mode = action;
    let targetSlug = String(d1.target);
    let targetEntry = index.find((e) => e.slug === targetSlug) || null;

    // Hermes 偏好顺序：同名已存在 → 优先改，不新建
    if (mode === 'create' && targetEntry) {
      mode = 'patch';
      appendLog('create 与既有技能同名，降级为 patch: ' + targetSlug);
    }
    if (mode === 'patch' && !targetEntry) {
      mode = 'create';
      appendLog('patch 目标不存在，降级为 create: ' + targetSlug);
    }
    if (mode !== 'create' && targetEntry && targetEntry.owner !== 'agent') {
      // 归属拒写（对齐 Hermes 的 protected skills）
      const row = { id: newId(8), ts: new Date().toISOString(), actor: 'bg-review', action: 'refuse', skill: targetSlug,
        reason: 'owner=' + targetEntry.owner + '，非自沉淀技能不允许自动改写', session: sessionId, turn, evidence: evidence.slice(0, 300) };
      appendLedger(LEDGER_FILE, row);
      console.log('[decision] refuse — ' + targetSlug + ' 归属 ' + targetEntry.owner);
      return finalize({ decision: 'refused', skipped: 'not-agent-owned', skill: targetSlug, owner: targetEntry.owner,
        reason: '该技能归属为 ' + targetEntry.owner + '，不自动改写；需要的话请让我手动改', sessionId, turn, transcriptSource }, opts);
    }

    let oldText = null;
    if (mode === 'patch') {
      const full = readSkillFull(targetEntry.file);
      if (!full) return finalize({ decision: 'error', error: 'cannot read target skill', reason: targetEntry.file, sessionId, turn }, opts);
      oldText = full.text;
    }

    // ---------- 4. 第二段：产出内容 ----------
    let res2;
    try {
      res2 = await chatJson({
        prompt: mode === 'create' ? buildCreatePrompt({ transcript, decision: d1 }) : buildPatchPrompt({ skillText: oldText, decision: d1 }),
        apiKey, endpoint: target.endpoint, model: target.model,
        reasoningEffort: target.viaReasoning ? target.reasoningEffort : null, temperature: 0.2, maxTokens: 4000, timeoutMs: 120000,
        retries: 2, backoffMs: [2000, 6000], totalMs: 240000,
      });
    } catch (e) {
      return finalize({ decision: 'error', error: 'stage2-llm-failed: ' + String(e && e.message ? e.message : e), reason: 'stage2 model call failed', sessionId, turn, transcriptSource }, opts);
    }
    result.tokens = { in: result.tokens.in + res2.usage.in, out: result.tokens.out + res2.usage.out };
    result.stage2 = { attempts: res2.attempts, ms: res2.ms, tokens: { in: res2.usage.in, out: res2.usage.out } };

    const d2 = (res2.json || {});
    let newText = null;
    let backupPath = null;

    if (mode === 'create') {
      const content = typeof d2.content === 'string' ? d2.content.trim() : '';
      const v = validateSkillText(content);
      if (!v.ok) return finishSkip('invalid-content', { reason: 'create content rejected: ' + v.error });
      const outFile = path.join(os.homedir(), '.dsh', 'skills', targetSlug, 'SKILL.md');
      backupPath = writeSkillSafely(outFile, content + '\n', path.join(EVOLUTION_DIR, 'skill-backups'));
      result.file = outFile;
      result.sha256 = sha256(content);
      appendLedger(LEDGER_FILE, {
        id: newId(8), ts: new Date().toISOString(), actor: 'bg-review', action: 'promote', skill: targetSlug,
        from: 'inline-review', to: 'skills/' + targetSlug + '/SKILL.md', session: sessionId,
        turns: turns.length ? turns : (turn != null ? [turn] : []),
        reason: reason.slice(0, 200), evidence: evidence.slice(0, 300), sha256: sha256(content),
        model: res2.model || DEFAULT_MODEL, tokens: result.tokens, confidence: conf,
        verified: 'auto', reviewer: 'bg-review', transcriptSource, trigger: opts.trigger,
      });
      bumpPatch(EVOLUTION_DIR, targetSlug);
    } else {
      const edits = Array.isArray(d2.edits) ? d2.edits : [];
      const ap = applyEdits(oldText, edits);
      if (!ap.ok) return finishSkip('patch-not-applicable', { reason: 'patch rejected: ' + ap.error });
      const v = validateSkillText(ap.text, { oldText });
      if (!v.ok) return finishSkip('invalid-patch', { reason: 'patch rejected: ' + v.error });
      backupPath = writeSkillSafely(targetEntry.file, ap.text, path.join(EVOLUTION_DIR, 'skill-backups'));
      result.file = targetEntry.file;
      result.edits = edits.length;
      result.sha256 = sha256(ap.text);
      appendLedger(LEDGER_FILE, {
        id: newId(8), ts: new Date().toISOString(), actor: 'bg-review', action: 'patch', skill: targetSlug,
        file: path.relative(path.join(os.homedir(), '.dsh'), targetEntry.file).replace(/\\\\/g, '/'),
        backup: backupPath ? path.basename(backupPath) : null,
        oldSha: sha256(oldText), newSha: sha256(ap.text), edits: edits.length,
        session: sessionId, turns: turns.length ? turns : (turn != null ? [turn] : []),
        reason: reason.slice(0, 200), evidence: evidence.slice(0, 300),
        model: res2.model || DEFAULT_MODEL, tokens: result.tokens, confidence: conf,
        reviewer: 'bg-review', transcriptSource, trigger: opts.trigger,
      });
      bumpPatch(EVOLUTION_DIR, targetSlug);
    }

    deleteQueue(queueFile);
    markReviewed(state, sessionId, turn, { decision: mode });
    state.lastDraft = null;
    writeJson(STATE_FILE, state);

    console.log('[decision] ' + mode + ' skill=' + targetSlug + ' conf=' + conf + ' → 已落库');
    return finalize({
      decision: mode, skill: targetSlug, confidence: conf, reason, evidence,
      sessionId, turn, transcriptSource, file: result.file, sha256: result.sha256,
      backup: backupPath ? path.basename(backupPath) : null, tokens: result.tokens,
    }, opts);
  } catch (e) {
    return finalize({ decision: 'error', error: String(e && e.stack ? e.stack.slice(0, 1200) : e), reason: 'unexpected exception' }, opts);
  }
}

try {
  await main();
} catch (e) {
  try {
    result.decision = result.decision || 'error';
    result.error = String(e && e.stack ? e.stack.slice(0, 1200) : e);
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}
process.exitCode = 0;
process.exit(0);
