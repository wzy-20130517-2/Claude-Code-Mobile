// Claude Code Mobile - 简单上下文压缩
// 已移除缓存感知 / 不可变摘要段机制（易引发幻觉）。
// 策略：把稳定前缀压缩成一段普通摘要，保留新鲜尾部；摘要不标"不可变"，后续可整体重写。

// 摘要请求禁用工具前导（对齐官方 compact prompt.ts NO_TOOLS_PREAMBLE）：
// 防止部分模型在摘要任务里尝试调用工具浪费轮次
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// 摘要正文不再有字符上限（2026-10-21 取消 SUMMARY_CHAR_LIMIT = 16000）。
// 历史上这个值被 _truncateSummary 用来「超长保尾部」，会把九段结构的前半段砍掉。
// 摘要输出预算（含上游计入输出的思考 token）。
//
// 演化史（别只看数字）：
//   4096   → 思考（reasoning）常把预算吃光，正文为空且 finish_reason=length
//   32768  → 仍会空（这个模型思考长度波动大）
//   384000 → Union Alpha 上实测 HTTP 400（输入+输出上限 262144）
//   131072 → 用户下调
//   65536  → 当前值（用户 2026-09-18 指定）
//
// 思考档位：摘要请求固定 'none'（关闭）。见 summarizeMessages 里的实测数据：
// 同一输入 effort=max 输出 402 字符、medium 215 字符、none 23359 字符 ——
// 开思考会把输出预算烧在 reasoning 上，正文只剩几百字符。
// 双保险 —— 预算放宽 + 思考档位收敛，比单纯堆 max_tokens 稳。
// 配置了 provider.maxOutputTokens 时，API 层仍会进一步夹取。
export const SUMMARY_MAX_TOKENS = 65536
// 【2026-10-20 取消输入截断】
//
// 原来这里是 60000 字符的硬上限，超了用 `.slice(0, LIMIT)` —— **从开头截**。
// 后果是「保留最老的、丢掉最新的」，正好反了：
//   实测一次 /compact 200：完整文本 421260 字符，只送了前 199 条消息（共 1786 条），
//   占 11%。而当天下午做的 claude.js 调研在第 852 条之后 → 一个字都没进摘要，
//   摘要里连「claude.js」这个词都不存在。用户当场发现「你好像完全不知道 claude.js」。
//
// 现在完全不截断，整段送给摘要模型。代价是输入变长（由模型的上下文窗口兜底），
// 收益是摘要不再系统性丢失近期工作。
//
// 注意：原来这里还有一个 SUMMARY_INPUT_CHAR_LIMIT = 60000 的导出，
// 2026-10-20 连同截断逻辑一起删掉了（prompts.mjs 的 {{SUMMARY_INPUT_LIMIT}} 插值也已移除）。
// 别再把它加回来 —— 它存在时只做一件事：把最新工作挡在摘要之外。

const SEGMENT_RE = /^\[缓存摘要段\s+(\d+)\]/
const LEGACY_RE = /^\[历史摘要\]/

// ── microCompact（参考 Claude Code 的做法）─────────────────────────
// 传统压缩把整段对话喂给模型生成摘要：要花一次 API 调用，且 assistant 的
// 推理过程会被压成几句话，信息损失大。
// microCompact 只回收「可再生的工具输出」——文件内容、grep 结果这些随时能重读，
// 留在上下文里纯占地方。对话本体（user 说了什么、assistant 想了什么）一字不动。
// 零 API 调用、纯本地字符串裁剪，因此可以频繁跑。
//
// 【安全前提】只改 tool_result 的 content，tool_use_id 保持原样，
// 所以 assistant 的 tool_use 与之配对关系不断链（Anthropic/Bedrock 对此严格校验）。

// 输出可再生的工具：重跑一次就能拿回同样内容，截断无信息损失
const MICRO_REGENERABLE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'CodeSearch', 'HashlineRead', 'HashlineGrep',
  'Symbols', 'RepoMap', 'Diagnostics',
  'GitStatus', 'GitDiff', 'GitLog',
  'Bash', 'BashOutput', 'Test',
  'WebFetch', 'WebSearch',
])

