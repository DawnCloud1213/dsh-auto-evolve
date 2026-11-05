// review-config 解析器单测：用临时目录伪造 DSH 配置，验证「跟随主提供商/主模型 + 思考强度可调」。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

import { resolveReviewTarget, completionsEndpoint } from '../evolution/lib/review-config.mjs'

const ROOTS = []
after(() => {
  for (const root of ROOTS) {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function makeHome(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evolve-config-'))
  ROOTS.push(root)
  const profileDir = path.join(root, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  if (options.profile !== false) {
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), options.profile ?? PROFILE_YAML, 'utf8')
  }
  if (options.settings) writeFileSync(path.join(root, 'settings.yaml'), options.settings, 'utf8')
  if (options.credentials) writeFileSync(path.join(root, '.credentials.yaml'), options.credentials, 'utf8')
  return { root, profileDir }
}

const PROFILE_YAML = [
  '# profile patch',
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      cmdcode-goat:',
  '        apiKeyEnv: CMDCODE_GOAT_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://api.commandcode.ai/provider/v1',
  '        reasoning: max',
  '        models:',
  '          - id: deepseek/deepseek-v4.1-flash',
  '            reasoningEfforts:',
  "              'off': null",
  '              high: high',
  '- id: agent-default-model',
  "  name: '@deepseek-ai/dsh-agent-default-model'",
  '  config:',
  '    provider: cmdcode-goat',
  '    model: deepseek/deepseek-v4.1-flash',
  '    reasoningEffort: high',
  '',
].join('\n')

const CREDENTIALS_YAML = [
  'version: 1',
  'refs:',
  '  CMDCODE_GOAT_API_KEY: sk-test-goat',
  '  DEEPSEEK_API_KEY: sk-test-deepseek',
  'records:',
  '  example:',
  '    kind: grant',
  '',
].join('\n')

test('review-config: 默认跟随主提供商/主模型，思考强度 high', () => {
  const { root, profileDir } = makeHome({ credentials: CREDENTIALS_YAML })
  const target = resolveReviewTarget({
    env: { DSH_HOME: root, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: profileDir },
    dshHome: root,
    profileDir,
  })
  assert.equal(target.provider, 'cmdcode-goat')
  assert.equal(target.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(target.endpoint, 'https://api.commandcode.ai/provider/v1/chat/completions')
  assert.equal(target.apiKeyEnv, 'CMDCODE_GOAT_API_KEY')
  assert.equal(target.apiKey, 'sk-test-goat')
  assert.equal(target.reasoningEffort, 'high')
  assert.equal(target.viaReasoning, true, 'provider 声明了 reasoningEfforts，应发送 reasoning_effort')
  assert.deepEqual(target.problems, [])
})

test('review-config: 用户设置文档里的主模型与思考强度覆盖 profile', () => {
  const settings = [
    'agent-default-model:',
    '  provider: cmdcode-goat',
    '  model: deepseek/deepseek-v4.1-flash',
    'auto-evolve:',
    '  reviewReasoningEffort: medium',
    '',
  ].join('\n')
  const { root, profileDir } = makeHome({ settings, credentials: CREDENTIALS_YAML })
  const target = resolveReviewTarget({
    env: { DSH_HOME: root, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: profileDir },
    dshHome: root,
    profileDir,
  })
  assert.equal(target.reasoningEffort, 'medium')
  assert.equal(target.source.reasoning, 'settings')
  assert.equal(target.viaReasoning, true)
})

test('review-config: 关掉思考强度时不发送 reasoning_effort', () => {
  const settings = ['auto-evolve:', '  reviewReasoningEffort: off', ''].join('\n')
  const { root, profileDir } = makeHome({ settings, credentials: CREDENTIALS_YAML })
  const target = resolveReviewTarget({
    env: { DSH_HOME: root, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: profileDir },
    dshHome: root,
    profileDir,
  })
  assert.equal(target.reasoningEffort, 'off')
  assert.equal(target.viaReasoning, false)
})

test('review-config: 环境变量覆盖优先', () => {
  const { root, profileDir } = makeHome({ credentials: CREDENTIALS_YAML })
  const target = resolveReviewTarget({
    env: {
      DSH_HOME: root,
      DSH_PROFILE: 'desktop',
      DSH_PROFILE_DIR: profileDir,
      DSH_REVIEW_MODEL: 'custom/model',
      DSH_REVIEW_REASONING_EFFORT: 'low',
    },
    dshHome: root,
    profileDir,
  })
  assert.equal(target.model, 'custom/model')
  assert.equal(target.source.model, 'env')
  assert.equal(target.reasoningEffort, 'low')
  assert.equal(target.source.reasoning, 'env')
})

test('review-config: 没有 profile 配置时回退 deepseek-chat（并带问题说明）', () => {
  const { root, profileDir } = makeHome({ profile: false, credentials: CREDENTIALS_YAML })
  const target = resolveReviewTarget({
    env: { DSH_HOME: root, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: profileDir },
    dshHome: root,
    profileDir,
  })
  assert.equal(target.provider, 'deepseek')
  assert.equal(target.model, 'deepseek-chat')
  assert.equal(target.endpoint, 'https://api.deepseek.com/chat/completions')
  assert.equal(target.apiKey, 'sk-test-deepseek')
  assert.ok(target.problems.some((p) => p.includes('agent-default-model')), '应说明回退原因')
})

test('review-config: completionsEndpoint 拼接规则', () => {
  assert.equal(
    completionsEndpoint('https://api.commandcode.ai/provider/v1'),
    'https://api.commandcode.ai/provider/v1/chat/completions',
  )
  assert.equal(
    completionsEndpoint('https://x.example/v1/chat/completions'),
    'https://x.example/v1/chat/completions',
  )
  assert.equal(completionsEndpoint(''), 'https://api.deepseek.com/chat/completions')
})
