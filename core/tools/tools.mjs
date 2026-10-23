// Claude Code Mobile - Tool 抽象 + 工厂模式
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 默认工具配置（安全优先）
const TOOL_DEFAULTS = {
  isReadOnly: () => false,           // 只读工具（Read/Grep/Glob 等标记为 true）
  isDestructive: () => false,        // 破坏性操作（Bash rm 等标记为 true）
  isConcurrencySafe: () => false,    // 可并行执行
  // 超过此大小时截断（保头尾 + 完整结果写盘）。
  // 不写死 30000：跟官方一样允许 BASH_MAX_OUTPUT_LENGTH 覆盖。
  maxResultSizeChars: null,
  validateInput: null,               // 参数校验函数 (input) => { valid: bool, errors?: [] }
  // 权限检查（默认允许）
  checkPermissions: (input) => ({ behavior: 'allow', updatedInput: input }),
}

// buildTool 工厂：合并默认值
export function buildTool(def) {
  return { ...TOOL_DEFAULTS, ...def }
}

/**
 * 延迟加载清单：这些工具的 schema 每轮全量发是浪费，标 shouldDefer 后只输出占位，
 * 模型要用时经 ToolSearch 取回完整 schema。
 *
 * 【收录标准 —— 三条同时满足】
 *   1. 低频：正常会话里几十轮才可能用一次，模型不查说明也不会调；
 *   2. 有辨识度：光看名字 + searchHint 就能判断「是不是我要的」，不需要读参数；
 *   3. schema 够大：占位本身约 150 字符，schema 小于 200 的省不出什么还多一次调用。
 *
 * 【为什么不放在各自工具文件里标 shouldDefer】那些文件不在本次改动范围，
 * 且集中一处更便于审「到底谁被延迟了」。MCP 工具、DSH 插件工具等运行时注册的
 * 一律不延迟 —— 它们本来就不是每轮都在，且 schema 来源不受我们控制。
 *
 * 【故意不延迟的核心工具】Bash/Read/Write/Edit/Grep/Glob/CodeSearch/Diagnostics/
 * TodoWrite/Agent/AgentStatus/AgentOutput/AgentStop/Task 系列/Team 系列/SendMessage/
 * CheckMessages/Memory/Skill/CommandExec/ViewImage/Screencap/WebSearch/SearchInfo/
 * Lookup/WebFetch/FindImage/GitStatus/GitDiff/GitLog/EnterPlanMode/ExitPlanMode ——
 * 这些每轮都可能用，延迟反而凭空多一次工具调用。
 */
export const DEFERRED_TOOLS = new Set([
  // GitHub 工具集：整个按需，没配 /github repo 时根本用不上
  'GitHubRepo', 'GitHubIssues', 'GitHubIssueView', 'GitHubPRs', 'GitHubPRComments',
  'GitHubComment', 'GitHubCreateIssue', 'GitHubFile',
  // 生图 / 视频：明确的任务型工具，来活才用
  'ImageGen', 'ViewVideo',
  // Hashline 系列：精确锚点编辑，Read/Edit 覆盖绝大多数场景
  'HashlineRead', 'HashlineEdit', 'HashlineGrep',
  // 手机操作低频项：phone_snapshot / phone_click / phone_type / phone_app 是主力，不延迟；
  // 这四个要么是诊断通道，要么是兜底路径，正常流程走不到
  'phone_shell', 'phone_screenshot', 'phone_tap_xy', 'phone_wait', 'phone_vd',
  // DSH 插件宿主管理：普通会话完全不碰
  'DshPlugin',
  // 目标契约：/goal 场景专用，日常对话用不到
  'GetGoal', 'GoalStatus', 'ProposeGoal', 'SetGoalBudget',
  // 定时 / 唤醒：低频。CronList/CronDelete 同时在 EXCLUDED（schema 比占位还短），
  // 实际不会被标记，留在这里只是记录「评估过」—— 真正生效的是下面那个集合。
  'CronCreate', 'CronDelete', 'CronList', 'Sleep',
  // worktree：只有用户明确说 worktree 才用
  'EnterWorktree', 'ExitWorktree',
  // 多 Agent 辅助：Agent 系列主力不延迟，这些是查询/记忆类
  'AgentMemory', 'ListAgents', 'ReleaseHeldMessages', 'SendMessagePeer',
  // 仓库结构分析：大仓库才用，且 RepoMap/Symbols 常配 Bash 兜底
  'RepoMap', 'Symbols', 'SafeRename',
  // 补丁 / 测试 / 笔记本：NotebookEdit 只在 .ipynb 出现时才有意义
  'NotebookEdit', 'ApplyPatch', 'Test',
  // 装饰性 / 一次性：Toast/Notify/Vibrate/TTS/Share/OpenUrl 都是「告诉用户一件事」
  'Toast', 'Notify', 'Vibrate', 'TTS', 'Share', 'OpenUrl',
  // 模式切换开关：模型自己切 deep/watch/plan 的场景很少，且命令里也能切
  'EnterDeepMode', 'ExitDeepMode', 'EnterWatch', 'ExitWatch',
])