// 不可再生 / 不该动：用户的回答、一次性副作用、外部状态快照
const MICRO_NEVER_TOOLS = new Set([
  'AskUserQuestion',   // 用户原话，重问一次答案可能不同
  'TodoWrite',         // 任务状态本身就是要记住的东西
  'Memory',            // 同上
  'ImageGen',          // 生成结果不可复现（同 prompt 出图不同）
  'ViewImage', 'ViewVideo', 'Screencap',  // 多模态，截断会破坏旁路注入
])

const MICRO_DEFAULTS = {
  threshold: 2000,   // content 超过这么多字符才考虑截断
  keepHead: 600,     // 保留开头（通常含结构信息：文件头、命令、匹配摘要）
  keepTail: 300,     // 保留结尾（通常含结论：错误信息、退出码、末尾行）
  protectLast: 6,    // 最新 N 条消息不动（刚拿到的工具结果往往正在用）
}

const MICRO_MARK = '⋯[已回收'

const DEFAULT_POLICY = {
  enabled: false,          // 默认不自动摘要
  minChunkMessages: 8,
  minChunkTokens: 1800,
  maxContextTokens: 1000000,
}

export class CompactService {
  constructor({ api, logger, policy } = {}) {
    this.api = api
    this.logger = logger || console
    this.policy = { ...DEFAULT_POLICY, ...(policy || {}) }
  }

  setPolicy(policy = {}) { this.policy = { ...this.policy, ...policy }; return this.policy }

