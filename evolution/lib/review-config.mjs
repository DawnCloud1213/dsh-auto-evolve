// lib/review-config.mjs — 解析「后台审查用哪个模型」的唯一入口
//
// 设计目标：
//   1. 默认**跟随 DSH 主提供商与主模型**，不要偷偷另开一条 DeepSeek 官方 API（那会扣用户另一个账号的余额）；
//   2. 思考强度可调（默认 high），用户在 DSH 桌面端「插件配置」卡片里改；
//   3. 所有内容都有兜底：读不到配置时退回老行为（deepseek-chat + DEEPSEEK_API_KEY），并把来源写进结果里。
//
// 解析优先级（高 → 低）：
//   环境变量覆盖：
//     DSH_REVIEW_PROVIDER / DSH_REVIEW_MODEL / DSH_REVIEW_BASE_URL / DSH_REVIEW_ENDPOINT
//     DSH_REVIEW_API_KEY / DSH_REVIEW_API_KEY_ENV / DSH_REVIEW_REASONING_EFFORT
//   用户设置文档 ~/.dsh/settings.yaml（DSH 里改过的东西）：
//     agent-default-model.provider / .model / .reasoningEffort
//     auto-evolve.reviewReasoningEffort
//   profile 组合配置 profiles/<profile>/cordis.patch.yml：
//     - id: agent-default-model 的 provider / model / reasoningEffort
//     - id: llm-pi-ai 的 providers.<provider>.baseURL / api / apiKeyEnv
//   兜底：DeepSeek 官方 deepseek-chat + DEEPSEEK_API_KEY
//
// 只读不写；任何解析失败都记录到 problems 里由调用方决定怎么报，绝不抛出。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const OFFICIAL_DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const LEGACY_MODEL = 'deepseek-chat'
export const DEFAULT_REASONING_EFFORT = 'high'
export const REVIEW_SETTINGS_NS = 'auto-evolve'
export const MAIN_MODEL_SETTINGS_NS = 'agent-default-model'

/** 读文本文件，读不到返回 ''。 */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 去引号并 trim。 */
function cleanValue(raw) {
  if (typeof raw !== 'string') return ''
  let v = raw.trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1)
  }
  const hash = v.search(/\s+#/)
  if (hash >= 0) v = v.slice(0, hash).trim()
  return v
}

/** 找到形如 `- id: xxx` 或 `- name: '@scope/pkg'` 的条目，返回 [起, 止) 行号；找不到 [-1, -1]。 */
function findEntryRange(lines, matcher) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const m = /^(\s*)-\s+(?:id|name):\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    if (!matcher.includes(cleanValue(m[2]))) continue
    const dashIndent = m[1].length
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(\s*)-\s+\S/.exec(lines[j])
      if (next && next[1].length <= dashIndent) {
        end = j
        break
      }
    }
    return [i, end]
  }
  return [-1, -1]
}

/** 在 [start, end) 里找 `config:` 之后、键为 key 的第一个标量值。 */
function configScalar(lines, start, end, key) {
  let configIndent = -1
  for (let i = start; i < end; i += 1) {
    const cfg = /^(\s*)config:\s*$/.exec(lines[i])
    if (cfg) {
      configIndent = cfg[1].length
      break
    }
  }
  if (configIndent < 0) return ''
  const re = new RegExp('^(\\s+)' + key + ':\\s*(.+?)\\s*$')
  for (let i = start; i < end; i += 1) {
    const m = re.exec(lines[i])
    if (m && m[1].length > configIndent) return cleanValue(m[2])
  }
  return ''
}

/** 在 [start, end) 里解析 `providers:` 下某个 provider 的标量键。 */
function providerScalar(lines, start, end, wantedProvider, key) {
  let providersIndent = -1
  let providerIndent = -1
  let inside = false
  let insideIndent = -1
  for (let i = start; i < end; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (providersIndent < 0) {
      if (/^\s*providers:\s*$/.test(line)) providersIndent = indent
      continue
    }
    if (indent <= providersIndent) {
      if (inside) break
      continue
    }
    if (providerIndent < 0) providerIndent = indent
    if (indent === providerIndent) {
      const m = /^\s*([A-Za-z0-9._-]+):\s*$/.exec(line)
      inside = Boolean(m && m[1] === wantedProvider)
      insideIndent = indent
      continue
    }
    if (inside && indent > insideIndent) {
      const m = new RegExp('^\\s*' + key + ':\\s*(.+?)\\s*$').exec(line)
      if (m) return cleanValue(m[1])
    }
  }
  return ''
}

