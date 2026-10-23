// Claude Code Mobile - 额外工具
import { Tool } from './tools.mjs'
import { describeFetchError } from '../infra/net-error.mjs'

/**
 * TodoWrite —— 待办清单。
 *
 * 【2026-09-20 重写描述】用户反馈「agent 经常忘记更新待办，比如现在」。
 * 根因：我们的 description 只有「更新待办清单」5 个字，没有任何行为引导 ——
 * 模型不知道什么时候该用、什么时候不该用、更新频率要求。
 * 对比官方（~/cc-src/claude-code-main/tools/TodoWriteTool/prompt.ts）：
 * 官方有完整的 When to Use / When NOT to Use 清单 + 8 个带 reasoning 的例子，
 * 并在 DESCRIPTION 里明确「proactively and often」「at least one in_progress at all times」。
 *
 * 这里按官方骨架精简重写（中文、贴合本项目），关键是三条硬要求：
 *   1. 复杂任务（≥3 步）**开工前**就建清单
 *   2. 状态**实时**更新，完成一个立刻标一个，不攒批
 *   3. 任何时刻**有且仅有 1 个** in_progress
 */
const TODO_WRITE_DESCRIPTION = [
  '创建和管理当前会话的结构化任务清单。**主动且频繁地使用它**，让用户看到进度。',
  '',
  '## 什么时候用',
  '1. 复杂多步任务 —— 需要 3 个以上不同步骤时',
  '2. 需要仔细规划的任务 —— 多文件改动、反复调试、需要验证的改动',
  '3. 用户明确要求用待办清单时',
  '4. 用户一次给了多个任务（列表形式、逗号分隔、编号）',
  '5. 收到新指令后 —— 立刻把需求拆成待办',
  '6. 开始做某件事前 —— **先标成 in_progress 再动手**（任何时刻只能有一个 in_progress）',
  '7. 完成一件事后 —— **立刻**标 completed，并把过程中发现的新任务加进去',
  '',
  '## 什么时候不用',
  '1. 只有一个简单任务',
  '2. 任务琐碎、跟踪它没有组织价值',
  '3. 三步以内能做完',
  '4. 纯对话或纯信息查询（用户只是问个问题，不需要动手）',
  '',
  '## 状态管理（硬要求）',
  '- **实时更新**，不要攒到最后一起改',
  '- 完成一个**立刻**标一个 —— 别等整批做完才更新',
  '- **任何时刻有且仅有 1 个 in_progress**（不多不少）',
  '- 先完成当前任务，再开始新任务',
  '- 不再相关的任务**整个删掉**，不要留着',
  '- 所有任务都完成后，传空数组 `todos: []` 清空清单 —— 不要留一堆 completed 占着屏幕',
  '- 每个任务都要给两个描述：content（祈使句，如「修复登录 bug」）和 activeForm（进行时，如「正在修复登录 bug」）',
  '',
  '## 完成标准',
  '只有**真正做完**才能标 completed。以下情况**不许**标完成：',
  '- 测试还在失败',
  '- 只做了一部分',
  '- 遇到未解决的错误',
  '- 没找到必要的文件或依赖',
  '遇到阻塞时保持 in_progress，并新建一个任务描述「需要解决什么」。',
  '',
  '拿不准的时候就用它 —— 主动管理任务能让用户看清进度，也确保你不漏掉需求。',
].join('\n')