/**
 * 延迟白名单里的例外 —— 已实测「占位比完整 schema 还长」或收益为负，不延迟。
 * 留档是为了下次有人想把它们加回来时，不用重新测算一遍。
 * 测算脚本：/sdcard/Download/claude-workspace/audit/calc-defer.mjs
 */
export const DEFERRED_EXCLUDED = new Set([
  'Battery', 'ClipboardSet', 'TeamStatus', 'CronList', 'CronDelete',
])

/**
 * 把清单应用到 registry：命中即标 shouldDefer，未命中的一律清零。返回实际标记的数量。
 *
 * 【为什么要把未命中的 shouldDefer 清掉】tools-teams.mjs / tools-goal.mjs 里有两个工具
 * 自带 `shouldDefer: true`（官方 claude.js 的原始写法）。其中 SendMessage 是多 Agent
 * 的核心通道，延迟它等于「给队友发消息前要先检索一次」，纯属倒贴；而这两个文件不在
 * 本次改动范围。所以在这里做归一：**只有白名单说话算**，别处自带的标记一律失效。
 * 单一真相源比「白名单 + 散落的 true」好审。
 */
export function applyDeferredTools(registry) {
  let n = 0
  for (const t of registry.list()) {
    if (!t || typeof t.shouldDefer !== 'boolean') continue
    const want = DEFERRED_TOOLS.has(t.name) && !DEFERRED_EXCLUDED.has(t.name)
    t.shouldDefer = want
    if (want) n++
  }
  return n
}

// 输出检查器：超过限制时把完整结果写磁盘，返回摘要
const TOOL_OUTPUT_DIR = join(homedir(), '.claude-code-mobile', 'tool-output')

/**
 * 输出上限。官方用 BASH_MAX_OUTPUT_LENGTH 环境变量覆盖，
 * 默认 30000、上限 150000（src/utils/shell/outputLimits.ts）。这里对齐同名变量。
 */
export const TOOL_OUTPUT_DEFAULT = 30000
export const TOOL_OUTPUT_UPPER_LIMIT = 150000
// 落盘文件硬上限：对标官方 2.1.265（1 GB cap on tool results saved to disk）。
// 超过即截断写入，防失控任务（cat 超大文件/无限循环日志）写满手机磁盘。
export const TOOL_SAVED_FILE_MAX_BYTES = 1024 * 1024 * 1024
export function getMaxOutputLength(fallback = TOOL_OUTPUT_DEFAULT) {
  const raw = process.env.BASH_MAX_OUTPUT_LENGTH
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, TOOL_OUTPUT_UPPER_LIMIT)
}

