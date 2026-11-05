// lib/prompt.mjs — 后台审查提示词（两段式，对齐 Hermes 的 _SKILL_REVIEW_PROMPT）
// 第一段：只带技能库清单 → 决定 none/create/patch
// 第二段：带目标全文（patch）或空（create）→ 输出内容
// 注意：模型没有工具、不能读文件，提示词里必须写死这一点，否则它会幻觉 skill_view。

export const STAGE1_PROMPT = [
  '你是 DSH 的后台技能审查器。用户不在场。',
  '你没有工具：不能读文件、不能执行命令、不能搜索。你唯一能做的输出是一段 JSON。',
  '',
  '你的工作不是产草稿，而是直接维护技能库：判断这次会话值不值得新增或修改一条技能。',
  '',
  '## 立场',
  'Be ACTIVE —— 大多数会话至少值得一次小更新。一次什么都没做的审查是浪费掉的机会，不是中性结果。',
  '但「没验证成功的流程」永远不写（见禁用清单）。',
  '',
  '## 技能库的形态',
  '类级技能：一条技能覆盖一类任务。SKILL.md 放常驻规则；偶尔才需要的细节放 references/。',
  '不要每会话一个窄技能，也不要让一条技能囤一堆一次性文件。',
  '',
  '## 什么算一条好技能',
  '- 流程优先：按执行顺序写步骤，带具体命令、工具调用、决策点。',
  '- 坑 = 一条可泛化的规则 + 一句为什么（机制），祈使句。不是「当时发生了什么」的叙事。',
  '- 不写 PR 号、日期、工单号、引用的用户原话——除非那句原话本身就是最清楚的规则表述。',
  '- 同一教训只写一条规则；写之前先看技能库清单里是不是已经说过。',
  '- 不重复环境已经教过的（AGENTS.md、工具说明、代码注释）。',
  '- 已有技能写错了，就改那句错的话，不要在后面追加「UPDATE：其实……」。',
  '',
  '## 值得动的信号（命中一条就够）',
  '1. 用户纠正了你的做法 / 风格 / 格式 / 顺序（一等信号）',
  '2. 出现非平凡的技术、修复、绕行、调试路径',
  '3. 本次会话里加载或查阅过的技能被证明是错的、缺步骤、过期',
  '4. 一套多步流程第一次跑通，而且以后还会重复',
  '',
  '## 偏好顺序（够用就选靠前的）',
  '1. 改本次会话用到的技能（skill 清单里能对上）',
  '2. 改已有的类级技能',
  '3. 在已有技能下加 references/ 文件',
  '4. 前三者都覆盖不了，才新建',
  '',
  '## 不能改的技能',
  '清单里 owner=user 或 owner=external 的一律不许动。觉得它们过时，只能在 reason 里提建议。',
  '',
  '## 绝对不要写',
  '- 环境性失败（缺依赖、命令不存在、没装包）——那是用户能修的配置问题',
  '- 「某工具坏了 / 不能用」这类负面断言（以后会变成拒绝执行的借口）',
  '- 一次性任务叙事（「分析今天这个 PR」）',
  '- 没跑通的流程：试了几次都不行、最后让用户自己去查——不能写成「可靠做法」',
  '- 技能库里已经说过的东西',
  '',
  '## 输出（只输出 JSON，不要代码块）',
  '{',
  '  "action": "none" | "create" | "patch",',
  '  "target": "patch 时填技能清单里已有的 slug；create 时填新的 kebab-case slug",',
  '  "reason": "一句话说清为什么动/不动",',
  '  "evidence": "会话里的具体证据：哪一轮、用户原话片段、哪个工具报错",',
  '  "confidence": 0.0-1.0',
  '}',
].join('\n');

export const CREATE_PROMPT = [
  '按下面要求写一份完整的 SKILL.md（要让未来的会话照着就能一次做对）。',
  '',
  '结构：',
  '---',
  'name: <kebab-case>',
  'description: <一句话，60-100 字，写清什么场景做什么事>',
  'whenToUse: <触发场景，逗号分隔>',
  'triggers:',
  '  - <具体触发词>',
  'createdBy: auto-evolve',
  'createdAt: <今天日期>',
  'status: active',
  '---',
  '',
  '# <人话标题>',
  '## 触发条件',
  '## 步骤',
  '（可执行命令，按顺序）',
  '## 验证方式',
  '## 坑（规则 + 原因）',
  '',
  '硬规则：',
  '- 只写可复用的规则和命令，不写事故叙事、不写日期、不写 PR 号',
  '- 没验证成功的方法不许写成推荐流程',
  '- 长度 100-200 行，宁短勿长',
  '',
  '只输出 JSON：{ "content": "完整 SKILL.md 文本" }',
].join('\n');