/** provider 块内是否声明了思考强度支持。 */
function providerSupportsReasoning(lines, start, end, wantedProvider) {
  const blockStart = -1
  // 复用 providerScalar 的扫描方式：找 provider 块的范围
  let providersIndent = -1
  let providerIndent = -1
  let inside = false
  let insideIndent = -1
  let blockEnd = end
  let blockStartLine = -1
  for (let i = start; i < end; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (providersIndent < 0) {
      if (/^\s*providers:\s*$/.test(line)) providersIndent = indent
      continue
    }
    if (indent <= providersIndent) {
      if (inside) {
        blockEnd = i
        break
      }
      continue
    }
    if (providerIndent < 0) providerIndent = indent
    if (indent === providerIndent) {
      const m = /^\s*([A-Za-z0-9._-]+):\s*$/.exec(line)
      const nextInside = Boolean(m && m[1] === wantedProvider)
      if (inside && !nextInside) {
        blockEnd = i
        break
      }
      if (!inside && nextInside) {
        inside = true
        insideIndent = indent
        blockStartLine = i
      }
      continue
    }
  }
  if (blockStartLine < 0) return false
  void blockStart
  for (let i = blockStartLine; i < blockEnd; i += 1) {
    if (/^\s*reasoningEfforts:/.test(lines[i]) || /^\s*reasoning:\s*\S/.test(lines[i])) return true
  }
  return false
}

/** 读 settings.yaml 里某个 namespace 的某个标量（顶层 namespace 映射）。 */
function settingsScalar(text, namespace, key) {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp('^' + namespace + ':\\s*$').test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return ''
  const re = new RegExp('^\\s+' + key + ':\\s*(.+?)\\s*$')
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break
    const m = re.exec(lines[i])
    if (m) return cleanValue(m[1])
  }
  return ''
}

/** 从 credentials.yaml 的 refs 段取一个引用值。 */
function credentialRef(text, refName) {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^refs:\s*$/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return ''
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break
    const m = new RegExp('^\\s+' + refName + ':\\s*(\\S+)\\s*$').exec(lines[i])
    if (m) return cleanValue(m[1])
  }
  return ''
}

/** 拼出 OpenAI 兼容的 chat/completions 端点。 */
export function completionsEndpoint(baseURL) {
  const base = typeof baseURL === 'string' ? baseURL.trim() : ''
  if (!base) return OFFICIAL_DEEPSEEK_ENDPOINT
  const trimmed = base.replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  return trimmed + '/chat/completions'
}

/**
 * 解析审查目标。
 * @param {object} [options]
 * @param {object} [options.env] 环境变量（默认 process.env）
 * @param {string} [options.dshHome] DSH 根目录（默认 DSH_HOME 或 ~/.dsh）
 * @param {string} [options.profileDir] profile 目录（默认 DSH_PROFILE_DIR 或 <dshHome>/profiles/<DSH_PROFILE|desktop>）
 * @param {string} [options.settingsFile] 设置文档路径（默认 <dshHome>/settings.yaml）
 * @param {string} [options.credentialsFile] 凭据文件（默认 <dshHome>/.credentials.yaml）
 * @returns {{provider:string, model:string, endpoint:string, apiKey:string, apiKeyEnv:string,
 *   reasoningEffort:string, reasoningSupported:boolean, viaReasoning:boolean,
 *   source:{model:string, provider:string, reasoning:string}, problems:string[]}}
 */
