/**
 * CLI / Web 共用：工具注册 + 系统提示拼装
 * Web 壳必须走这里，避免和 CLI 两套行为。
 */
import { ToolRegistry, applyDeferredTools } from '../tools/tools.mjs'
import { ToolSearchTool } from '../tools/tools-toolsearch.mjs'
import { FileReadTool, FileWriteTool, FileEditTool, MultiEditTool, NotebookEditTool } from '../tools/file-tools.mjs'
import { GlobTool, GrepTool, CodeSearchTool } from '../tools/search-tools.mjs'
import { PTYBashTool } from './pty.mjs'
import { BashOutputTool, KillShellTool } from '../agent/bg-bash.mjs'
import { TodoWriteTool, WebFetchTool, AskUserSimpleTool } from '../tools/extra-tools.mjs'
import { GitStatusTool, GitDiffTool, GitLogTool, GitCommitTool, GitAddTool } from './git.mjs'
import { MultiUndoStore } from '../session/undo-multi.mjs'
import { SkillLoader, SkillTool, ensureGlobalSkillsDir, globalSkillsDir } from '../commands/skills.mjs'
import {
  PlanMode, EnterPlanModeTool, ExitPlanModeTool, CoordinatorMode,
  DeepMode, EnterDeepModeTool, ExitDeepModeTool, SubAgentTool, BUILTIN_SUBAGENT_TYPES,
} from '../agent/plan.mjs'
import { MemoryTool, UserInputHistoryTool, InputHistory } from '../agent/agent-tools.mjs'
import { CommandExecTool } from '../agent/agent-tools.mjs'
import { EnterWatchTool, ExitWatchTool } from '../agent/plan.mjs'
import { EnterWorktreeTool, ExitWorktreeTool } from '../tools/tools-worktree.mjs'
import { DshPluginTool } from '../tools/tools-dsh-plugin.mjs'
import { TavilySearchTool } from '../tools/tavily.mjs'
import { termuxTools } from '../phone/termux-tools.mjs'
import { HashlineReadTool, HashlineEditTool, HashlineGrepTool } from '../tools/tools-hashline.mjs'
import { ApplyPatchTool, TestTool, DiagnosticsTool, RepoMapTool, SymbolsTool, SafeRenameTool, SleepTool } from '../tools/tools-smart.mjs'
import { LspTool } from '../tools/lsp.mjs'
import { MonitorTool } from '../tools/tools-monitor.mjs'
import { ViewImageTool, ViewVideoTool, ScreencapTool } from '../tools/tools-vision.mjs'
import { ImageGenTool } from '../tools/tools-imagegen.mjs'
// 【Web 与 CLI 工具对齐】这五组工具以前只在 index.mjs（CLI 路径）注册，
// web/ 走的 engine-setup 一条都没有 —— 于是 Web 里 AI 看不到目标契约、
// 建不了任务/团队、连不了 GitHub、定不了定时任务。统一在 toolkit 里注册。
import { createGoalTools } from '../tools/tools-goal.mjs'
import { TASK_TOOLS } from '../tools/tools-tasks.mjs'
import { TEAM_TOOLS } from '../tools/tools-teams.mjs'
import { GITHUB_TOOLS } from '../tools/tools-github.mjs'
import { CronCreateTool, CronListTool, CronDeleteTool } from '../tools/tools-cron.mjs'
import { PHONE_TOOLS } from '../tools/tools-phone.mjs'
// 图库检索 + 多源资料搜索（2026-09-19 补）：
// 这四个原来只在 index.mjs（CLI）注册，engine-setup 连 import 都没有 ——
// 于是 Web 端 AI 用不了找图/识图/搜资料/展开全文。而 Web 还实现了 /pexels
// 命令去配 Pexels key，配了却没工具用（用户会以为坏了）。
import { FindImageTool } from '../tools/tools-image-search.mjs'
import { SearchInfoTool, LookupTool } from '../tools/tools-lookup.mjs'
// 子 Agent 管控（2026-09-19 补）：Web 早就能 spawn 子 Agent（Agent 工具在），
// 但拿不到状态/中止/输出/记忆 —— 长任务一旦派出去就失去控制，只能干等或杀掉整个服务。
import { AgentStatusTool, AgentStopTool, AgentOutputTool, ListAgentsTool } from '../tools/tools-agent-status.mjs'
import { SESSION_TOOLS } from '../tools/tools-sessions.mjs'
import { AgentMemoryTool } from '../tools/tools-agent-memory.mjs'
import { ClaudeMdLoader } from '../session/persistence.mjs'
import { SYSTEM_PROMPT, SESSION_START_PROMPT, interpolateEnvPrompt } from './prompts.mjs'
import { CustomCommandLoader, ensureCommandsDir } from '../commands/custom-commands.mjs'
import { CustomAgentLoader, ensureAgentsDir } from '../agent/custom-agents.mjs'
import { registerBuiltinPlugin } from '../integrations/plugins.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {object} opts
 * @param {function} [opts.askUser]  Web 可传占位；CLI 传真 askUser
 * @param {string} [opts.skillsDir]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.includeUserHistory=true]
 * @param {boolean} [opts.includeSubAgent=true]
 * @param {object} [opts.api]  SubAgent 需要
 * @param {function} [opts.onPermissionRequest]  根 Agent 与 SubAgent 共用权限裁决
 * @param {string} [opts.undoRoot]  可选独立 Undo 存储目录
 * @param {function|object} [opts.getRuntimeModelInfo] 当前 Provider/model/protocol（函数可动态刷新）
 * @param {function} [opts.commandExecHandler]  传了才注册 CommandExec 工具（Web 传自己的命令分发）
 * @param {function} [opts.watchModeSetter]     传了才注册 EnterWatch/ExitWatch（参数：on:boolean）
 * @param {boolean} [opts.includeDshPlugin=false] 是否注册 DshPlugin（默认不注册，显式开启）
 */