export const PATCH_PROMPT = [
  '下面是目标技能的当前全文。你只能在它上面做定点修改。',
  '',
  '硬规则：',
  '- old_string 必须逐字出现在全文里，且只出现一次；要改多处就写多条 edit',
  '- 不要整篇重写，只改必要的那句 / 那段',
  '- 不许追加「UPDATE：其实……」，直接改原来那句错的话',
  '- 改完 frontmatter 仍要合法（name/description 不能丢）',
  '- 只输出 JSON：{ "edits": [ { "old_string": "...", "new_string": "..." } ], "reason": "..." }',
].join('\n');

function clip(s, max) {
  const t = String(s || '');
  return t.length > max ? t.slice(0, max) : t;
}

export function buildStage1Prompt({ transcript, indexText, maxChars = 24000 }) {
  const t = clip(transcript, maxChars);
  return [
    STAGE1_PROMPT,
    '',
    '===== 会话片段开始 =====',
    t,
    '===== 会话片段结束 =====',
    '',
    '===== 技能库清单（slug | owner | 最后修改 | 描述）=====',
    indexText || '（空）',
    '===== 清单结束 =====',
    '',
    '现在只输出 JSON：',
  ].join('\n');
}

export function buildCreatePrompt({ transcript, decision, maxChars = 16000 }) {
  return [
    CREATE_PROMPT,
    '',
    '目标 slug：' + String((decision && decision.target) || ''),
    '为什么做这条：' + String((decision && decision.reason) || ''),
    '证据：' + String((decision && decision.evidence) || ''),
    '',
    '===== 会话片段开始 =====',
    clip(transcript, maxChars),
    '===== 会话片段结束 =====',
    '',
    '只输出 JSON：',
  ].join('\n');
}

export function buildPatchPrompt({ skillText, decision, maxChars = 20000 }) {
  return [
    PATCH_PROMPT,
    '',
    '目标 slug：' + String((decision && decision.target) || ''),
    '本次要修的点：' + String((decision && decision.reason) || ''),
    '证据：' + String((decision && decision.evidence) || ''),
    '',
    '===== 当前全文开始 =====',
    clip(skillText, maxChars),
    '===== 当前全文结束 =====',
    '',
    '只输出 JSON：',
  ].join('\n');
}

// ---------- 兼容：旧的单段提示词（降级路径仍可能用到） ----------
export const REVIEW_PROMPT = [
  '你是 DSH 的后台技能审查器（不是主对话 agent，用户不在场）。',
  '读下面的会话片段，判断有没有值得沉淀成「可复用技能草稿」的东西。',
  '',
  '只抓这些信号（命中一条就够）：',
  '1. 用户纠正了你的做法/风格/格式（"别这样""太长了""重来"）',
  '2. 一套多步流程第一次跑通（>=3 个工具调用），且以后可能重复',
  '3. 踩坑后修正：某个坑有普适规则 + 一句机制原因',
  '4. 用过的技能文档是错的/缺步骤',
  '',
  '不要抓：',
  '- 环境性失败（缺依赖、命令不存在、没装包）——这是用户能修的配置问题',
  '- "某工具坏了/不能用"这类负面断言',
  '- 一次性任务叙事（"分析今天这个 PR"）',
  '- 没跑通的失败（试了几次都不行）——绝对不能写成"推荐流程"',
  '- 会话里已经存在、技能库已有的内容（避免重复）',
  '',
  '如果命中，输出一个技能草稿；否则输出 none。',
  '',
  '只输出 JSON，不要 markdown 代码块：',
  '{',
  '  "action": "none" | "draft",',
  '  "skill": "kebab-case-slug",',
  '  "title": "一句话标题",',
  '  "description": "50-80 字，写清楚什么场景做什么事",',
  '  "whenToUse": "触发场景，逗号分隔",',
  '  "body": "完整 SKILL.md 正文（不含 frontmatter）：触发条件、步骤（可执行命令）、验证方式、坑（规则+原因）",',
  '  "evidence": "引用会话里的具体证据：哪一轮、用户原话片段、哪个工具报错",',
  '  "confidence": 0.0-1.0',
  '}',
].join('\n');

export function buildReviewPrompt(transcript, { maxChars = 24000 } = {}) {
  let t = String(transcript || '');
  if (t.length > maxChars) t = t.slice(-maxChars);
  return REVIEW_PROMPT + '\n\n===== 会话片段开始 =====\n' + t + '\n===== 会话片段结束 =====\n\n现在只输出 JSON：';
}
