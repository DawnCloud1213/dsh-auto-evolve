// lib/ledger.mjs — 账本 append（append-only JSONL）+ 文件 sha256 + 随机 id
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newId(len = 8) {
  const hex = crypto.randomBytes(Math.ceil(len / 2) + 1).toString('hex');
  return hex.slice(0, len);
}

/** append-only：每行一个 JSON，写前确保目录存在。 */
export function appendLedger(ledgerFile, entry) {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const line = JSON.stringify(entry);
  fs.appendFileSync(ledgerFile, line + '\n', 'utf8');
  return line;
}

/** 读回账本（验证/统计用，坏行跳过）。 */
export function readLedger(ledgerFile) {
  try {
    return fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
