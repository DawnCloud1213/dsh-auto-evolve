// @dawn/dsh-auto-evolve 导入冒烟:模块能被 import,导出契约齐全(不导出 Config)。
// 运行: node test/import-smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'auto-evolve', 'name 必须是 auto-evolve')
assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
assert.equal(typeof mod.apply, 'function', 'apply 必须是函数')
assert.equal('Config' in mod, false, '本插件不导出 Config(默认值手写合并)')

// 静态依赖检查:只允许 node: 内置模块 + 包内相对路径(避免 pnpm file: 解析不到裸包名)
const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
for (const line of source.split(/\r?\n/)) {
  const matched = /^\s*import\s[^\n]*\bfrom\s+['"]([^'"]+)['"]/.exec(line)
  if (!matched) continue
  const spec = matched[1]
  const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')
  assert.ok(ok, '静态 import 只允许 node: 内置模块或包内相对路径,发现: ' + spec)
}
// v0.2.0 起不再伪造用户消息:必须没有 dsh-llm 的运行时依赖
assert.equal(source.includes('@deepseek-ai/dsh-llm'), false, '不再依赖 dsh-llm 构造用户消息')
assert.ok(source.includes("ctx.on('system-prompt/assemble'"), '草稿提醒走运行时上下文快照')

// apply 用最小 ctx 跑一遍(evolutionDir 指向 tmp,绝不写真实目录)
const root = mkdtempSync(path.join(tmpdir(), 'dsh-auto-evolve-smoke-'))
try {
  const handlers = []
  const ctx = { logger: { warn: () => {} }, on: (event) => { handlers.push(event); return () => {} }, effect: (fn) => { fn() } }
  mod.apply(ctx, { evolutionDir: path.join(root, 'evolution') })
  assert.deepEqual(handlers.sort(), ['agent/pre-step', 'agent/session-start', 'agent/turn-stopping', 'system-prompt/assemble'])
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('import-smoke OK: name/inject/apply 齐全,无外部静态依赖')