function truncateResult(content, maxChars, toolName, toolId = '') {
  // ⚠️ 对象**不能**在这里 String()。
  //
  // 【踩过的坑】原实现开头是 `if (typeof content !== 'string') content = String(content)`，
  // 于是任何返回对象的工具（最典型：phone_screenshot / ViewImage 的
  // `{__type:'vision', text, path, images}`）到这里就变成 "[object Object]" ——
  // 而且它只有 15 个字符，**长度远小于 maxChars，会原样返回**，
  // 所以连「截断」的日志都不会有，看着像工具自己返回了这个诡异的字符串。
  //
  // 后果不只是显示难看：`__type:'vision'` 被抹掉后，agent 的识图旁路
  // （把图片作为多模态 user 消息注入）永远不触发 —— 截图功能整个失效，
  // 但调用方看到的是 ok:true，没有任何报错。
  //
  // 【为什么结构化结果直接放行】`maxChars` 是给**文本**输出用的预算
  // （默认 30000 字符）。图片 base64 动辄几百 KB，拿同一把尺子量必然超，
  // 然后就被"截断"成字符串 —— 等于又把这个功能毁掉。
  // 这类结果由 agent 按 `__type` 分派（vision 走多模态注入、其它走各自的
  // 渲染通道），体积控制是它们各自的责任，不该在这里二次处理。
  if (typeof content !== 'string') {
    if (content && typeof content === 'object' && content.__type) return content
    // 其它普通对象：用 JSON 量体积，超了才降级（保留 JSON 形态，别用 String() 毁结构）
    let serialized
    try { serialized = JSON.stringify(content) } catch { return content }
    if (serialized === undefined || serialized.length <= maxChars) return content
    content = serialized
  }
  if (content.length <= maxChars) return content
  // 写完整结果到磁盘（~/.claude-code-mobile/tool-output/，可读可写）
  try { if (!existsSync(TOOL_OUTPUT_DIR)) mkdirSync(TOOL_OUTPUT_DIR, { recursive: true }) } catch {}
  const filePath = join(TOOL_OUTPUT_DIR, `tool-${toolName}-${Date.now() % 100000}${toolId || ''}.txt`)
  // 1GB 硬上限：只写前 1GB，多余部分丢弃。模型上下文拿到的本来只有摘要，
  // 截断不影响对话；目的是保住手机存储不被单任务写满。
  let savedFull = true
  try {
    if (Buffer.byteLength(content) > TOOL_SAVED_FILE_MAX_BYTES) {
      const buf = Buffer.from(content, 'utf-8')
      writeFileSync(filePath, buf.subarray(0, TOOL_SAVED_FILE_MAX_BYTES))
      savedFull = false
    } else {
      writeFileSync(filePath, content)
    }
  } catch {}
  // 保留前 maxChars*0.5 和后 maxChars*0.3，中间省略号
  const headLen = Math.floor(maxChars * 0.5)
  const tailLen = Math.floor(maxChars * 0.3)
  const head = content.slice(0, headLen)
  // 文件被 1GB 截断时尾部不在磁盘上，tail 只在完整写入时才有意义
  const tail = savedFull ? content.slice(-tailLen) : ''
  // 官方会标出省略了多少行（`... [N lines truncated] ...`）——只说字符数的话，
  // 模型不知道自己漏看了多大一块。这里两个都给。
  const omitted = content.slice(headLen, savedFull ? content.length - tailLen : content.length)
  const omittedLines = omitted ? omitted.split('\n').length : 0
  const note = `... [内容超限，省略 ${omittedLines} 行 / 共 ${content.length} 字符，完整结果已写 ${filePath}${savedFull ? '' : '（超过 1GB 上限，仅前 1GB 落盘）'}] ...`
  return `${head}\n\n${note}\n\n${tail}`
}