  /**
   * 微压缩：只截断可再生的工具输出，不动对话本体，零 API 调用。
   *
   * @param {Array} messages 完整消息数组（不会被原地修改）
   * @param {Object} options { threshold, keepHead, keepTail, protectLast, dryRun }
   * @returns {Object} { messages, changed, reclaimedChars, reclaimedTokens, details[] }
   */
  microCompact(messages, options = {}) {
    const opt = { ...MICRO_DEFAULTS, ...(options || {}) }
    const list = Array.isArray(messages) ? messages : []
    const details = []
    let reclaimedChars = 0

    // 先扫一遍 assistant 的 tool_use，建立 tool_use_id → 工具名 的映射。
    // tool_result 自己不带工具名，必须靠这个反查才知道能不能截。
    const toolNameById = new Map()
    for (const m of list) {
      if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b?.type === 'tool_use' && b.id) toolNameById.set(b.id, b.name)
      }
      // OpenAI 形态：tool_calls[].id + function.name
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.id) toolNameById.set(tc.id, tc.function?.name)
        }
      }
    }

    const protectFrom = Math.max(0, list.length - opt.protectLast)

    const shrink = (text, toolName) => {
      const s = String(text ?? '')
      if (s.length <= opt.threshold) return null
      const head = s.slice(0, opt.keepHead)
      const tail = s.slice(-opt.keepTail)
      const cut = s.length - opt.keepHead - opt.keepTail
      if (cut <= 0) return null
      return `${head}\n\n${MICRO_MARK} ${cut} 字符：${toolName || '工具'}输出可重跑获取]\n\n${tail}`
    }

    const out = list.map((msg, idx) => {
      if (idx >= protectFrom) return msg   // 尾部保护区

      // Anthropic 形态：user 消息里的 tool_result 块
      if (Array.isArray(msg?.content)) {
        let touched = false
        const content = msg.content.map(block => {
          if (block?.type !== 'tool_result') return block
          if (block._vision) return block          // 多模态旁路，别碰
          const name = toolNameById.get(block.tool_use_id)
          if (name && MICRO_NEVER_TOOLS.has(name)) return block
          if (name && !MICRO_REGENERABLE_TOOLS.has(name)) return block
          if (typeof block.content !== 'string') return block
          const next = shrink(block.content, name)
          if (!next) return block
          reclaimedChars += block.content.length - next.length
          details.push({ tool: name, before: block.content.length, after: next.length })
          touched = true
          // 保住 tool_use_id 与 is_error，只换 content → 配对不断链
          return { ...block, content: next }
        })
        if (touched) return { ...msg, content }
        return msg
      }

      // OpenAI 形态：role:'tool' 的独立消息
      if (msg?.role === 'tool' && typeof msg.content === 'string') {
        const name = toolNameById.get(msg.tool_call_id)
        if (name && MICRO_NEVER_TOOLS.has(name)) return msg
        if (name && !MICRO_REGENERABLE_TOOLS.has(name)) return msg
        const next = shrink(msg.content, name)
        if (!next) return msg
        reclaimedChars += msg.content.length - next.length
        details.push({ tool: name, before: msg.content.length, after: next.length })
        return { ...msg, content: next }
      }

      return msg
    })

    return {
      messages: opt.dryRun ? list : out,
      changed: details.length,
      reclaimedChars,
      reclaimedTokens: Math.ceil(reclaimedChars / 3),
      details,
    }
  }

  analyze(messages, options = {}) {
    const policy = { ...this.policy, ...(options.policy || {}) }
    const keepLast = Math.max(1, Number(options.keepLast) || 10)
    const lastPromptTokens = Number(options.lastPromptTokens || options.lastUsage?.promptTokens || 0)
    const maxContext = Number(options.maxContextTokens || policy.maxContextTokens)
    const pressure = maxContext > 0 && lastPromptTokens > 0 ? lastPromptTokens / maxContext : 0
    const fresh = messages
    const chunk = fresh.length > keepLast ? fresh.slice(0, -keepLast) : []
    const tail = fresh.slice(Math.max(0, fresh.length - keepLast))
    const chunkTokens = this._estimateTokens(chunk)
    const tailTokens = this._estimateTokens(tail)
    const estimatedSummaryTokens = Math.max(120, Math.min(500, Math.ceil(chunkTokens * 0.12)))
    const enoughChunk = chunk.length >= policy.minChunkMessages || chunkTokens >= policy.minChunkTokens
    const hardPressure = pressure >= 0.94
    let recommendation = 'defer'
    let reason = '待压缩块太小或上下文压力不足'
    if (!chunk.length) { recommendation = 'noop'; reason = '没有可压缩的旧消息' }
    else if (hardPressure) { recommendation = 'compact'; reason = '接近上下文硬上限，必须压缩' }
    else if (options.force) { recommendation = 'compact'; reason = '用户强制压缩' }
    else if (!enoughChunk) { reason = '待压缩块太小，摘要成本不划算' }
    else if (pressure >= 0.82) { recommendation = 'compact'; reason = '上下文压力超过软阈值' }
    return {
      recommendation, reason, keepLast,
      freshMessages: fresh.length,
      chunkMessages: chunk.length, chunkTokens, tailTokens,
      lastPromptTokens, pressure, maxContextTokens: maxContext,
      estimatedSummaryTokens, policy,
    }
  }

  async compact(messages, options = {}) {
    const abortSignal = options.abortSignal || null
    const throwIfAborted = () => {
      if (abortSignal?.aborted) throw new Error('CompactAborted')
    }
    const analysis = this.analyze(messages, options)
    if (analysis.recommendation === 'noop') return { messages, summary:null, compacted:false, strategy:'noop', analysis }
    if (analysis.recommendation !== 'compact') return { messages, summary:null, compacted:false, strategy:'deferred', analysis }

    const toSummarize = messages.slice(0, -analysis.keepLast)
    const toKeep = messages.slice(-analysis.keepLast)
    if (!toSummarize.length) return { messages, summary:null, compacted:false, strategy:'noop', analysis }

    const originalTokens = this._estimateTokens(toSummarize)
    let summary = null
    let strategy = 'summary'

    if (options.summarize === false) {
      summary = this._fallbackDigest(toSummarize)
      strategy = 'fallback_digest'
    } else {
      // PTL（prompt too long）砍头重试：待摘块本身超长导致摘要请求失败时，
      // 砍掉最旧的 1/4 再试（对齐官方 truncateHeadForPTLRetry）。最多砍 2 次。
      let workSet = toSummarize
      for (let ptl = 0; ptl <= 2; ptl++) {
        summary = await this.summarizeMessages(workSet, options.customInstruction, abortSignal)
        if (summary) {
          if (ptl > 0) strategy = 'summary_ptl_retry'
          break
        }
        // 空响应是中转站常见偶发故障，先原样重试一次（不砍头）
        if (ptl === 0 && workSet.length === toSummarize.length) {
          this.logger.info?.('[Compact] 首次摘要未成功，原样重试一次')
          summary = await this.summarizeMessages(workSet, options.customInstruction, abortSignal)
          if (summary) break
        }
        if (ptl < 2 && workSet.length > 8) {
          const cut = Math.max(1, Math.floor(workSet.length / 4))
          workSet = workSet.slice(cut)
          this.logger.info?.(`[Compact] 疑似摘要请求超长，砍最旧 ${cut} 条重试 (${ptl + 1}/2)`)
        }
      }
      if (!summary) {
        summary = this._fallbackDigest(toSummarize)
        strategy = 'fallback_summary'
        this.logger.warn?.('[Compact] 摘要模型多次均失败，已降级为机械摘要（质量显著下降）')
      }
    }

    // 【2026-10-21 摘要不截断】
    //
    // 原来这里过 _truncateSummary(..., 16000)，超长就「按段落边界截断保尾部」。
    // 后果是长摘要的前半段（Primary Request / Key Concepts / Files）被砍掉，
    // 只留最后的 Current Work —— 而那几段恰恰是后续工作最需要的背景。
    // 实测一次 /compact 生成 23000+ 字符，被砍到 16000，丢了约 1/3。
    // 摘要本身就是「历史信息的浓缩」，再截一次等于二次有损压缩，没有理由。
    // 现在原样保留完整摘要（token 成本由压缩本身已经换取，不该在这里省）。
    let trimmed = this._formatSummary(String(summary))

    // compact 差集重注入：列出被摘要的消息里通过 Read/Grep/Glob 等读过的文件路径。
    // 压缩后模型引用这些路径时直接引摘要中的内容，不重复 Read。
    // 对照官方 context-collapse：读过的文件不再重注入附件，摘要默认省 ~25K tokens/次。
    const readPaths = toSummarize
      .flatMap(m => Array.isArray(m.content) ? m.content : [m.content])
      .filter(b => b?.type === 'tool_use')
      .filter(b => ['Read', 'Grep', 'Glob', 'LS', 'HashlineGrep'].includes(b?.name))
      .map(b => b?.input?.file_path || b?.input?.pattern || b?.input?.path)
      .filter(Boolean)
    // 保留尾部里已读过这些文件→不再重复读
    const keepPaths = new Set(
      toKeep.flatMap(m => Array.isArray(m.content) ? m.content : [m.content])
        .filter(b => b?.type === 'tool_use')
        .map(b => b?.input?.file_path || b?.input?.pattern || b?.input?.path)
        .filter(Boolean)
    )
    const lostPaths = [...new Set(readPaths)].filter(lp => !keepPaths.has(lp)).slice(0, 60)
    if (lostPaths.length) {
      trimmed += '\n\n【compact 前已读过的文件，以下内容已在摘要中，直接引用即可：】\n'
        + lostPaths.join(', ')
    }

    const segment = {
      role: 'user',
      content: `[历史摘要]\n${trimmed}`,
    }
    const result = [segment, ...toKeep]
    this.logger.info?.(`[Compact] ${toSummarize.length} 条 / ~${originalTokens} tokens → 摘要段 / ~${this._estimateTokens([segment])} tokens；保留最后 ${toKeep.length} 条 (${strategy})`)
    return { messages:result, summary:trimmed, compacted:true, strategy, originalTokens, analysis }
  }

  status(messages, options = {}) { return this.analyze(messages, options) }

  _isSummary(message) {
    const text = this._getText(message).trim()
    return SEGMENT_RE.test(text) || LEGACY_RE.test(text)
  }
  // 对齐官方 formatCompactSummary：剥离 <analysis> 草稿区，<summary> 标签换成可读标题
  _formatSummary(summary) {
    let s = String(summary)
    s = s.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
    const m = s.match(/<summary>([\s\S]*?)<\/summary>/)
    if (m) s = s.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(m[1] || '').trim()}`)
    s = s.replace(/\n{3,}/g, '\n\n')
    return s.trim()
  }


  _estimateTokens(messages) { return Math.ceil(JSON.stringify(messages || []).length / 4) }

  _getText(m) {
    if (typeof m?.content === 'string') return m.content
    if (Array.isArray(m?.content)) return m.content.map(b => b.type === 'text' ? b.text : '').join(' ')
    return ''
  }
  _fallbackDigest(messages) {
    const lines = []
    for (const m of messages) {
      const text = this._getText(m).replace(/\s+/g, ' ').trim()
      if (text) lines.push(`${m.role === 'user' ? '用户' : '助手'}: ${text.slice(0,260)}`)
      if (lines.length >= 12) break
    }
    return `未调用摘要模型的保守摘要：\n${lines.join('\n')}`
  }

  // 剥掉历史中已有的 [历史摘要] 前缀，避免摘要套娃（实测会出现
  // 「用户: [历史摘要] <!-- 历史对话已中断 -->」这种把上次压缩产物当用户原话的情况）
  _stripNestedSummary(text) {
    return String(text)
      .replace(/^\[历史摘要\]\s*/g, '')
      .replace(/未调用摘要模型的保守摘要：\s*/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
  }

  async summarizeMessages(messages, customInstruction = null, abortSignal = null) {
    const throwIfAborted = () => {
      if (abortSignal?.aborted) throw new Error('CompactAborted')
    }
    const text = messages.map(m => {
      const role = m.role === 'user' ? '用户' : '助手'
      if (typeof m.content === 'string') return `${role}: ${m.content}`
      if (Array.isArray(m.content)) return `${role}: ` + m.content.map(b => {
        if (b.type === 'text') return b.text
        // 【工具调用参数与结果同样不截断】
        //
        // 原来这里各砍一刀（参数 200、结果 240 字符）。对「读代码」类工作这是致命的：
        // 一条 `sed -n '1572150,1572200p' claude.js` 的输出约 3000 字符，
        // 砍到 240 只剩一行开头 —— 摘要模型根本看不到查到了什么，
        // 于是「今天调研过 claude.js」这件事在摘要里彻底消失。
        if (b.type === 'tool_use') return `[调用工具: ${b.name}(${JSON.stringify(b.input)})]`
        if (b.type === 'tool_result') return `[工具结果${b.is_error?'(错误)':''}: ${String(b.content)}]`
        return `[${b.type}]`
      }).join(' ')
      return `${role}: `
    }).map(s => this._stripNestedSummary(s)).filter(Boolean).join('\n\n')
    const instruction = customInstruction
      ? `${customInstruction}\n\n${text}`
      : `${NO_TOOLS_PREAMBLE}