export function createEngineToolkit(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const skillsDir = opts.skillsDir || join(cwd, 'skills')
  // 全局 skills：与 commands/agents 一样挂在 ~/.claude/skills；项目目录优先
  const globalSkills = opts.globalSkillsDir || globalSkillsDir()
  try { ensureGlobalSkillsDir() } catch {}
  const askUser = opts.askUser || (async (q) => `(no UI) ${q}`)
  const baseSystemPrompt = opts.systemPromptBase || SYSTEM_PROMPT
  const sessionStartPrompt = opts.sessionStartPrompt || SESSION_START_PROMPT
  const contextFiles = opts.contextFiles === false
    ? []
    : (Array.isArray(opts.contextFiles) ? opts.contextFiles : ClaudeMdLoader.load(cwd))

  const multiUndo = new MultiUndoStore(opts.undoRoot)
  multiUndo.init()
  const inputHistory = new InputHistory(100, opts.historyFile, opts.sessionsDir)
  const planMode = new PlanMode()
  const deepMode = new DeepMode()
  // 协调者模式（对齐官方 Coordinator Mode）—— 见 core/plan.mjs 的 CoordinatorMode 注释
  const coordinatorMode = new CoordinatorMode()
  // 当前活跃 Agent 实例。调用方创建 Agent 后调 toolkit.attachAgent(agent) 接上，
  // 这样模式切换工具能立刻改到「正在跑的那一个」的 maxTurns（而不是只翻标志位）。
  let liveAgent = null
  const skillLoader = new SkillLoader(
    opts.skillsDirs || [skillsDir, globalSkills].filter(Boolean)
  )
  const commandRoots = opts.commandsDirs || [ensureCommandsDir(cwd), join(homedir(), '.claude', 'commands')]
  const agentRoots = opts.agentsDirs || [ensureAgentsDir(cwd), join(homedir(), '.claude', 'agents')]
  const customCommands = new CustomCommandLoader(commandRoots)
  const customAgents = new CustomAgentLoader(agentRoots)

  // 注册内置插件（示例：keepalive 提供保活状态命令）
  registerBuiltinPlugin({
    name: 'keepalive',
    description: '保活状态：显示 termux-wake-lock / 静音音频循环是否在运行',
    defaultEnabled: true,
  })

  const registry = new ToolRegistry()
  registry.register(new FileReadTool())
  registry.register(new FileWriteTool(multiUndo))
  registry.register(new FileEditTool(multiUndo))
  registry.register(new MultiEditTool(multiUndo))
  // NotebookEdit：.ipynb 单元格编辑（对齐官方 2.1.303），依赖 Read 的 cell 视图
  registry.register(new NotebookEditTool(multiUndo))
  registry.register(new PTYBashTool())
  registry.register(new BashOutputTool())
  registry.register(new KillShellTool())
  registry.register(new GlobTool())
  registry.register(new GrepTool())
  registry.register(new CodeSearchTool())
  registry.register(new TodoWriteTool())
  registry.register(new WebFetchTool())
  registry.register(new AskUserSimpleTool(askUser))
  registry.register(new GitStatusTool())
  registry.register(new GitDiffTool())
  registry.register(new GitLogTool())
  registry.register(new GitAddTool())
  registry.register(new GitCommitTool())
  registry.register(new SkillTool(skillLoader))
  if (opts.includeUserHistory !== false) {
    registry.register(new UserInputHistoryTool(inputHistory))
  }
  registry.register(new MemoryTool(opts.memoryPath || null, opts.memoryLabel || 'CLAUDE.md'))
  registry.register(new TavilySearchTool())
  registry.register(new HashlineReadTool())
  registry.register(new HashlineEditTool(multiUndo))
  registry.register(new HashlineGrepTool())
  registry.register(new ApplyPatchTool(multiUndo))
  registry.register(new TestTool())
  registry.register(new DiagnosticsTool())
  registry.register(new LspTool())
  // Monitor：后台命令输出推式通知（官方同名工具对齐）
  registry.register(new MonitorTool())
  registry.register(new RepoMapTool())
  registry.register(new SymbolsTool())
  registry.register(new SafeRenameTool(multiUndo))
  registry.register(new SleepTool())
  registry.register(new ViewImageTool())
  registry.register(new ViewVideoTool())
  if (opts.includeScreencap !== false) registry.register(new ScreencapTool())
  // 【2026-10-11 Present 下线】ImageGen 生成图片后仍要通知宿主展示 ——
  // 回调名保留 onPresent（它是「产出了可视内容」的通用通知），但不再有
  // Present 工具。Web 收到后 emit 'image' 事件，前端渲染成内联图。
  registry.register(new ImageGenTool({ onPresent: opts.onPresent }))
  if (opts.includeTermuxTools !== false) for (const t of termuxTools) registry.register(t)
  // 目标契约（跨轮自动推进的三件套：读契约 / 改状态 / 加预算）
  for (const t of createGoalTools(() => opts.sessionId || null)) registry.register(t)
  // 持久化待办（多 Agent 共享，跨重启存活）
  for (const t of TASK_TOOLS) registry.register(t)
  // 团队协作 + 定时任务 + GitHub
  for (const t of TEAM_TOOLS) registry.register(t)
  for (const T of GITHUB_TOOLS) registry.register(new T())
  // 图库检索与资料搜索：FindImage(以文找图) / SearchInfo(多源资料搜索) / Lookup(展开全文)。
  // 子 Agent 管控：查状态 / 中止 / 取输出 / 读写长期记忆。
  // getAgentType 返回 'main' —— Web 侧的调用者就是主 Agent（与 index.mjs:1193 一致）。
  registry.register(new AgentStatusTool())
  registry.register(new AgentStopTool())
  registry.register(new AgentOutputTool())
  // ListAgents 之前在 Web 端漏注册了 —— SendMessage 的 to 能填三种东西
  //（子 Agent 名 / 团队成员 / 广播），但 Web 里没有任何工具能列出「有哪些名字可用」，
  // 只能瞎猜，猜错就白跑一轮。CLI 侧 index.mjs 一直有，这里补齐。
  registry.register(new ListAgentsTool())
  // 跨会话（Web ↔ CLI）：ListSessions / SendMessagePeer / ReleaseHeldMessages
  for (const t of SESSION_TOOLS) registry.register(t)
  registry.register(new AgentMemoryTool({ getAgentType: () => 'main' }))
  registry.register(new FindImageTool())
  registry.register(new SearchInfoTool())
  registry.register(new LookupTool())
  registry.register(new CronCreateTool())
  registry.register(new CronListTool())
  registry.register(new CronDeleteTool())
  // 手机控制工具（Termux:API）：看屏/点屏/输入/滑动/按键/播报等 10 个。
  //
  // 【2026-09-19】原注释写「Web 默认也开，除非显式关掉」，但实现是 `=== true` 才注册
  // —— 注释与代码矛盾，而 Web 的 createEngineToolkit 调用（web/server.mjs:1679）
  // 根本没传这个参数，导致**整个 Web 端这 10 个工具全缺**。
  // CLI 不受影响：它在 index.mjs:911 自己无条件注册。
  // 现在 Web 已显式传 true；语义保持「显式开启」，避免无意间给 AI 本机控制权。
  if (opts.includePhoneTools === true) for (const T of PHONE_TOOLS) registry.register(new T())
  for (const t of (opts.extraTools || [])) registry.register(t)
  registry.register(new EnterPlanModeTool(() => planMode.enable()))
  registry.register(new ExitPlanModeTool(() => planMode.disable()))
  // 【和 index.mjs 同样的坑，这里原来漏了】只翻 deepMode 标志的话，**正在跑的那个
  // Agent 实例**的 maxTurns 还是旧值 —— 模型自己调 EnterDeepMode 后照样在原地被截停，
  // 它却以为续上了。CLI 侧 2026-09-17 修过同样的 bug（index.mjs:935），
  // Web / 其他 toolkit 使用者走的是本文件这条路径，必须一起同步。
  registry.register(new EnterDeepModeTool(() => {
    deepMode.enable()
    if (liveAgent) liveAgent.maxTurns = deepMode.getMaxTurns()
  }))
  registry.register(new ExitDeepModeTool(() => {
    deepMode.disable()
    if (liveAgent) liveAgent.maxTurns = deepMode.getMaxTurns()
  }))

  // 持续模式（watch）工具：只有调用方传了 setter 才注册。
  // CLI 在 index.mjs 自己注册（带 rl 交互），Web 传 runtime.agent 的 setter。
  if (typeof opts.watchModeSetter === 'function') {
    registry.register(new EnterWatchTool(() => opts.watchModeSetter(true)))
    registry.register(new ExitWatchTool(() => opts.watchModeSetter(false)))
  }

  // worktree 会话切换（对齐官方 2.1.303）。
  // 切的是**当前 Agent 实例的 cwd**：liveAgent 由 attachAgent 注入，
  // 每次工具调用都现取，所以 agent 换实例（新会话）后自动跟着走。
  const wtGetCwd = () => liveAgent?.cwd || cwd
  const wtSetCwd = (p) => { if (liveAgent) liveAgent.cwd = p }
  registry.register(new EnterWorktreeTool({ getCwd: wtGetCwd, setCwd: wtSetCwd }))
  registry.register(new ExitWorktreeTool({ getCwd: wtGetCwd, setCwd: wtSetCwd }))

  // CommandExec：跑程序内 slash 命令。CLI 在 index.mjs 传 handleCommand 注册；
  // Web 传自己的 executeSlashCommand 包装（避免两套命令实现漂移）。
  if (typeof opts.commandExecHandler === 'function') {
    registry.register(new CommandExecTool(opts.commandExecHandler))
  }

  // DSH 插件宿主管理（默认不注册 —— 只有显式开启的宿主才用得上）
  if (opts.includeDshPlugin === true) {
    registry.register(new DshPluginTool())
  }

  let subAgentTool = null
  if (opts.includeSubAgent !== false) {
    // 同 index.mjs：传函数而非快照，否则子 Agent 工具集里没有 'Agent' 自己，
    // 无法递归 spawn（SubAgentTool 在下面第 138 行才注册进 registry）
    subAgentTool = new SubAgentTool({
      api: opts.api || null,
      systemPromptBase: '',
      tools: () => registry.list(),
      onPermissionRequest: opts.onPermissionRequest || (async () => true),
      getSubagentTypes: () => customAgents.mergeInto(BUILTIN_SUBAGENT_TYPES),
      cwd,
      sessionId: opts.sessionId || null,
      // 同 index.mjs：子 Agent 继承 hooks，否则 hooks.json 里的 PreToolUse
      // 规则对子 Agent 不生效（权限漏洞），也拿不到 SubagentStart/Stop 事件。
      // opts 里没给就保持 null —— Web 等其它入口的行为不变。
      hookManager: opts.hookManager || null,
    })
    registry.register(subAgentTool)

    // 与 index.mjs 对齐：context: fork 的 skill 借 Agent 工具隔离执行。
    // SkillTool 注册得比 Agent 早，所以延迟到这里绑定。
    const skillToolRef = registry.get('Skill')
    if (skillToolRef) {
      skillToolRef.forkRunner = async ({ name, prompt, agent, model, effort, allowedTools }) => {
        const constraints = []
        if (model) constraints.push(`本次请使用模型 ${model}`)
        if (effort) constraints.push(`思考强度设为 ${effort}`)
        if (allowedTools && allowedTools.length) constraints.push(`只允许使用这些工具：${allowedTools.join(', ')}`)
        const finalPrompt = constraints.length
          ? `（执行约束：${constraints.join('；')}）\n\n${prompt}`
          : prompt
        const r = await subAgentTool.execute({
          description: `skill:${name}`,
          prompt: finalPrompt,
          subagent_type: agent || 'general-purpose',
        })
        return typeof r === 'string' ? r : JSON.stringify(r)
      }
    }
  }

  // ── ToolSearch 延迟加载 ────────────────────────────────────────────────
  //
  // 111 个工具的 schema 每轮全量发给 API 是最大的单项上下文开销。低频工具标
  // shouldDefer 后只输出占位（name + 一句话），模型要用时经 ToolSearch 取回完整说明。
  //
  // 【为什么放在所有 register 之后】MCP / extraTools 是运行时注册的，必须等它们
  // 都进了 registry 再判定，否则晚到的工具永远不会被标记。
  // 【为什么 ToolSearch 自己不延迟】它必须常驻 —— 模型每轮都可能要检索。
  applyDeferredTools(registry)
  registry.register(new ToolSearchTool({ getRegistry: () => registry }))

  function getRuntimeModelInfo() {
    const raw = typeof opts.getRuntimeModelInfo === 'function'
      ? opts.getRuntimeModelInfo()
      : (opts.getRuntimeModelInfo || {})
    const api = raw.api || opts.api || {}
    return {
      providerId: raw.providerId ?? raw.current ?? '(unknown)',
      providerName: raw.providerName ?? raw.name ?? '(未命名)',
      model: raw.model ?? api.model ?? '(unknown)',
      protocol: raw.protocol ?? api.protocol ?? 'openai',
    }
  }

  function formatRuntimeModelInfo() {
    const info = getRuntimeModelInfo()
    return `\n# 当前底层模型配置（运行时动态捕捉）\nProvider ID: ${info.providerId}\nProvider 名称: ${info.providerName}\nModel: ${info.model}\nProtocol: ${info.protocol}\n注意：这是当前 API 请求配置，不是 Agent 身份；回答“当前用什么模型”时以此为准。\n`
  }
  /**
   * 把提示词里的 {{占位符}} 替换成实际值。
   *
   * 【2026-10-20 改为复用】原来的 map（HOME/ENV_NOTE/ENV_LABEL/KEEPALIVE_NOTE/
   * BROWSER_TOOLS_SECTION）只存在于这里，导致 CLI 路径完全不插值、5 个占位符
   * 原样泄漏给模型。现在这份逻辑搬到了 `prompts.mjs` 的 `interpolateEnvPrompt()`，
   * CLI（走 fillPromptVars）与 Web（走这里）共用同一份，不会再各自漂移。
   * 这里保留成薄封装，是因为调用点还有一处差异：Web 的 WORKSPACE 用启动时 cwd。
   */
  function interpolatePrompt(text) {
    return interpolateEnvPrompt(text, cwd)
  }

  function getSystemPrompt() {
    const date = new Date().toISOString().slice(0, 10)
    return interpolatePrompt(baseSystemPrompt)
      + sessionStartPrompt.replace('{{DATE}}', date).replace('{{CWD}}', cwd)
      + ClaudeMdLoader.format(contextFiles)
      + skillLoader.format()
      + customCommands.formatForPrompt()
      + customAgents.formatForPrompt()
      + formatRuntimeModelInfo()
      + (planMode.getSystemPromptAddition?.() || '')
      + (deepMode.getSystemPromptAddition?.() || '')
      + (coordinatorMode.getSystemPromptAddition?.() || '')
      + (opts.systemPromptSuffix || '')
  }

  function bindApi(api) {
    if (subAgentTool) {
      subAgentTool.api = api
      Object.defineProperty(subAgentTool, 'systemPromptBase', {
        configurable: true,
        get: () => getSystemPrompt(),
      })
    }
  }

  return {
    registry,
    tools: () => registry.list(),
    multiUndo,
    inputHistory,
    planMode,
    deepMode,
    coordinatorMode,
    attachAgent: (a) => { liveAgent = a; if (a && deepMode) a.maxTurns = deepMode.getMaxTurns() },
    skillLoader,
    customCommands,
    customAgents,
    reloadExtensions: () => { customCommands.reload(); customAgents.reload() },
    getSystemPrompt,
    bindApi,
  }
}