export class TodoWriteTool extends Tool {
  constructor() {
    super({
      name: 'TodoWrite',
      description: TODO_WRITE_DESCRIPTION,
      input_schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '祈使句描述要做什么，如「修复登录 bug」' },
                activeForm: { type: 'string', description: '进行时描述，正在做时显示，如「正在修复登录 bug」' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending=未开始 · in_progress=进行中（同时只能有一个）· completed=已完成' },
              },
              required: ['content', 'activeForm', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      isReadOnly: () => false,
      maxResultSizeChars: 2000,
      validateInput: (input) => {
        const errors = []
        if (!input.todos || !Array.isArray(input.todos)) { errors.push('todos is required and must be an array') }
        // 【2026-09-20】空数组是合法的 —— 表示「清空清单」（所有任务都完成了）。
        // 官方就是这么做的（TodoWriteTool.ts:69 `allDone ? [] : todos`）：
        // 全部完成时自动置空，而不是留一堆 completed 占着屏幕。
        // 我们原来写死「todos must not be empty」，导致干完活也清不掉，清单一直挂着。
        else {
          // 官方硬要求：任何时刻有且仅有 1 个 in_progress。
          // 不满足时**提示但不拒绝** —— 拒绝会让模型在"刚建清单还没开工"时卡住
          //（那时全是 pending，也是合法状态）。
          const inProgress = input.todos.filter(t => t.status === 'in_progress').length
          if (inProgress > 1) errors.push(`同时有 ${inProgress} 个 in_progress，最多只能有 1 个`)
          // content / activeForm 官方都是 .min(1)（claude.js:947612-947616）。
          // 空串不会报错但会让看板出现空行，用户看不出那一条在做什么，
          // 而且 activeForm 是状态栏唯一的数据源 —— 空着等于状态栏什么都不显示。
          input.todos.forEach((t, i) => {
            const at = `todos[${i}]`
            if (typeof t?.content !== 'string' || t.content.trim() === '') {
              errors.push(`${at}.content 不能为空（要写清这一步做什么，如「修复登录 bug」）`)
            }
            if (typeof t?.activeForm !== 'string' || t.activeForm.trim() === '') {
              errors.push(`${at}.activeForm 不能为空（要写进行时描述，如「正在修复登录 bug」）`)
            }
          })
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input) {
    const todos = input.todos || []
    // 全部完成 → 清空清单（对齐官方 TodoWriteTool.ts:69）。
    // 返回空字符串，UI 层据此收起看板。
    if (todos.length === 0 || todos.every(t => t.status === 'completed')) {
      return ''
    }
    return todos.map((t) => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'
      return `${icon} ${t.content}`
    }).join('\n')
  }
}

export class WebFetchTool extends Tool {
  constructor() {
    super({
      name: 'WebFetch',
      description: [
        '抓取网页内容。长页面用 offset 分页续读。',
        '',
        '## 何时该用',
        '- 需要网页正文来做判断/回答（不是只想要个链接）',
        '- 搜索结果摘要不够、要核实原文',
        '',
        '## 用法要点',
        '- URL 必须是完整有效的（含协议）',
        '- localhost 和不带点的主机名不支持；本地服务请用 Bash 跑 curl',
        '- prompt 用来描述「你想从页面里提取什么」，页面很大时会据此提炼，比直接读全文省上下文',
        '- 本工具只读，不修改任何文件',
        '- 结果可能被摘要（内容很大时）',
        '- URL 跳到别的主机会明确告知新地址，需要时用新地址再请求一次',
        '- GitHub 的 PR/issue 优先用 GitHubPRs / GitHubIssueView 工具',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的完整 URL（http/https）' },
          // 对齐官方 WebFetch 的**必填**字段 prompt（claude.js 里它是 required）。
          // 官方语义：prompt 描述要提取什么，抓完由小模型按它提炼。
          // CCM 没有「抓取后二次提炼」的模型调用（那要多一次 API 请求），
          // 所以这里改为：把 prompt 回显在结果头部作为阅读重点提示，
          // 并在正文过大时优先保留与 prompt 关键词相关的段落。
          // 这样至少让模型「带着目的读」，而不是拿一大坨正文自己找。
          prompt: {
            type: 'string',
            description: '描述你想从页面中提取什么信息（如「找出安装步骤」「这个版本的发布日期」）。内容很长时会据此优先展示相关段落。',
          },
          // 对齐官方 Claude Code 2.1.x 的 offset：正文默认截到 15000 字符，
          // 长文档（官方文档、长 issue）只能看到开头。原来没有续读手段，
          // 只能换 URL 或放弃。offset 从指定字符位置往后取，配合返回里的
          // 「还有 N 字符」提示可以一页页读完。
          offset: {
            type: 'number',
            description: '从正文第几个字符开始取（默认 0）。配合返回末尾的续读提示使用',
          },
        },
        required: ['url'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      backgrounding: 'detach',
      maxResultSizeChars: 50000,
      validateInput: (input) => {
        const errors = []
        if (!input.url) { errors.push('url is required') }
        else {
          try { new URL(input.url) } catch { errors.push('url is not a valid URL') }
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input) {
    // 1. 协议 + SSRF 校验：只允许 http/https，阻断内网/环回/元数据地址
    let u
    try { u = new URL(input.url) } catch { throw new Error('无效 URL') }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`不支持的协议 ${u.protocol}（只允许 http/https）`)
    }
    if (isBlockedHost(u.hostname)) {
      throw new Error(`拒绝访问内网/环回地址: ${u.hostname}（防 SSRF）`)
    }
    // 2. 超时 15s（不依赖外层工具超时）
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(input.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android) Claude-Code-Mobile/1.0' },
        signal: controller.signal,
        redirect: 'follow',
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      // 3. Content-Length 预检 + 流式读取上限（防超大响应先 OOM 再截断）
      const MAX_BYTES = 5 * 1024 * 1024  // 5MB 上限
      const cl = parseInt(resp.headers.get('content-length') || '0', 10)
      if (cl && cl > MAX_BYTES) throw new Error(`响应过大 ${Math.round(cl/1024/1024)}MB，上限 5MB`)
      let raw = ''
      if (resp.body && resp.body.getReader) {
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let total = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.length
            if (total > MAX_BYTES) { try { await reader.cancel() } catch {}; break }
            raw += decoder.decode(value, { stream: true })
          }
        } finally { try { reader.releaseLock() } catch {} }
      } else {
        raw = (await resp.text()).slice(0, MAX_BYTES)
      }
      const text = raw.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
      // 分页：offset 是「正文里的字符位置」，不是页号 —— 页大小固定 15000，
      // 用字符位置更直观（返回里直接告诉下一段从哪开始）。
      const PAGE = 15000
      const offset = Math.max(0, Number(input.offset) || 0)
      if (offset >= text.length && text.length > 0) {
        return `URL: ${input.url}\n\n[offset ${offset} 已超出正文长度 ${text.length}，没有更多内容]`
      }
      const slice = text.slice(offset, offset + PAGE)
      const rest = text.length - (offset + slice.length)
      // prompt 回显：官方 WebFetch 的 prompt 是必填，抓完由小模型按它提炼。
      // CCM 不做二次模型调用（多一次 API 请求、手机端成本高），改为：
      // ① 把 prompt 写在结果最前面 —— 模型读正文时始终看得见自己要找什么；
      // ② 正文很长且给了 prompt 时，把含 prompt 关键词的段落**前置**，
      //    避免关键信息落在 15000 字符之外、模型以为页面上没有。
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      let body = slice
      let excerptNote = ''
      if (prompt && rest > 0) {
        const hits = pickRelevantChunks(text, prompt, 4000)
        if (hits.length > 0) {
          body = hits.join('\n\n…\n\n') + '\n\n── 以下是正文开头（完整内容用 offset 续读）──\n' + slice
          excerptNote = `\n[已按 prompt 关键词前置 ${hits.length} 段相关片段]`
        }
      }
      let out = `URL: ${input.url}`
      if (prompt) out += `\n提取目标: ${prompt}`
      out += `\n\n${body}`
      if (rest > 0) {
        out += `\n\n[还有 ${rest} 字符未显示。续读：WebFetch({url:"${input.url}", offset:${offset + slice.length}})]`
      } else if (offset > 0) {
        out += `\n\n[已到正文末尾]`
      }
      if (excerptNote) out += excerptNote
      return out
    } catch(e) {
      if (e.name === 'AbortError') throw new Error('Fetch failed: 请求超时 (15s)')
      // 【2026-10-16 改】原来直接拼 e.message —— Node fetch 传输层失败时
      // 它恒为 `fetch failed`，真实原因（DNS 解析不了 / 连不上 / 证书错）
      // 全在 e.cause 里。用户看到的是「Fetch failed: fetch failed」，
      // 既不知道发生了什么，也不知道该查什么。改用统一工具带上 cause 链。
      throw new Error(`Fetch failed: ${describeFetchError(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 按 prompt 里的关键词，从长正文里挑出最相关的若干段。
 *
 * 【为什么需要】WebFetch 默认只返回前 15000 字符。用户问「这个版本的发布日期」时，
 * 答案常常在页面很靠后的位置（变更日志、页脚元信息），模型看到的是开头导航和
 * 介绍，于是回「页面里没有」。把相关段落前置，是让「有目的读」真的生效。
 *
 * 做法刻意保守：
 *   · 关键词从 prompt 里抽（去停用词、长度 ≥2、最多 8 个）
 *   · 按句子/空行切块，块内含命中词的计分
 *   · 只取分数最高的几块、总长受 maxChars 限制
 * 抽不到关键词或没有命中 → 返回空数组，调用方回退到「只给开头」。
 */
function pickRelevantChunks(text, prompt, maxChars = 4000) {
  const STOP = new Set(['的', '了', '是', '在', '和', '与', '有', '我', '你', '他', '这', '那',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
    'what', 'which', 'how', 'when', 'where', 'who', 'find', 'get', 'extract', 'from', 'page',
    'info', 'information', 'about', 'describe', 'look', 'look for', 'tell'])
  // 英文按词切、中文按 2-4 字滑窗（没有分词器，滑窗足够定位）
  const words = []
  for (const w of String(prompt).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 2 && !STOP.has(w)) words.push(w)
  }
  const cjk = String(prompt).match(/[\u4e00-\u9fa5]{2,}/g) || []
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) words.push(seg.slice(i, i + 2))
  }
  const keywords = [...new Set(words)].slice(0, 12)
  if (keywords.length === 0) return []

  // 切块：优先按句子结束符和空行，块长上限 800 字符
  const chunks = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (buf.length >= 800 || /[。！？.!?\n]\s*$/.test(buf)) {
      if (buf.trim()) chunks.push(buf)
      buf = ''
      if (chunks.length >= 400) break   // 再长也不值当全扫
    }
  }
  if (buf.trim()) chunks.push(buf)

  const scored = []
  for (const c of chunks) {
    const low = c.toLowerCase()
    let score = 0
    for (const k of keywords) {
      // 命中次数封顶，避免单个高频词垄断
      const n = low.split(k).length - 1
      if (n > 0) score += Math.min(n, 3)
    }
    if (score > 0) scored.push({ c: c.trim(), score })
  }
  scored.sort((a, b) => b.score - a.score)

  const picked = []
  let used = 0
  for (const { c } of scored) {
    if (used + c.length > maxChars) continue
    picked.push(c)
    used += c.length
    if (picked.length >= 6) break
  }
  return picked
}

// SSRF 防护：判断 hostname 是否是内网/环回/链路本地/元数据地址
function isBlockedHost(hostname) {
  if (!hostname) return true
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')  // 去 IPv6 方括号
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0.0.0.0') return true
  // IPv6 唯一本地地址 fc00::/7、链路本地 fe80::
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  // IPv4 私有 / 环回 / 链路本地 / 元数据
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = +m[1], b = +m[2]
    if (a === 127) return true               // 环回
    if (a === 10) return true                // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12
    if (a === 192 && b === 168) return true  // 192.168.0.0/16
    if (a === 169 && b === 254) return true  // 链路本地 + 云元数据 169.254.169.254
    if (a === 0) return true
  }
  return false
}

export class AskUserSimpleTool extends Tool {
  constructor(onAsk) {
    super({
      name: 'AskUserQuestion',
      description: '向用户提问获取信息。\n' +
        '两种写法：\n' +
        '  · questions 数组（1-4 题，对齐官方）—— 每题可设 kind: choice / text / number\n' +
        '    choice：给 2-4 个 options，用户按编号选；multiSelect=true 可多选（如 "1,3"）\n' +
        '    text：自由文本，可给 placeholder 提示\n' +
        '    number：给 min/max（必填）以及可选 step/defaultValue/unit，终端里用纯文本输入\n' +
        '  · 单题写法（question + options）—— 兼容保留，等价于只有一道 choice 题\n' +
        '不给 options 就是纯文本提问。\n' +
        '⚠️ 子 Agent 不要调用 —— 无法与用户交互，会一直阻塞。',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问的问题' },
          // 对齐官方 Claude Code 2.1.x 的 title：给这次提问一个单行标题。
          // 用途是「长问题先给一句人话摘要」——终端里问题正文可能好几行，
          // 标题让用户一眼知道这次在问什么主题（也方便回看历史时定位）。
          // 不传就退回用 question 的首行，不强制。
          title: { type: 'string', description: '可选：单行标题（问题很长时给个主题，便于扫读）' },
          // 【2026-10-20 改】对齐官方 AskUserQuestion：options 是**对象数组**
          // `{label, description}`，不是字符串数组。
          //
          // 官方为什么用对象：label 是按钮上那行短字（手机上必须短，否则被截断），
          // description 是「选这个意味着什么」的补充说明。合成一个字符串就只能在
          // 「写清楚」和「放得下」之间二选一。
          //
          // 兼容：字符串数组仍然接受（老调用、其他端可能还在传字符串），
          // 内部统一归一化成 `{label, description}`。见 normalizeAskOptions()。
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '选项短标签（手机上建议 ≤12 字）' },
                description: { type: 'string', description: '这个选项的补充说明（可选）' },
              },
              required: ['label'],
            },
            description: '可选：预设选项（最多 4 个）。每项是 {label, description} 对象；也接受纯字符串。',
          },
          // 官方 AskUserQuestion 的 multiSelect：允许多选。
          // CCM 的交互是「输编号选一个」，多选需要额外的输入约定（如 1,3），
          // 这里接住字段并在 onAsk 里透传，由渲染层决定是否支持。
          multiSelect: {
            type: 'boolean',
            description: '允许选多个（默认 false）。为 true 时用户可输入多个编号，如 "1,3"。',
          },
          // ── 官方 2.1.x 的 questions 数组（1-4 题）────────────────────
          // 官方原文：'Questions to ask the user (1-4 questions). The 1-4 questions
          // and 2-4 options bounds are hard schema constraints; do not exceed them
          // even if the user requests more — split into multiple calls instead.'
          //
          // 每题 11 个字段（官方 chunk-qtrk83ae.js:315-329）：
          //   question / header / kind / description / options / multiSelect
          //   placeholder / min / max / step / defaultValue / unit
          // 其中后 5 个按 kind 互斥，见 validateInput 的 checkQuestionShape()。
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            description: '要问的问题列表（1-4 个）。给了它就忽略顶层 question/options。',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '完整问题，以问号结尾' },
                header: { type: 'string', description: '可选：极短标签（≤12 字符），如「认证方式」「库选择」' },
                kind: {
                  type: 'string',
                  enum: ['choice', 'text', 'number'],
                  description: '回答方式。choice（省略时的默认值）从选项里挑；text 是自由文本，不要给 options；'
                    + 'number 是 min..max 之间的数值。',
                },
                description: { type: 'string', description: '可选：问题下方的一行补充说明' },
                options: {
                  type: 'array',
                  maxItems: 4,
                  description: 'choice 题的选项（2-4 个）。text/number 题不要给。'
                    + '不要自己加「其他」「跳过」选项，表单会自动提供。',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: '选项短标签（1-5 个词）' },
                      description: { type: 'string', description: '这个选项意味着什么（可选）' },
                    },
                    required: ['label'],
                  },
                },
                multiSelect: { type: 'boolean', description: 'choice 题专用：允许选多个' },
                placeholder: { type: 'string', description: '仅 text 题：空输入框的占位提示' },
                min: { type: 'number', description: '仅 number 题（必填）：最小值' },
                max: { type: 'number', description: '仅 number 题（必填）：最大值' },
                step: { type: 'number', description: '仅 number 题：步长（正数）' },
                defaultValue: { type: 'number', description: '仅 number 题：初始值，须落在 min..max 内' },
                unit: { type: 'string', description: '仅 number 题：数值旁的短单位，如 px / % / 个' },
              },
              required: ['question'],
            },
          },
        },
        // 不再强制 question —— 官方是 questions 数组；单题写法作为兼容保留，
        // 两者至少要有一个，在 validateInput 里判定。
        required: [],
      },
      maxResultSizeChars: 5000,
      validateInput: (input) => {
        const errors = []
        const hasQuestions = Array.isArray(input.questions) && input.questions.length > 0
        // 两种入口二选一：官方 questions 数组，或 CCM 原有的单 question 写法。
        // 都缺就报错（原来 required:['question'] 由框架兜，现在 required 空了，
        // 必须在这里显式判，否则会带着 undefined 走到 onAsk 去问一个空问题）。
        if (!hasQuestions && !input.question) {
          errors.push('需要 questions 数组（1-4 题），或单题写法的 question')
        }
        if (input.questions !== undefined && !Array.isArray(input.questions)) {
          errors.push('questions 必须是数组')
        } else if (hasQuestions) {
          if (input.questions.length > 4) errors.push('questions 最多 4 题')
          const seen = new Set()
          for (const [i, q] of input.questions.entries()) {
            if (!q || typeof q !== 'object') { errors.push(`questions[${i}] 不是对象`); continue }
            const e = checkQuestionShape(q, i)
            errors.push(...e)
            // 官方 obj1242.check：问题文本必须唯一
            const key = String(q.question ?? '').trim()
            if (key) {
              if (seen.has(key)) errors.push(`questions[${i}] 与前面的问题重复（问题文本必须唯一）`)
              seen.add(key)
            }
          }
        }
        // 单题写法的原有校验
        if (!hasQuestions && input.options !== undefined && input.options !== null) {
          if (!Array.isArray(input.options)) errors.push('options 必须是数组')
          else {
            for (const [i, o] of input.options.entries()) {
              if (o === null || o === undefined) { errors.push(`options[${i}] 为空`); continue }
              // 字符串形式（兼容）或对象形式，两者都收
              if (typeof o === 'object' && !o.label) errors.push(`options[${i}] 缺少 label`)
              if (typeof o !== 'string' && typeof o !== 'object') errors.push(`options[${i}] 类型不支持`)
            }
          }
        }
        return { valid: errors.length === 0, errors }
      },
    })
    this.onAsk = onAsk
  }
  async execute(input) {
    // ── 官方 questions 数组（1-4 题）────────────────────────────────
    // 逐题调用 onAsk（第四参带上 kind/约束），把答案汇总成
    // `"问题"="回答", ...` —— 与官方 mapToolResultToToolResultBlockParam
    // （chunk-qtrk83ae.js:679）同格式，模型读起来最省事。
    if (Array.isArray(input.questions) && input.questions.length > 0) {
      const answers = []
      for (const q of input.questions) {
        const text = String(q.question ?? '').trim()
        if (!text) continue
        const kind = q.kind ?? 'choice'
        const opts = kind === 'choice' ? normalizeAskOptions(q.options) : []
        // header 优先当标题（官方语义：chip/tag 形式的短标签），没有就用 title
        const title = String(q.header ?? '').trim() || undefined
        const extra = {
          multiSelect: kind === 'choice' && !!q.multiSelect,
          kind,
          description: q.description,
          placeholder: q.placeholder,
          min: q.min,
          max: q.max,
          step: q.step,
          defaultValue: q.defaultValue,
          unit: q.unit,
        }
        // 问题正文带上 text/number 的额外提示，让用户在终端里知道该输什么。
        // 这些约束渲染层（index.mjs 的 askUser）不认识，只能在问题文本里说明。
        let askText = text
        if (q.description) askText += `\n${q.description}`
        if (kind === 'text' && q.placeholder) askText += `\n（例：${q.placeholder}）`
        if (kind === 'number') {
          const bits = [`${q.min}..${q.max}`]
          if (q.step) bits.push(`步长 ${q.step}`)
          if (q.defaultValue !== undefined) bits.push(`默认 ${q.defaultValue}`)
          if (q.unit) bits.push(`单位 ${q.unit}`)
          askText += `\n（请输入数值：${bits.join('，')}）`
        }
        const raw = await this.onAsk(askText, opts, title, extra)
        let ans = (raw ?? '').toString().trim()
        // number 题：把用户输入规整成合法数值（越界就夹到边界，非法就原样保留）
        if (kind === 'number') ans = clampNumberAnswer(ans, q)
        answers.push(`"${text}"="${ans || '(no answer)'}"`)
      }
      return answers.length ? answers.join(', ') : '(no answer)'
    }

    // ── 单题写法（兼容保留）────────────────────────────────────────
    const opts = normalizeAskOptions(input.options)
    // title 目前只做「有就用」的透传：onAsk 第三参带上，渲染层可选用它
    // 做标题行。不传时保持 undefined，老的 askUser 实现忽略即可。
    const title = typeof input.title === 'string' && input.title.trim()
      ? input.title.trim()
      : undefined
    // onAsk 第二个参数是选项（旧实现只传 question —— 保持向后兼容，
    // 老的 askUser 忽略第二个参数即可）
    // 第四参是扩展项（multiSelect 等），老实现忽略即可。
    const a = await this.onAsk(input.question, opts, title, {
      multiSelect: !!input.multiSelect,
    })
    return a || '(no answer)'
  }
}

/**
 * number 题的答案规整：能解析成数字就夹到 [min, max]，并尽量对齐 step。
 * 解析不出来（用户写了句话）就原样返回 —— 别把人家的话吞掉。
 */
function clampNumberAnswer(ans, q) {
  if (!ans) return ans
  const n = Number(ans.replace(/[^\d.eE+-]/g, ''))
  if (!Number.isFinite(n)) return ans
  let v = n
  const min = Number(q.min)
  const max = Number(q.max)
  if (Number.isFinite(min) && v < min) v = min
  if (Number.isFinite(max) && v > max) v = max
  const step = Number(q.step)
  if (Number.isFinite(step) && step > 0 && Number.isFinite(min)) {
    v = min + Math.round((v - min) / step) * step
    // 对齐后再夹一次：四舍五入可能把它推到边界外
    if (Number.isFinite(max) && v > max) v = max
  }
  return String(v)
}

/**
 * 单题形态校验（对齐官方 superRefine，chunk-qtrk83ae.js:328-378）。
 * 返回错误信息数组，空数组 = 通过。
 */
function checkQuestionShape(q, i) {
  const errs = []
  const p = `questions[${i}]`
  const kind = q.kind ?? 'choice'
  if (!['choice', 'text', 'number'].includes(kind)) {
    errs.push(`${p}.kind 只能是 choice / text / number`)
    return errs
  }
  // 按 kind 互斥的 5 个字段（官方原表）
  for (const [field, only] of [['placeholder', 'text'], ['min', 'number'], ['max', 'number'],
    ['step', 'number'], ['defaultValue', 'number'], ['unit', 'number']]) {
    if (kind !== only && q[field] !== undefined) {
      errs.push(`${p}.${field} 只适用于 kind="${only}" 的题`)
    }
  }
  if (kind === 'choice') {
    const opts = Array.isArray(q.options) ? q.options : []
    if (opts.length < 2) {
      errs.push(`${p} 是 choice 题，需要 2-4 个选项；开放式提问请用 kind="text"`)
    }
    if (opts.length > 4) errs.push(`${p}.options 最多 4 个`)
    const seen = new Set()
    for (const o of opts) {
      const label = String(o?.label ?? '').trim()
      if (label) {
        if (seen.has(label)) errs.push(`${p}.options 里有重复的 label「${label}」`)
        seen.add(label)
      }
    }
    return errs
  }
  // text / number 题不收选项
  if (Array.isArray(q.options) && q.options.length > 0) {
    errs.push(`${p} 是 ${kind} 题，不该带 options`)
  }
  if (q.multiSelect) {
    errs.push(`${p}.multiSelect 只适用于 choice 题，不适用于 ${kind}`)
  }
  if (kind !== 'number') return errs
  const min = Number(q.min)
  const max = Number(q.max)
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
    errs.push(`${p} 是 number 题，必须给数值 min 和 max 且 min < max`)
    return errs
  }
  if (q.step !== undefined && !(Number(q.step) > 0)) {
    errs.push(`${p}.step 必须是正数`)
  }
  if (q.defaultValue !== undefined) {
    const d = Number(q.defaultValue)
    if (!Number.isFinite(d) || d < min || d > max) {
      errs.push(`${p}.defaultValue 必须落在 min..max 内`)
    }
  }
  return errs
}

/**
 * 把 options 归一化成 `{label, description}[]`，最多 4 个。
 *
 * 接受三种形态（真实世界里都会遇到）：
 *   · `['A', 'B']`                    → 字符串数组（CCM 旧格式、APK 旧版）
 *   · `[{label:'A', description:'…'}]` → 官方格式
 *   · 混合 `['A', {label:'B'}]`        → 别问为什么会混合，但别让它崩
 *
 * 空标签的项直接丢弃 —— 渲染出来是个点不了的按钮。
 */
function normalizeAskOptions(options) {
  if (!Array.isArray(options)) return []
  const out = []
  for (const o of options) {
    if (o === null || o === undefined) continue
    if (typeof o === 'string') {
      const label = o.trim()
      if (label) out.push({ label, description: '' })
    } else if (typeof o === 'object') {
      const label = String(o.label ?? o.text ?? o.value ?? '').trim()
      if (!label) continue
      out.push({
        label,
        description: String(o.description ?? o.desc ?? '').trim(),
      })
    }
    if (out.length >= 4) break
  }
  return out
}