你的任务：为接下来的对话生成一份详细的交接摘要，让另一个 LLM 能无缝继续工作。摘要要完整保留继续开发所需的技术细节、代码模式和架构决策。

在给出最终摘要前，先用 <analysis> 标签组织你的分析（这份草稿会在使用前被剥离，不影响上下文）：
1. 按时间顺序逐条分析每条消息：用户的明确请求与意图；采取的方案；关键决策、技术概念、代码模式；具体细节（文件名、代码片段、函数签名、文件编辑）；遇到的错误及修复方式；特别注意用户纠正过的地方。
2. 核对技术准确性和完整性。

然后用 <summary> 标签输出摘要，包含以下九个部分：

1. Primary Request and Intent：详细记录用户的所有明确请求和意图
2. Key Technical Concepts：列出重要的技术概念、技术栈和框架
3. Files and Code Sections：枚举查看/修改/创建的文件和代码段，附关键代码片段，说明该文件为何重要
4. Errors and fixes：列出的所有错误及修复方式，特别是用户纠正过的地方
5. Problem Solving：已解决的问题和进行中的排查
6. All user messages：列出全部非工具结果的用户消息原文（这对理解用户反馈和意图变化至关重要）
7. Pending Tasks：用户明确要求但尚未完成的任务
8. Current Work：精确描述摘要请求前正在做什么（含文件名和代码片段）
9. Optional Next Step：与最近工作直接相关的下一步。必须引用最近对话的原文证明任务接续点，防止任务漂移。若上一任务已结束，不要自作主张列新步骤

