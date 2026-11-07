// lib/llm.mjs — DeepSeek 凭证 + chat 调用（超时/重试/JSON 容错解析）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CREDENTIALS = path.join(os.homedir(), '.dsh', '.credentials.yaml');
export const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_MODEL = 'deepseek-chat';

export class LLMError extends Error {
  constructor(message, { attempts = 0, cause = null } = {}) {
    super(message);
    this.name = 'LLMError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

/** 从明文 credentials.yaml 正则取 DEEPSEEK_API_KEY（不引 YAML 库）。 */
export function readApiKey(credentialsFile = DEFAULT_CREDENTIALS) {
  const text = fs.readFileSync(credentialsFile, 'utf8');
  const m = text.match(/DEEPSEEK_API_KEY:\s*([^\s"']+)/);
  if (!m) throw new Error('DEEPSEEK_API_KEY not found in ' + credentialsFile);
  return m[1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FENCE = String.fromCharCode(96, 96, 96);

/** 容忍 markdown 围栏 / 前后废话，抠出第一个 JSON 对象。 */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('extractJson: not a string');
  let s = text.trim();
  if (s.startsWith(FENCE)) {
    const lines = s.split(/\r?\n/);
    if (lines.length && lines[0].trim().startsWith(FENCE)) lines.shift();
    if (lines.length && lines[lines.length - 1].trim().startsWith(FENCE)) lines.pop();
    s = lines.join('\n').trim();
  }
  try { return JSON.parse(s); } catch { /* 继续尝试 */ }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error('no parsable JSON object in model output: ' + s.slice(0, 200));
}

/**
 * 调 DeepSeek chat/completions，要求 JSON 输出。
 * 90s/次超时，最多 2 次重试（2s/6s 退避），整体 180s 预算（deadlineAt 可覆盖）。
 */
export async function chatJson({
  prompt,
  system,
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  reasoningEffort = null,
  temperature = 0.2,
  maxTokens = 3000,
  timeoutMs = 90000,
  retries = 2,
  backoffMs = [2000, 6000],
  totalMs = 180000,
  deadlineAt = null,
  fetchImpl = fetch,
} = {}) {
  if (!prompt) throw new LLMError('empty prompt');
  if (!apiKey) apiKey = readApiKey();

  const started = Date.now();
  const deadline = deadlineAt || started + totalMs;
  const body = {
    model,
    temperature,
    max_tokens: maxTokens,
    // OpenAI 兼容字段：思考强度。'off' 表示不传，交给服务端默认。
    ...(reasoningEffort && reasoningEffort !== 'off' ? { reasoning_effort: reasoningEffort } : {}),
    response_format: { type: 'json_object' },
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
  };

  let lastErr = null;
  const maxAttempts = retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) {
      lastErr = new LLMError('overall deadline exceeded before attempt ' + attempt, { attempts: attempt - 1, cause: lastErr });
      break;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(new Error('llm timeout after ' + Math.min(timeoutMs, remaining) + 'ms')); } catch { /* noop */ } }, Math.min(timeoutMs, remaining));
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('bad response JSON: ' + String(e) + ' body=' + text.slice(0, 200)); }
      const choice = (data.choices && data.choices[0]) || null;
      const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
      if (!content) throw new Error('empty completions content (finish_reason=' + (choice && choice.finish_reason) + ', max_tokens=' + body.max_tokens + ')');
      if (choice && choice.finish_reason === 'length') {
        throw new Error('output truncated by max_tokens=' + body.max_tokens + ' (finish_reason=length) — 请提高 maxTokens 或缩短 prompt');
      }
      const json = extractJson(content);
      const usage = data.usage || {};
      return {
        json,
        raw: content,
        model: data.model || model,
        finishReason: choice.finish_reason || null,
        usage: {
          in: Number(usage.prompt_tokens || 0),
          out: Number(usage.completion_tokens || 0),
          total: Number(usage.total_tokens || (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0))),
        },
        attempts: attempt,
        ms: Date.now() - started,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        const wait = backoffMs[attempt - 1] != null ? backoffMs[attempt - 1] : 6000;
        if (Date.now() + wait >= deadline) break;
        await sleep(wait);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new LLMError('llm call failed after ' + maxAttempts + ' attempts: ' + String(lastErr && lastErr.message ? lastErr.message : lastErr), { attempts: maxAttempts, cause: lastErr });
}