export function resolveReviewTarget(options = {}) {
  const env = options.env || process.env
  const dshHome = options.dshHome || env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profileName = env.DSH_PROFILE || 'desktop'
  const profileDir = options.profileDir || env.DSH_PROFILE_DIR || path.join(dshHome, 'profiles', profileName)
  const settingsFile = options.settingsFile || path.join(dshHome, 'settings.yaml')
  const credentialsFile = options.credentialsFile || path.join(dshHome, '.credentials.yaml')

  const problems = []
  const source = { model: 'fallback', provider: 'fallback', reasoning: 'default' }

  const profileText = readText(path.join(profileDir, 'cordis.patch.yml'))
  const profileLines = profileText.split(/\r?\n/)
  const settingsText = readText(settingsFile)

  // ---- 1. 主提供商 / 主模型 ----
  const mainEntry = findEntryRange(profileLines, ['agent-default-model', '@deepseek-ai/dsh-agent-default-model'])
  let provider = ''
  let model = ''
  let configuredReasoning = ''
  if (mainEntry[0] >= 0) {
    provider = configScalar(profileLines, mainEntry[0], mainEntry[1], 'provider')
    model = configScalar(profileLines, mainEntry[0], mainEntry[1], 'model')
    configuredReasoning = configScalar(profileLines, mainEntry[0], mainEntry[1], 'reasoningEffort')
  }
  if (provider || model) source.model = 'profile'

  const settingsProvider = settingsScalar(settingsText, MAIN_MODEL_SETTINGS_NS, 'provider')
  const settingsModel = settingsScalar(settingsText, MAIN_MODEL_SETTINGS_NS, 'model')
  if (settingsProvider) {
    provider = settingsProvider
    source.model = 'settings'
  }
  if (settingsModel) {
    model = settingsModel
    source.model = 'settings'
  }

  // ---- 2. 提供商路由（只看 llm-pi-ai 的 providers 段） ----
  let baseURL = ''
  let apiKeyEnv = ''
  let reasoningSupported = false
  let providerKnown = false
  const piEntry = findEntryRange(profileLines, ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'])
  if (piEntry[0] >= 0 && provider) {
    baseURL = providerScalar(profileLines, piEntry[0], piEntry[1], provider, 'baseURL')
    apiKeyEnv = providerScalar(profileLines, piEntry[0], piEntry[1], provider, 'apiKeyEnv')
    reasoningSupported = providerSupportsReasoning(profileLines, piEntry[0], piEntry[1], provider)
    providerKnown = Boolean(baseURL || apiKeyEnv)
    if (!providerKnown) problems.push('provider "' + provider + '" 未在 profile 的 llm-pi-ai.providers 里声明')
  } else if (provider && provider !== 'deepseek') {
    problems.push('找不到 llm-pi-ai 的 provider 配置，无法解析 "' + provider + '" 的路由')
  }
  source.provider = providerKnown ? (baseURL ? 'profile' : 'profile') : 'fallback'

  // ---- 3. 环境变量覆盖 ----
  const envProvider = (env.DSH_REVIEW_PROVIDER || '').trim()
  const envModel = (env.DSH_REVIEW_MODEL || '').trim()
  const envBaseURL = (env.DSH_REVIEW_BASE_URL || '').trim()
  const envEndpoint = (env.DSH_REVIEW_ENDPOINT || '').trim()
  const envApiKey = (env.DSH_REVIEW_API_KEY || '').trim()
  const envApiKeyEnv = (env.DSH_REVIEW_API_KEY_ENV || '').trim()
  const envReasoning = (env.DSH_REVIEW_REASONING_EFFORT || '').trim()

  if (envProvider) {
    provider = envProvider
    source.provider = 'env'
  }
  if (envModel) {
    model = envModel
    source.model = 'env'
  }
  if (envBaseURL) {
    baseURL = envBaseURL
    source.provider = 'env'
  }
  if (envApiKeyEnv) apiKeyEnv = envApiKeyEnv
  if (!provider && !model) {
    problems.push('profile 里没有配 agent-default-model，回退到 deepseek-chat')
  }

  // ---- 4. 兜底：DeepSeek 官方 ----
  let endpoint
  if (envEndpoint) {
    endpoint = envEndpoint
  } else if (baseURL) {
    endpoint = completionsEndpoint(baseURL)
  } else if (provider && provider !== 'deepseek' && !providerKnown) {
    // provider 解析失败：不能假装能用主提供商，退回官方以保持可运行，但把问题记下来
    endpoint = OFFICIAL_DEEPSEEK_ENDPOINT
    provider = 'deepseek'
    model = LEGACY_MODEL
    source.model = 'fallback'
    source.provider = 'fallback'
    reasoningSupported = false
  } else {
    endpoint = OFFICIAL_DEEPSEEK_ENDPOINT
    if (!provider) provider = 'deepseek'
    if (!model) model = LEGACY_MODEL
    if (!providerKnown) {
      source.provider = 'fallback'
    }
  }

  // ---- 5. 凭据 ----
  const credentialsText = readText(credentialsFile)
  const wantedRef = apiKeyEnv || (provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : '')
  let apiKey = envApiKey
  if (!apiKey && wantedRef) {
    apiKey = (env[wantedRef] || '').trim() || credentialRef(credentialsText, wantedRef)
  }
  if (!apiKey) {
    apiKey = credentialRef(credentialsText, 'DEEPSEEK_API_KEY') || (env.DEEPSEEK_API_KEY || '').trim()
    if (apiKey && wantedRef && wantedRef !== 'DEEPSEEK_API_KEY') {
      problems.push('缺少 ' + wantedRef + '，退回 DEEPSEEK_API_KEY')
    }
  }
  if (!apiKey) problems.push('找不到可用 API key（想要的引用: ' + (wantedRef || 'DEEPSEEK_API_KEY') + '）')

  // ---- 6. 思考强度 ----
  let reasoningEffort = settingsScalar(settingsText, REVIEW_SETTINGS_NS, 'reviewReasoningEffort')
  if (reasoningEffort) source.reasoning = 'settings'
  else if (configuredReasoning) {
    reasoningEffort = configuredReasoning
    source.reasoning = 'profile'
  } else if (envReasoning) {
    reasoningEffort = envReasoning
    source.reasoning = 'env'
  } else {
    reasoningEffort = DEFAULT_REASONING_EFFORT
    source.reasoning = 'default'
  }
  if (envReasoning) {
    reasoningEffort = envReasoning
    source.reasoning = 'env'
  }
  const viaReasoning = reasoningSupported && Boolean(reasoningEffort) && reasoningEffort !== 'off'

  return {
    provider,
    model,
    endpoint,
    apiKey,
    apiKeyEnv: wantedRef || '',
    reasoningEffort,
    reasoningSupported,
    viaReasoning,
    source,
    problems,
  }
}