输出格式：
<analysis>
[你的逐条分析过程]
</analysis>
<summary>
1. Primary Request and Intent: ...
...
9. Optional Next Step: ...
</summary>

如果有额外的摘要指令（如用户自定义关注点），优先遵循这些指令。

${text}`
    try {
      // maxTokens 原为 500，装不下提示词要求的六个栏目 + 原样保留的路径/URL/命令，
      // 模型只能靠删细节来适配限额。提到 1600 与 trimmed 的 1800 字符上限相称。
      throwIfAborted()
      // 【2026-10-21 摘要请求必须关思考】
      //
      // 原来写死 'medium'，实测（同一份 1019213 字符输入、同一个模型）：
      //   effort=max     输出   402 字符  completion=488    reasoning=303
      //   effort=medium  输出   215 字符  completion=244    reasoning=117
      //   effort=none    输出 23359 字符  completion=12292  reasoning=0
      // 开思考时输出只有几百字符，用户看到的就是「/compact 只生成几十个字」。
      // 摘要任务是「按九段格式整理已有内容」，不需要推理，关掉即可。
      const r = await this.api.createMessage({
        system:'你是上下文摘要助手。只总结给定的历史对话块，先判断每项任务在历史末尾的最终状态，再输出事实记录。完成事项不得写成待办；没有原文证据不得制造未完成项或下一步。不得编造完成状态。',
        messages:[{ role:'user', content:instruction }], maxTokens:SUMMARY_MAX_TOKENS,
        abortSignal, thinkingEffort:'none',
      })
      const out = r?.choices?.[0]?.message?.content?.trim()
      if (out) return out
      this.logger.info?.('[Compact] 摘要模型返回空内容')
      return null
    } catch (e) {
      // 用户主动取消（Ctrl+C）不吞：上抛给 compact() → 命令层提示"已取消"
      if (e.message === 'CompactAborted') throw e
      // API 层的 abort 是 Interrupted/ABORT_ERR —— 同样视为用户取消，转成 CompactAborted 上抛
      if (abortSignal?.aborted || e.code === 'ABORT_ERR' || e.name === 'AbortError') {
        throw new Error('CompactAborted')
      }
      // 524（CF 网关超时）/网络抖动：等 2s 重试一次。源站第二次通常更快（负载/缓存）。
      if (/524|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(e.message) && !this._compactRetryDone) {
        this._compactRetryDone = true
        this.logger.info?.('[Compact] 摘要请求网关超时(524?)，2s 后重试一次')
        await new Promise(r => setTimeout(r, 2000))
        try {
          const r2 = await this.api.createMessage({
            system:'你是上下文摘要助手。只总结给定的历史对话块，先判断每项任务在历史末尾的最终状态，再输出事实记录。完成事项不得写成待办；没有原文证据不得制造未完成项或下一步。不得编造完成状态。',
            messages:[{ role:'user', content:instruction }], maxTokens:SUMMARY_MAX_TOKENS,
            abortSignal, thinkingEffort:'none',
          })
          const out2 = r2?.choices?.[0]?.message?.content?.trim()
          if (out2) { this._compactRetryDone = false; return out2 }
        } catch (e2) {
          if (e2.message === 'CompactAborted') throw e2
          this.logger.info?.(`[Compact] 重试仍失败: ${e2.message}`)
        } finally {
          setTimeout(() => { this._compactRetryDone = false }, 0)
        }
      }
      this.logger.info?.(`[Compact] 摘要失败: ${e.message}`)
      return null
    }
  }
}

export { DEFAULT_POLICY as DEFAULT_CACHE_AWARE_POLICY }