// 工具基类
export class Tool {
  constructor(config, ...args) {
    const opts = buildTool(config)
    this.name = opts.name
    this.description = opts.description
    this.input_schema = opts.input_schema
    // 新增元数据
    this._isReadOnly = opts.isReadOnly
    this._isDestructive = opts.isDestructive
    this._isConcurrencySafe = opts.isConcurrencySafe
    // null 表示没有单独指定 → 走全局上限（可被环境变量覆盖）
    this.maxResultSizeChars = opts.maxResultSizeChars ?? null
    this._validateInput = opts.validateInput
    this._checkPermissions = opts.checkPermissions
    // ── 官方工具元数据（2026-10-20 补齐）──────────────────────────────
    //
    // 【为什么必须在这里显式透传】buildTool 是 `{...默认值, ...def}`，
    // 子类写在 config 里的未声明 key 确实会进 opts —— 但构造器只赋上面那几个字段，
    // 其余的**当场丢失**。表现是：子类认真写了 `searchHint` / `aliases`，
    // 运行时读到的永远是 undefined，而且不报错，查起来极其费劲。
    //
    // 所以新增元数据一律要在这里落成实例字段，别指望「反正 spread 进来了」。

    /** 别名：模型可以用这些名字调本工具（官方 Agent 的 aliases 是 ["Task"]） */
    this.aliases = Array.isArray(opts.aliases) ? opts.aliases.slice() : []
    /** 工具检索用的一句话说明（CCM 暂无检索管线，先存着） */
    this.searchHint = opts.searchHint ?? null
    /** 后台运行策略：'never' | 'detach'（CCM 未实现自动后台化，先存） */
    this.backgrounding = opts.backgrounding ?? null
    /** 延迟加载标记（CCM 无 ToolSearch，仅存） */
    this.shouldDefer = opts.shouldDefer ?? false
    /**
     * 已被 ToolSearch 解除延迟 —— 运行时状态，不是构造参数。
     * undefined/false = 仍按占位输出；true = 输出完整 schema。
     * 见 toSchema() 的 shouldDefer 分支。
     */
    this._deferOverride = false
    /** UI 展示名（无则退回 name） */
    this.userFacingName = opts.userFacingName ?? null
    /** 结构化输出 schema。**只存不校验** —— CCM 没有结构化输出管线，
     *  硬校验会让现有全部工具（返回纯文本）当场失败。 */
    this.outputSchema = opts.outputSchema ?? null
    /** 权限分类器输入（CCM 的 checkPermissions 目前整包传 input，先存） */
    this.toAutoClassifierInput = typeof opts.toAutoClassifierInput === 'function'
      ? opts.toAutoClassifierInput
      : null
    /** 入参归一化：旧字段名 → 新字段名（见 run()） */
    this.coerceInput = typeof opts.coerceInput === 'function' ? opts.coerceInput : null

    this.mcpServer = null
    this.mcpTool = null
    // 保留额外参数（如 undoStore）
    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null) {
        Object.assign(this, arg)
      }
    }
  }

  // ctx: { signal } —— 需要支持取消的工具（如 Bash）可读取 ctx.signal 在超时/中断时杀子进程。
  // 不关心取消的工具直接忽略第二个参数，向后兼容。
  async execute(input, ctx = {}) { throw new Error('not implemented') }

  // 构造时元数据
  isReadOnly() { return this._isReadOnly() }
  // isDestructive 可以按输入判断（官方 ExitWorktree 就是 `(v) => v.action === 'remove'`）。
  // 传入 input 才有意义：不传时按「无参数」求值，参数化实现会得到 undefined，
  // 对 ExitWorktree 这种「看 action 决定」的工具会误判成「不破坏」。
  // 调用方（权限层）应该把 input 传进来；无参调用兜底成布尔 false，
  // 避免 `if (tool.isDestructive())` 拿到 undefined 这种半真半假的值。
  isDestructive(input) { return !!this._isDestructive(input) }
  isConcurrencySafe() { return this._isConcurrencySafe() }

  // 参数校验：统一返回 { valid, errors }
  //
  // 【2026-08-30 加归一化，修 AgentMemory/AgentStatus 崩溃】
  // 框架约定返回 { valid, errors }，但部分工具（子类覆写 validateInput）用的是
  // 「返回字符串 = 错误信息 / 返回 null = 通过」这种更直观的风格。
  // run() 里直接访问 v.valid，遇到 null 就抛 `Cannot read properties of null
  // (reading 'valid')` —— AgentMemory 读写双向全挂、AgentStatus 同理，
  // 导致「子 Agent 分类型长期记忆」这条能力静默失效（没人发现自己没收到经验注入）。
  //
  // 根因是隐式契约没有强制：约定写在注释里，子类覆写时无人校验。
  // 这里做归一化，两种风格都接受——修的是「这类错误还会再犯」而不只是这两个工具。
  validateInput(input) {
    if (!this._validateInput) return { valid: true }
    return this._normalizeValidation(this._validateInput(input))
  }

  // 把各种返回风格归一成 { valid, errors: string[] }
  _normalizeValidation(r) {
    if (r == null) return { valid: true }                        // null/undefined = 通过
    if (typeof r === 'string') {                                  // 字符串 = 错误信息
      return r.trim() ? { valid: false, errors: [r] } : { valid: true }
    }
    if (Array.isArray(r)) {                                       // 数组 = 错误列表
      return r.length ? { valid: false, errors: r.map(String) } : { valid: true }
    }
    if (typeof r === 'boolean') return { valid: r, errors: r ? [] : ['参数校验未通过'] }
    if (typeof r === 'object') {
      // 标准风格；errors 容错单个 error 字段
      const errors = r.errors != null
        ? (Array.isArray(r.errors) ? r.errors.map(String) : [String(r.errors)])
        : (r.error != null ? [String(r.error)] : [])
      return { valid: r.valid !== false, errors }
    }
    return { valid: true }
  }

  // 权限检查
  async checkPermissions(input) {
    return this._checkPermissions(input)
  }

  // 包装执行：校验 → 权限 → 执行 → 截断
  // ctx 透传给 execute，里面带 signal（由 Agent 在超时/中断时 abort）
  async run(input, ctx = {}) {
    // ── 入参归一化（旧字段名 → 新字段名）──────────────────────────
    //
    // 【为什么放在 validateInput 之前】coerceInput 的用途就是把「模型按旧 schema
    // 传的字段」翻译成新字段。放校验之后就晚了 —— 校验会因为「必填字段缺失」先拒掉，
    // 模型拿到的错误是「缺 text」，而它明明传了 content，只会越改越乱。
    //
    // 【为什么必须是新对象】调用方的 input 可能还被别处引用（trace 记录、
    // 权限规则匹配、UI 渲染工具卡片）。原地改会污染那些读取方，
    // 且一旦 coerceInput 抛错，input 已经被改了一半 —— 状态不可回滚。
    //
    // coerceInput 返回值约定：
    //   · 返回对象 → 用它（视为已归一化）
    //   · 返回 null/undefined → 认为无需改动，沿用原 input
    // 两种都接受，避免子类为「无需改动」分支额外写 return input。
    let effectiveInput = input
    if (this.coerceInput) {
      let coerced
      try {
        coerced = this.coerceInput(input)
      } catch (e) {
        // 归一化失败不该让整个工具调用挂掉 —— 退化成用原始 input 继续，
        // 让后面的 validateInput 给出正常的字段错误提示。
        coerced = null
      }
      if (coerced && typeof coerced === 'object') effectiveInput = coerced
    }

    // 参数校验：失败时给出清晰提示（已收到参数 vs schema 要求），引导模型修正重试而非放弃
    // 再归一化一次：子类可能整体覆写 validateInput（绕过基类的归一化），
    // 这里兜底保证 v 一定是 { valid, errors } 形状，永不出现 null.valid 崩溃。
    const v = this._normalizeValidation(this.validateInput(effectiveInput))
    if (!v.valid) {
      const errors = (v.errors || []).join('; ')
      // 统计已收到的参数名
      const received = effectiveInput && typeof effectiveInput === 'object'
        ? Object.keys(effectiveInput).filter(k => effectiveInput[k] !== undefined && effectiveInput[k] !== null && effectiveInput[k] !== '')
        : []
      const receivedStr = received.length ? received.join(', ') : '(无)'
      // 统计 schema 要求的必填参数
      const schema = this.input_schema?.properties || {}
      const required = (this.input_schema?.required || []).filter(r => !received.includes(r))
      const requiredStr = required.length ? required.join(', ') : '(无)'
      throw new Error(
        `工具参数校验失败: ${errors}\n` +
        `  · 工具: ${this.name}\n` +
        `  · 已收到参数: ${receivedStr}\n` +
        `  · 缺失/无效的必填参数: ${requiredStr}\n` +
        `  · 修正后重试本次工具调用（不要放弃任务，流程可继续）`
      )
    }
    // 权限检查
    const perm = await this.checkPermissions(effectiveInput)
    if (perm.behavior === 'deny') {
      throw new Error(`权限被拒绝: ${perm.message || '操作未获授权'}`)
    }
    // 执行
    const result = await this.execute(perm.updatedInput || effectiveInput, ctx)
    // 结果截断
    //
    // 上限可以是「按输入动态算」的：工具可实现 getMaxResultSizeChars(input)，
    // 由它决定这一次的上限（例如 Read 的 allow_large 会抬高上限）。没实现就
    // 沿用构造时写死的 maxResultSizeChars。传 input 是为了让「用户明确要求
    // 读全部」这类意图能突破默认截断，而不是被迫反复分页。
    const limit = typeof this.getMaxResultSizeChars === 'function'
      ? (this.getMaxResultSizeChars(perm.updatedInput || effectiveInput) ?? this.maxResultSizeChars ?? getMaxOutputLength())
      : (this.maxResultSizeChars ?? getMaxOutputLength())
    return truncateResult(result, limit, this.name)
  }

  /**
   * 转成 API 工具 schema。
   *
   * 【shouldDefer 的消费点】`shouldDefer: true` 的工具只输出**占位 schema**：
   * name + 一句话 description（含 ToolSearch 提示）+ 空 parameters。
   * 完整参数说明由 ToolSearch 取回后再切回 `this._deferOverride === true` 的完整态。
   *
   * 【为什么在 toSchema 里判状态，而不是只由 registry 过滤】
   * agent.mjs 两处都是 `this.tools.map(t => t.toSchema())`，而 this.tools 持有的是
   * **同一批 Tool 实例引用**。所以标志位翻转在实例上即可影响下一轮请求，
   * 不需要 agent.mjs 参与 —— 这也是「延迟加载不改 agent」的原因。
   *
   * 【__deferred 是给谁看的】本地标记。api.mjs 三种协议都只取
   * name/description/input_schema，未知字段不会外发（已核实 openai 1297、
   * anthropic 1831、responses 1478 三处 map）。
   */
  toSchema() {
    if (this.shouldDefer && this._deferOverride !== true) return this._deferredSchema()
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema
    }
  }

  /** 占位 schema：只留名字和一句话，让模型知道「有这个工具，细节要检索」 */
  _deferredSchema() {
    return {
      name: this.name,
      description: this._deferredDescription(),
      input_schema: { type: 'object', properties: {} },
      __deferred: true,
    }
  }

  /**
   * 占位 description。优先用 searchHint（本来就是一句话检索说明），
   * 没有则从完整 description 里截第一段 —— 完整 description 往往上千字符，
   * 全放进去等于没省。
   */
  _deferredDescription() {
    const raw = String(this.searchHint || '').trim() || String(this.description || '').split('\n')[0].trim()
    const brief = raw.length > 110 ? raw.slice(0, 107) + '...' : raw
    return `（延迟加载）${brief || '工具'}。用 ToolSearch(query/select) 取完整参数说明`
  }

  /** 解除延迟：下一轮 toSchema() 输出完整 schema。幂等。 */
  undefer() {
    this._deferOverride = true
    return this
  }
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map()
    // 小写名 → 正式名 的索引（大小写不敏感查找用）。
    // 用独立 Map 而不是遍历 this.tools：get() 在每轮工具调用都要走，
    // 遍历 100+ 个工具只为找一个名字是纯浪费。
    this._lower = new Map()
    // 别名（小写）→ 正式名。官方 Agent 的 aliases 是 ["Task"]，
    // 模型按 Task 调会落到这里，而不是 Tool not found。
    this._aliases = new Map()
  }

  /** 内部：登记小写索引（重名时后者覆盖，与 Map.set 行为一致） */
  _indexLower(name) {
    this._lower.set(String(name).toLowerCase(), name)
  }

  /**
   * 登记一个工具的别名。
   *
   * 【只做单向映射，不写进 this.tools】别名不是独立工具：
   * 写进 tools 会让 list()/toSchemas() 重复输出同一个工具的两份 schema，
   * 模型会看到 `Read` 和它的别名各一条 —— 既浪费 prompt，也会让它以为
   * 两者行为不同。别名只影响「按名取」。
   *
   * 【不覆盖真名】如果别名恰好和某个已注册工具同名，真名优先，
   * 别名忽略（否则 register 顺序会决定谁能被调到，极难排查）。
   */
  _indexAliases(t) {
    if (!t || !Array.isArray(t.aliases) || t.aliases.length === 0) return
    for (const a of t.aliases) {
      if (!a || typeof a !== 'string') continue
      const low = a.toLowerCase()
      // 与真名冲突时让位（含大小写不敏感冲突）
      if (this.tools.has(a) || this._lower.has(low)) continue
      this._aliases.set(low, t.name)
    }
  }

  register(t) {
    if (!(t instanceof Tool)) throw new Error('Must be Tool')
    this.tools.set(t.name, t)
    this._indexLower(t.name)
    this._indexAliases(t)
  }
  // 惰性注册：传工厂函数 (registry) => Tool，首次 get 时才实例化
  // 参考 OpenCode define+init：工具可声明依赖（如 undoStore/agent 服务），按需注入
  registerLazy(name, factory) {
    this.tools.set(name, { __lazy: true, name, factory })
    this._indexLower(name)
  }

  /**
   * 按名取工具。**大小写不敏感**，并支持别名。
   *
   * 【为什么】模型经常把工具名写错大小写（`Read` 写成 `read`、`GitStatus`
   * 写成 `gitstatus`、`WebSearch` 写成 `websearch`）。Claude 官方 API 的
   * tool_use.name 是模型生成的自由文本，各厂商模型（尤其非 Anthropic 的）
   * 大小写习惯不一致；以前这里精确匹配 → 模型明明调了正确的工具，却得到
   * `Tool "read" not found`，整轮白跑。
   *
   * 【为什么不用遍历】get() 在每次工具调用都走，100+ 工具时遍历是浪费；
   * 用 _lower / _aliases 索引 O(1)。
   *
   * 精确匹配优先（避免「注册了 Read 和 read 两个工具」时的歧义）。
   * 查找顺序：真名精确 → 真名大小写不敏感 → 别名大小写不敏感。
   */
  get(n) {
    let key = n
    let t = this.tools.get(key)
    if (t === undefined && typeof n === 'string') {
      // 大小写不敏感回退
      const canonical = this._lower.get(n.toLowerCase())
      if (canonical !== undefined) {
        key = canonical
        t = this.tools.get(key)
      }
    }
    if (t === undefined && typeof n === 'string') {
      // 别名回退（官方 Agent 的 aliases: ["Task"] 走这条）
      const aliased = this._aliases.get(n.toLowerCase())
      if (aliased !== undefined) {
        key = aliased
        t = this.tools.get(key)
      }
    }
    if (t && t.__lazy) {
      const real = t.factory(this)
      if (!(real instanceof Tool)) throw new Error(`Lazy tool ${key} factory must return Tool`)
      real.__name = key
      this.tools.set(key, real)
      // 惰性工具的真身可能是带别名的那一个 —— 实例化后再补登记一次
      this._indexAliases(real)
      return real
    }
    return t
  }
  list() { return Array.from(this.tools.values()).map(t => (t && t.__lazy) ? this.get(t.name) : t) }
  toSchemas() { return this.list().map(t => t.toSchema()) }

  // ── ToolSearch 延迟加载 ────────────────────────────────────────────────
  //
  // 三件套给 ToolSearch 工具用：检索（谁命中）、解除（切完整态）。
  // 都只动 `shouldDefer` 工具的运行时状态，不改注册表结构 —— 所以 MCP 工具
  // 晚到同步（index.mjs 重新赋 agent.tools）时不需要额外处理。

  /** 当前仍处于延迟态的工具（占位输出的那一批） */
  listDeferred() { return this.list().filter(t => t && t.shouldDefer && t._deferOverride !== true) }

  /**
   * 按关键词检索延迟工具。
   *
   * 命中优先级（降序）：name 命中 > searchHint 命中 > description 命中。
   * 只返回最高优先级那一档 —— 否则 `query:"phone"` 会连带命中 description 里
   * 提到 phone_wait 的 Sleep 之类，一次检索加载一堆无关工具，反而更浪费。
   *
   * 返回工具实例（不是 schema）—— 调用方决定是只报告还是顺便解除延迟。
   */
  searchDeferred(query) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return []
    const pool = this.listDeferred()
    const byName = pool.filter(t => String(t.name || '').toLowerCase().includes(q))
    if (byName.length > 0) return byName
    const byHint = pool.filter(t => String(t.searchHint || '').toLowerCase().includes(q))
    if (byHint.length > 0) return byHint
    return pool.filter(t => String(t.description || '').toLowerCase().includes(q))
  }

  /**
   * 解除延迟。返回 { ok, name }。
   * already=true 表示该工具本来就没延迟（模型重复 select 时会出现）——
   * 对调用方是有用信息，不算错误。
   */
  undefer(name) {
    const t = this.get(name)
    if (!t) return { ok: false, name: String(name), error: `工具不存在: ${name}` }
    if (!t.shouldDefer) return { ok: false, name: t.name, already: true }
    t.undefer()
    return { ok: true, name: t.name }
  }

  // 列出只读工具（可用于并行优化）
  listReadOnly() { return this.list().filter(t => t.isReadOnly()) }
  // 列出可并行工具
  listConcurrencySafe() { return this.list().filter(t => t.isConcurrencySafe()) }
}
