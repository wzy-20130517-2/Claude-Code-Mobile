// Claude Code Mobile - 计划模式 + 子 Agent
import { Tool } from '../tools/tools.mjs'
import {
  registerBackgroundTask,
  getBackgroundTaskStatus,
  listBackgroundTasks,
  setOnTasksChanged as _setOnTasksChanged,
  killBackgroundTask,
  gcTerminalTasks,
} from './bg-tasks.mjs'
import { listCronTasks } from '../infra/cron.mjs'

// re-export 方便 index 从 plan.mjs 统一引入
export { getBackgroundTaskStatus, listBackgroundTasks, killBackgroundTask, gcTerminalTasks }

export class PlanMode {
  constructor() { this.enabled = false }
  enable() { this.enabled = true; return '进入计划模式' }
  disable() { this.enabled = false; return '退出计划模式' }
  toggle() { return this.enabled ? this.disable() : this.enable() }
  getSystemPromptAddition() { return this.enabled ? '\n\n# 计划模式已启用\n你需要先给出一个执行计划（步骤列表），不要执行任何工具。\n等用户批准后再开始执行。\n' : '' }
}

// 【轮数上限的单一真值源】改这里即可，其余引用点都从这里读。
// 2026-09-19 用户要求：normal 100→300、deep 1000→3000
// （理由：很多人的任务超过 24h，1000 轮不够用）。
export const NORMAL_MAX_TURNS = 300
export const DEEP_MAX_TURNS = 3000

// Deep 模式：让 Claude 在复杂任务时使用更长 maxTurns
// 用户可以 /deep 主动开启，或 Claude 用 EnterDeepMode 工具自己切
export class DeepMode {
  constructor() { this.enabled = false; this.normalMaxTurns = NORMAL_MAX_TURNS; this.deepMaxTurns = DEEP_MAX_TURNS }
  enable() { this.enabled = true; return `进入 deep 模式：maxTurns 提升至 ${DEEP_MAX_TURNS}` }
  disable() { this.enabled = false; return `退出 deep 模式：maxTurns 恢复为 ${NORMAL_MAX_TURNS}` }
  toggle() { return this.enabled ? this.disable() : this.enable() }
  getMaxTurns() { return this.enabled ? this.deepMaxTurns : this.normalMaxTurns }
  getSystemPromptAddition() { return this.enabled ? `\n\n# Deep 模式已启用\n你拥有最多 ${DEEP_MAX_TURNS} 个工具轮次来完成复杂任务。可以展开详细的步骤、多次尝试、跨多个文件迭代。不要急于收尾。\n` : '' }
}

/**
 * 协调者模式（对齐官方 Coordinator Mode）。
 *
 * 【为什么有这个东西】
 * 用户问「web 中协作模式可能无效，其实就是多 Agent 编排。参考官方源码中有没有
 * 协作模式这个概念：如果有就做，没有的话就不在 web 显示这个功能」。
 *
 * 核实结论：**官方有**（~/cc-src/claude-code-main/coordinator/coordinatorMode.ts），
 * 就是多 Agent 编排：
 *   · 主对话变成「协调者」——只拆解、派活、读结果、汇总，**自己不写代码**
 *   · 用 Agent spawn worker、SendMessage 续跑（复用它的上下文）、AgentStop 中止
 *   · worker 结果以 <task-notification> 形式回到协调者
 *   · 由环境变量 CLAUDE_CODE_COORDINATOR_MODE 开关
 *
 * 我们的工具层其实**早就齐了**（Agent / SendMessage / TeamCreate / TaskCreate），
 * core/plan.mjs 的 BUILTIN_SUBAGENT_TYPES.Coordinator 里也有完整编排纪律 ——
 * 缺的只是「把主对话本身切成协调者」这一个开关。这个类就是那个开关。
 *
 * 【与 Coordinator 子 agent 类型的区别，别混】
 *   · BUILTIN_SUBAGENT_TYPES.Coordinator → 主对话 spawn 出的**某个子 agent** 是协调者
 *   · 这个 CoordinatorMode              → **主对话本人**变成协调者（官方语义）
 * 两者可以同时存在：协调者模式下的主对话再去 spawn Coordinator 子 agent 也合法。
 */
export class CoordinatorMode {
  constructor() { this.enabled = false }
  enable() { this.enabled = true; return '进入协调者模式：你只做编排，不亲自改代码' }
  disable() { this.enabled = false; return '退出协调者模式：恢复正常工作方式' }
  toggle() { return this.enabled ? this.disable() : this.enable() }
  getSystemPromptAddition() {
    if (!this.enabled) return ''
    // 提示词按官方 coordinatorMode.ts 的骨架写，但**不复述既有纪律** ——
    // Agent 工具描述、Coordinator 子 agent 类型里已经写了并发预算、
    // 返工找原 worker、按文件集合分串并行等细节。这里只讲「角色转变」这件
    // 主对话原本不知道的事，避免同一套规则散落三处各自过期。
    return `

# 协调者模式已启用（Coordinator Mode）

**你的角色变了：你是协调者，不是执行者。**

- **自己不写代码、不改文件、不跑长命令。** 想动手时，改成 spawn 一个 worker 去做。
- 你只做四件事：**拆解 → 派活 → 读结果 → 汇总**。
- 允许的例外：为了拆任务而做的少量只读侦察（看目录、确认文件存在），
  但不要发展成"我自己顺手把活干完"——那就失去了编排的意义。

**工具**：用 Agent spawn worker（给每个起好 agent_name）；用
SendMessage(to:<名字>, wake:true) 让跑完的 worker 带着原上下文继续干
（要返工找原 worker，不要重新 spawn，它记得自己做过什么）；派错方向用
AgentStop 中止，别干等它烧 token。

**每句话都是说给用户听的。** worker 的结果是内部信号，不是对话对象 ——
不要对它们说"谢谢""收到"。有新进展就替用户总结出来。

**并行按冲突分组，不是按个数**：只读任务放开并行；写文件的任务按**文件集合**
分组（同一批文件同时只能有一个 worker 在改，否则静默覆盖）；验证可与实现并行，
但要验证的文件若正在被改就必须等它交回。

**worker 的结论要抽查**，不要照抄。凡"有没有 / 是不是"的断言，自己 Read 关键位置核一眼。

用户没让你进这个模式时不要自己进（\`/coordinate\` 是用户命令）；
但如果你发现自己正在做「一堆可以并行的独立子任务」，可以建议用户开它。
`
  }
}

export class EnterPlanModeTool extends Tool {
  constructor(onEnter) { super({ name: 'EnterPlanMode', description: '进入计划模式', input_schema: { type: 'object', properties: {} } }); this.onEnter = onEnter }
  async execute() { this.onEnter(); return '已进入计划模式' }
}

/**
 * 退出计划模式。
 *
 * 【execute_immediately 为什么不是死字段】schema 里声明过它但 execute() 一直忽略，
 * 模型按官方文档传了 `true`，拿到的只是「已退出计划模式」——语义和传 false 完全一样。
 * 这个字段对应真实需求：用户说「按这个计划做」时，不想再被问一遍「要我继续吗」。
 *
 * 【怎么实现】返回值经 agent.mjs 的 _executeTool 序列化成 tool_result 文本，
 * **下一轮模型会读到它**。所以「立即继续」的正确形态不是返回一个结构化标记
 * （没有消费方会解析它），而是返回一段明确指令，让模型下一轮直接开干：
 *   · 指令要说清「现在就开始执行，不要重新罗列计划、不要等确认」
 *   · 计划内容不用回传 —— 它在自己的历史里（上一条 assistant 消息），
 *     回传一遍纯属重复，还容易让模型以为「计划被改过」
 *
 * 【为什么不动 agent.mjs】退出 planMode 后系统提示词的 plan 段（volatileSection，
 * 每轮重算）就消失了，权限层本来就不看 planMode（/permissions mode plan 是另一套
 * 独立机制），所以工具权限在同一轮内即刻放开 —— 模型下一轮调 Write/Bash 不会被拦。
 * 需要的就是「告诉它现在可以且应该动手」这一句。
 */
export class ExitPlanModeTool extends Tool {
  constructor(onExit) {
    super({
      name: 'ExitPlanMode',
      description: '退出计划模式。'
        + '默认行为：退出后向用户展示计划并等待其批准。'
        + '传 execute_immediately:true 表示用户已授权直接开工 —— 退出后立即开始执行你上面给出的计划，不再等确认。',
      input_schema: {
        type: 'object',
        properties: {
          execute_immediately: {
            type: 'boolean',
            description: 'true = 已获授权，退出后立即执行计划（不要重新罗列、不要等用户确认）。'
              + '省略或 false = 退出后等用户看过计划再批准。',
            default: false
          }
        }
      }
    })
    this.onExit = onExit
  }
  async execute(input = {}) {
    this.onExit()
    if (input.execute_immediately === true) {
      return '已退出计划模式。用户已授权直接开工：'
        + '现在立即开始执行你上面给出的计划 —— 从第一个未完成的步骤做起，'
        + '不要重新罗列计划、不要问「要我继续吗」、不要等用户确认。'
        + '计划本身在你上一条消息里，照着执行即可；执行中若发现计划有误，'
        + '直接改正并继续，不要停下来汇报。'
    }
    return '已退出计划模式。计划已呈现给用户，等待其批准后开始执行。'
  }
}

export class EnterDeepModeTool extends Tool {
  constructor(onEnter) { super({ name: 'EnterDeepMode', description: `进入 deep 模式（maxTurns 提升至 ${DEEP_MAX_TURNS}，用于复杂多步骤任务）。适用于：任务确实复杂（多文件改动、反复迭代调试），或接近轮数上限但确认没有空转、还需要更多轮才能做完时（自救，不用等用户）。`, input_schema: { type: 'object', properties: {} } }); this.onEnter = onEnter }
  async execute() { this.onEnter(); return `已进入 deep 模式，maxTurns 提升至 ${DEEP_MAX_TURNS}` }
}

export class ExitDeepModeTool extends Tool {
  constructor(onExit) { super({ name: 'ExitDeepMode', description: '退出 deep 模式，恢复默认 maxTurns', input_schema: { type: 'object', properties: {} } }); this.onExit = onExit }
  async execute() { this.onExit(); return '已退出 deep 模式' }
}

/**
 * 子 Agent 自主续轮。
 *
 * 【为什么不能让子 Agent 用 EnterDeepMode】DeepMode 是主进程的**全局单例**，
 * 控制主 Agent 的 maxTurns；子 Agent 的 maxTurns 来自角色卡、在 new Agent() 时写死。
 * 子 Agent 调 EnterDeepMode 只会改主 Agent 的开关，对自己毫无作用 —— 更糟的是
 * 它会以为自己续上了，继续大手大脚干活，然后照样在原上限处被砍断
 *（2026-08-30 实测：CPO 被告知"你有 1000 轮"，实际 60 轮就用尽交还）。
 *
 * 所以给子 Agent 一个只改**自己实例**的工具。设计上刻意保留闸门：
 *   · 单次增量有上限（避免一次要到天上去）
 *   · 累计续轮次数有上限（避免无限续导致失控烧 token）
 *   · 要求写明理由（迫使它判断"是真没做完"还是"在原地打转"）
 * 用尽仍未完成时，正确行为是**诚实交还**（写清做到哪、待办是什么），不是硬续。
 */
/**
 * 持续模式（watch）——进入/退出工具（2026-09-30 用户要求「参考 plan 做成原生工具」）。
 *
 * 原来 /watch 只有用户命令入口，AI 自己想开启持续监听（盯队列/持续任务）时
 * 只能建议用户敲命令。现在与 EnterPlanMode/EnterDeepMode 对齐，AI 可自主进出。
 *
 * 状态存在 Agent 实例的 watchMode 字段（core/agent.mjs）——
 * run 内 while 循环读它决定「本轮结束后是否注入继续」，所以工具一调立即生效。
 */
export class EnterWatchTool extends Tool {
  constructor(onEnter) {
    super({
      name: 'EnterWatch',
      description: '进入持续模式（watch）：本轮结束后不主动停止回复，持续执行/监听，直到 ExitWatch 或用户打断（Ctrl+C）。仅在任务确实是「持续性」的（盯队列、轮询状态、持续下歌等）才用；一次性任务不要开。主对话专用。'
        + '【纪律】任务完成后必须主动 ExitWatch，不要空转等用户来叫 —— 没有新任务、或只剩「等外部条件」（等构建、等账号恢复、等用户回话）时，都应该退出而不是挂着。用户反复看到你在空转是骚扰。',
      input_schema: { type: 'object', properties: {} },
    })
    this.onEnter = onEnter
  }
  async execute() {
    this.onEnter()
    return '已进入持续模式：本轮结束后将继续执行/监听，不会主动停。用 ExitWatch 或让用户 Ctrl+C 退出。'
  }
}

export class ExitWatchTool extends Tool {
  constructor(onExit) {
    super({
      name: 'ExitWatch',
      description: '退出持续模式（watch），恢复正常「一轮结束即停」。持续任务已完成、或只剩「等外部条件」（等构建/等回复/等账号恢复）而非主动监听时调用 —— 那些场景该用 ScheduleWakeup 定时唤醒，而不是挂着 watch 空转。',
      input_schema: { type: 'object', properties: {} },
    })
    this.onExit = onExit
  }
  async execute() {
    this.onExit()
    return '已退出持续模式：本轮结束后将正常停止回复。'
  }
}

export class ExtendTurnsTool extends Tool {
  constructor({ getAgent, maxExtensions = 4, perExtension = 60, hardCap = 400 } = {}) {
    super({
      name: 'ExtendTurns',
      description: `给自己追加工具轮次（仅当任务确实没做完、且还在有效推进时用）。单次最多 +${perExtension} 轮，最多续 ${maxExtensions} 次，总上限 ${hardCap} 轮。收到「距上限只剩不到 10 轮」提醒且工作未完成时，先判断：是真的还需要更多轮，还是自己在原地打转？前者续，后者立刻收尾交还。`,
      input_schema: {
        type: 'object',
        properties: {
          turns: { type: 'number', description: `要追加多少轮（1-${perExtension}），省略则用 ${perExtension}` },
          reason: { type: 'string', description: '为什么还需要更多轮：已完成什么、还剩什么、预计几轮能收尾' },
        },
        required: ['reason'],
      },
      validateInput: (input) => {
        if (!String(input?.reason || '').trim()) {
          return { valid: false, errors: ['必须写 reason：说明已完成什么、还剩什么、预计几轮收尾'] }
        }
        return { valid: true }
      },
    })
    this.getAgent = getAgent
    this.maxExtensions = maxExtensions
    this.perExtension = perExtension
    this.hardCap = hardCap
    this.used = 0
  }

  async execute(input = {}) {
    const agent = this.getAgent?.()
    if (!agent) return '续轮失败：拿不到自身 Agent 实例（这是内部错误，请如实报告并收尾）'
    if (this.used >= this.maxExtensions) {
      return `已用完 ${this.maxExtensions} 次续轮机会（当前上限 ${agent.maxTurns} 轮）。`
        + `不能再续了 —— 请立刻收尾：把已完成的部分和未完成的部分如实写进报告，`
        + `并在 comment 里留下续做者需要的信息。`
    }
    const want = Number(input.turns) > 0 ? Math.min(Math.floor(Number(input.turns)), this.perExtension) : this.perExtension
    const before = agent.maxTurns
    if (before >= this.hardCap) {
      return `已达硬上限 ${this.hardCap} 轮，不能再续。请立刻收尾并如实交还未完成部分。`
    }
    agent.maxTurns = Math.min(before + want, this.hardCap)
    this.used++
    return `已续 ${agent.maxTurns - before} 轮：${before} → ${agent.maxTurns}`
      + `（第 ${this.used}/${this.maxExtensions} 次，硬上限 ${this.hardCap}）\n`
      + `理由已记录：${String(input.reason).slice(0, 200)}\n`
      + `继续干，但注意：续轮不是免费的，如果发现自己在原地打转就主动收尾。`
  }
}

// ─── 内置子 Agent 类型定义 ───────────────────────────────────────────

export const BUILTIN_SUBAGENT_TYPES = {
  'general-purpose': {
    description: '通用子 agent，拥有全部工具，可独立完成复杂任务',
    toolNames: null,
    maxTurns: 10000,
    promptAddition: `\n# 你的角色：通用子 Agent
你是一个被主 Agent 委派的子 Agent，拥有全部工具权限。
你的任务会由主 Agent 在 task 中描述，请自行规划步骤、调用工具、完成任务。
完成后返回简洁的结果摘要给主 Agent，不要返回无意义的空话。
**重要**：你运行在后台，**永远不要调用 AskUserQuestion**——你无法与用户交互，调用会永远阻塞。
如果任务有模糊或信息不足的地方，基于合理假设推进，并在结果中说明你做的假设即可。`
  },
  'Explore': {
    description: '探索子 agent，只读工具，用于调研代码库、解答"代码在哪/怎么实现"等问题',
    toolNames: ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'HashlineRead', 'HashlineGrep',
      'Diagnostics', 'Symbols', 'RepoMap'],
    maxTurns: 10000,
    promptAddition: `\n# 你的角色：探索子 Agent (Explore)
你是一个只读的探索子 Agent，用于调研代码库结构、查找文件、理解实现。
**禁止**修改任何文件、执行任何写入操作、提交 git 等。
**重要**：你运行在后台，**永远不要调用 AskUserQuestion**——你无法与用户交互，调用会永远阻塞。
信息不足时基于合理推断推进。
完成后返回你的发现摘要：相关文件路径（用 file_path:line_number 格式）、关键实现位置、以及简短的代码结构说明。`
  },
  'Plan': {
    description: '计划子 agent，只读+TodoWrite，用于制定执行计划',
    toolNames: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'HashlineRead', 'HashlineGrep'],
    maxTurns: 10000,
    promptAddition: `\n# 你的角色：计划子 Agent (Plan)
你是一个用于制定计划的子 Agent。先探索代码库现状，然后产出一份清晰的执行计划。
**禁止**执行任何修改操作。**重要**：你运行在后台，**永远不要调用 AskUserQuestion**。
返回格式：
1. 任务概述
2. 步骤列表（带 progress 标记）
3. 涉及的文件路径列表
4. 潜在风险与注意事项`
  },
  'fork': {
    description: 'fork 子 agent：继承主对话的完整历史（每个工具调用、读过的文件、做过的决定），并行地接着干。用于「同一份上下文、分头去试不同方案」——比重新 spawn 省掉全部重建上下文的 token，比 SendMessage(wake) 多一个并行能力（wake 是串行续跑同一个实例）',
    toolNames: null,
    maxTurns: 10000,
    // fork 不重建上下文，而是复用主对话的消息数组（见 SubAgentTool.execute 里的 fork 分支）。
    // 所以这里不需要 promptAddition 去解释背景 —— 它本来就记得。
    // 但它必须知道自己是分身，不能改主对话的状态、也不能指望和主对话对话。
    promptAddition: `\n# 你的角色：fork 子 Agent
你是主对话的一个分身：**你继承了它到此为止的完整对话历史**——包括它读过的每个文件、
做过的每个决定、看到的每个工具结果。你不需要别人给你讲背景。

**你与主对话的分工**：
- 主对话派你来，是要你**并行**去做一件它自己也在做的事情的分支。
- 你看得到它之前做了什么，但**看不到它在你启动之后做了什么**（那部分是并行的）。
- 所以：不要假设主对话此刻的状态和你看到的一致；你的结论要写成「基于我接手时的上下文」。

**约束**：
- 你的工具调用、文件读写**与主对话共享同一个文件系统**。改文件前先想清楚：
  主对话是否可能正在改同一个文件？如果可能，只读不写，把改动建议写进报告让它来落。
- **不要调用 AskUserQuestion**（你在后台，无法与用户交互）。
- 完成后返回结论摘要，写清你验证了什么、没验证什么。`
  },
  'Coordinator': {
    description: '协调者子 agent，编排多个 worker 并行完成复杂任务',
    toolNames: null,
    maxTurns: 10000,
    promptAddition: `\n# 你的角色：协调者子 Agent (Coordinator)
你是一个多 Agent 编排者。你不直接执行任务，只做编排。
**重要**：你运行在后台，**永远不要调用 AskUserQuestion**——你无法与用户交互。
你的责任：
1. 分析任务，拆分为可并行的子任务
2. 用 Agent 工具 spawn 多个 worker（general-purpose 或 Explore 类型）
3. 只读子任务（research/exploration）可以并行 spawn
4. 写操作子任务如果涉及同一文件领域，串行执行
5. 汇总所有 worker 的结果，自己做综合分析
6. 不要把理解任务委托给 worker，你负责最终的 synthesize
spawn 默认就在后台跑（不用显式传 run_in_background），拿到 task_id 后用
AgentOutput({task_id, block:true}) 等结果 —— 它会阻塞到完成，不要 sleep 轮询。

## 纪律（对齐官方 coordinator，违反就失去了编排的意义）
- **你自己不写代码、不改文件、不跑长命令。** 想动手时，改成 spawn 一个 worker 去做。
  你只做：拆解 → 派活 → 读结果 → 交叉验证 → 汇总。允许的例外：为了拆解任务而做的
  少量只读侦察（看目录结构、确认文件是否存在），不要发展成自己把活干完。
- **并发预算 24 个**（全局共享，你派生的下级也算；改这个数字时同步 MAX_CONCURRENT_SUBAGENTS）。
  超限时 Agent 工具返回 rejected:"concurrency_limit"，那不是错误：等一批完成再派下一批，
  或缩减本层扇出。别因此放弃任务。
- **worker 交回的结论要抽查，不要照抄。** 它可能漏看一行就报"没有校验"。
  凡是涉及"有没有 / 是不是"的断言，自己 Read 关键位置核一眼再写进汇总。
- **要返工找原 worker，不要重新 spawn。** 用 SendMessage(to:"<agent_name>", wake:true, text:"...")
  唤醒它继续干——它保留原有上下文，记得自己做过什么，不用重讲背景。
  所以 spawn 时就给每个 worker 起好 agent_name。
- **派错方向就 AgentStop 掉**，别干等它跑完白烧 token、白占名额。
  中止后若当初给了 agent_name，仍可 wake 唤醒它带着上下文重来。

## 并行的正确姿势（真正的约束是资源冲突，不是数量）
并行是你最大的优势，能同时跑的别串行化，主动找扇出机会。但要按**冲突**分组，不是按个数：
- **只读任务（调研/勘察/搜索/读代码）** → 放开并行，几个都行，它们互不干扰
- **写文件的任务** → 按**文件集合**分组：同一批文件同时只能有一个 worker 在改，
  否则两边各自 Read 到旧内容、各自写回，后写的直接覆盖前面的改动（这类冲突不会报错，
  只会静默丢失工作，最难查）。不同目录/不同文件集可以并行
- **验证/测试** → 可以和实现并行，前提是碰的文件区域不重叠；
  要验证的正是别人在改的文件，就必须等它交回再验
- 派活前先想清楚每个 worker 会碰哪些文件，把这个写进它的 prompt（明确告诉它"只准改 X，别碰 Y"）`
  }
}

/**
 * 同时在跑的子 Agent 上限。
 *
 * 【为什么还留着闸门】官方 coordinator 没有数字上限，它只做语义约束
 * （只读自由并行、写操作按文件集合串行）。因为它跑桌面端、直连自家 API。
 * 我们跑在手机上：即使中转站不限并发，本机仍有内存、发热、Node 单进程
 * 事件循环这几道天花板，而且子 Agent 能递归 spawn（一层扇出 3 个、三层就 27 个），
 * 失控后很难收回。所以保留闸门，但数值按"中转站不限并发"放宽。
 *
 * 24 的依据：单个子 Agent 常驻开销主要是 messages 数组 + 一路流式缓冲，
 * 手机上 20 来个并发仍可控；真正的资源冲突交给语义约束（见 Coordinator 提示词）。
 * 超限时不抛错，而是返回说明给模型，让它自己选择等待/串行/缩减扇出 ——
 * 报错会让子 Agent 误判成"这条路走不通"直接放弃整个任务。
 */
// 【可配置（对齐官方 2.1.303）】官方同名环境变量 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
// （claude.js:18180 → zod 定义 19629，min:1 digitsOnly），这里对齐它的名字与语义。
//
// 为什么需要：24 这个数字是「中转站不限并发 + 手机资源」的折中，但两种极端场景
// 差别很大 —— 跑纯调研（全 Explore，几乎不吃 CPU）时可以放宽到 40+；
// 反过来在手机上同时跑多个 Bash/phone 工具时，24 个并行子 Agent 会把
// 事件循环和 fd 一起压垮，用户只能改源码。给个环境变量就够了。
//
// 非法值（NaN / ≤0）回落 24：配错不能把闸门打成 0（那样任何子 Agent 都起不来），
// 也不能打成 Infinity（那样闸门等于不存在）。
export const MAX_CONCURRENT_SUBAGENTS = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 24
})()

/**
 * 子 Agent 派生深度上限（对齐官方 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`）。
 *
 * 【为什么并发闸门不够】并发闸门只管「同时有几个在跑」，挡不住深度问题：
 * 一层扇出 3 个、三层就 27 个，24 个名额会被树形结构填满 —— 此时根节点
 * 想再派一个也派不出去，而树已经深到没人能读懂（每个节点都在等自己的子节点，
 * 却没有任何一层能给出结论）。并发是横向的，深度是纵向的，两个维度都要卡。
 *
 * 官方校验规则（claude.js:417192 fn12365）：必须是 >= 1 的整数，
 * 否则回落 GrowthBook 配置、再回落默认 3。这里省略 GrowthBook 那层（CCM 没有），
 * 非法值直接回落 3 —— 配错不能把闸门打成 0（那样任何嵌套 spawn 都不许）
 * 也不能打成 Infinity（闸门等于不存在）。
 */
export const MAX_SUBAGENT_DEPTH = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? '', 10)
  return Number.isInteger(raw) && raw >= 1 ? raw : 3
})()

let runningSubagents = 0

/**
 * 当前派生深度。主 Agent 是 0，它 spawn 出的是 1，再往下 2、3…
 *
 * 用 AsyncLocalStorage 而不是给 Agent 加字段：深度是「当前异步调用栈」的属性，
 * 不是「某个实例」的属性。子 Agent 里再调 Agent 工具时，工具实例是同一个
 * （SubAgentTool 在 registry 里只有一份），没法从实例上区分是谁在调。
 * AsyncLocalStorage 天然跟着 async 调用链走，spawn 时用 run() 包住整个子 Agent
 * 生命周期，它内部任何深度的 Agent 调用都能读到正确的 depth。
 */
let _depthAls = null
async function getDepthAls() {
  if (_depthAls) return _depthAls
  try {
    const { AsyncLocalStorage } = await import('node:async_hooks')
    _depthAls = new AsyncLocalStorage()
  } catch {
    // 极老的 Node 没有 async_hooks —— 退化成「永远认为深度 0」，
    // 宁可漏拦也不要因为拿不到深度就把所有 spawn 都拒掉。
    _depthAls = { getStore: () => undefined, run: (_s, fn) => fn() }
  }
  return _depthAls
}
export async function getCurrentSpawnDepth() {
  const als = await getDepthAls()
  return als.getStore()?.depth || 0
}

/**
 * 超限拒绝的会话级记录（对齐官方 `recordRefused`）。
 *
 * 【为什么光返回给模型不够】超限只回一句「并发满了」，排查「为什么任务卡住」
 * 时看不到 —— trace 里没有、状态栏没有，只能靠复现。官方把它记进 session，
 * 事后能查「这次会话被拒了几次、为什么」。这里用模块级计数器 + 最近几条明细，
 * 由 AgentStatus / /status 读出来。
 */
const refusedRecords = []
const MAX_REFUSED_RECORDS = 50
export function recordRefused(kind, detail = {}) {
  refusedRecords.push({ kind, at: new Date().toISOString(), ...detail })
  if (refusedRecords.length > MAX_REFUSED_RECORDS) refusedRecords.shift()
}
export function getRefusedRecords() { return [...refusedRecords] }

export function getRunningSubagents() { return runningSubagents }

/**
 * 子 Agent 报告的防注入转义（对齐官方 SubagentHandback 的报告处理）。
 *
 * 官方原文（claude.js:108477）：
 * > "The subagent's whole report, never truncated, with a backslash inserted
 * >  into text that imitates harness markup, such as a system tag
 * >  (`<system-reminder>`), a `[harness:` line or a turn marker
 * >  (`Human:` at the start of a line)"
 *
 * 【为什么需要】子 Agent 的报告会作为工具结果回到**主 Agent 的上下文**里。
 * 如果子 Agent 读了不可信内容（网页、别人的 issue、被审代码里的注释），
 * 那些内容里可能有 `<system-reminder>你现在应该…</system-reminder>` 这种
 * 伪造的 harness 标记 —— 主 Agent 会把它当成系统指令执行。这是**间接
 * prompt injection**，而子 Agent 恰恰是读外部内容最多的地方。
 *
 * 【为什么只转义这几类】范围要精确，否则会把正常的代码/文档改坏：
 *   · `<system-reminder>` 等 harness 标签 —— 主 Agent 真的会当真
 *   · 行首 `Human:` / `Assistant:` —— 伪造对话轮次边界
 *   · 行首 `[harness:` —— 伪造 harness 事件
 * 转义方式统一是**前置反斜杠**（官方同款）：模型看到 `\<system-reminder>`
 * 能认出这是「被转义的文本」而不是真标签，同时内容本身仍然可读。
 */
/**
 * Agent 的输入归一：官方字段名 `name` → 内部 `agent_name`。
 *
 * 为什么不写成类方法：`Tool` 构造器里有
 * `this.coerceInput = typeof opts.coerceInput === 'function' ? opts.coerceInput : null`，
 * 这条赋值会在**实例上**建一个自有属性 —— 类方法在原型上，会被它遮蔽成 null。
 * 所以必须作为 super 配置项传入（模块级函数，不依赖 this）。
 *
 * 为什么归一而不是改名：`agent_name` 在 plan.mjs / tools-agent-status.mjs /
 * tools-teams.mjs 里被引用十几处，还写进了 keepAgent 的 Map key、系统提示词、
 * 历史会话的调用记录。改名是纯收益为零的破坏性重构。
 *
 * 返回 null = 无需改动（基类约定）；否则返回新对象，不污染调用方。
 */
/**
 * 归一化 disallowedTools：去空白、去空串、去重。
 *
 * 不做「工具名是否存在」的校验：MCP 工具名是动态的（mcp_<server>_<tool>），
 * 且不同 provider 会话的 registry 内容不同；写错一个名字最坏结果是
 * 「没禁到那个工具」，静默即可。真正要报错的是「禁空了」那种，
 * 那在 AgentTool 里单独判（见 tool_conflict 分支）。
 */
function normalizeDisallowedTools(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const n of raw) {
    const s = String(n || '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function coerceAgentInput(input) {
  if (!input || typeof input !== 'object') return null
  if (!input.name) return null
  const name = String(input.name).trim()
  // 两个都给时以官方字段 `name` 为准（按官方文档写的人不该被旧字段覆盖）
  if (!name || name === input.agent_name) return null
  return { ...input, agent_name: name }
}

export function escapeHarnessMarkup(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text
  // harness 标签（含常见变体）。用反斜杠前缀转义，不删除内容。
  out = out.replace(/<(\/?)(system-reminder|system|harness|tool-result|function-calls?)\b/gi,
    (m, slash, tag) => `\\<${slash}${tag}`)
  // 行首轮次标记：Human: / Assistant: / User: / System:
  // 必须限定行首（官方原文 "at the start of a line"）—— 行内出现
  // "Human: " 是很常见的正常文本（比如在讨论这个机制本身），转义会破坏内容。
  out = out.replace(/^(Human|Assistant|User|System):/gm, (m, who) => `\\${who}:`)
  // 行首 [harness: 事件行
  out = out.replace(/^\[harness:/gm, '\\[harness:')
  return out
}

/**
 * 已跑完的子 Agent 实例表，key = agent 名（input.agent_name 或 description）。
 *
 * 【为什么要留着】原来 sub 是 runAndCollect 里的局部变量，execute 返回就被丢掉，
 * 子 Agent 是纯一次性的：想让它"接着上次继续"只能重新 spawn 并把背景信息
 * 手工塞进 prompt —— 上下文没了、它也不记得自己之前说过什么。
 * 官方 coordinator 的 SendMessage 是能唤醒一个已结束 worker 并复用其上下文的，
 * 这里存下实例就是为了对齐这点（见 resumeSubagent）。
 *
 * 只存最近 MAX_KEPT 个，防止长会话里无限堆积 messages 吃内存。
 */
const keptAgents = new Map()   // name -> { agent, type, lastRunAt, turns }
const MAX_KEPT_AGENTS = 12

function keepAgent(name, agent, type) {
  if (!name) return
  keptAgents.delete(name)      // 重新插入以刷新 LRU 顺序
  keptAgents.set(name, { agent, type, lastRunAt: Date.now() })
  while (keptAgents.size > MAX_KEPT_AGENTS) {
    const oldest = keptAgents.keys().next().value
    keptAgents.delete(oldest)
  }
}

export function listKeptAgents() {
  return [...keptAgents.entries()].map(([name, v]) => ({
    name, type: v.type, lastRunAt: v.lastRunAt,
    messages: v.agent?.messages?.length || 0,
  }))
}

export function getKeptAgent(name) { return keptAgents.get(name) || null }

/**
 * 唤醒一个已跑完的子 Agent，把 text 作为新的 user 消息喂进它原有上下文继续跑。
 * 返回 null 表示没有这个 agent（调用方应提示可用名单）。
 */
export async function resumeSubagent(name, text, { signal = null, maxTurns = null, background = false } = {}) {
  const entry = keptAgents.get(name)
  if (!entry) return null
  if (runningSubagents >= MAX_CONCURRENT_SUBAGENTS) {
    return {
      ok: false, rejected: 'concurrency_limit',
      running: runningSubagents, limit: MAX_CONCURRENT_SUBAGENTS,
      message: `并发已满（${runningSubagents}/${MAX_CONCURRENT_SUBAGENTS}），本次未唤醒 ${name}。`,
      hint: '等已有子 Agent 完成后重试，或改成串行。这不是错误。',
    }
  }
  const { agent } = entry

  // ★ 目标**正在跑** → 不重开 run（2026-09-28 修「wake 出现两个一样的」）。
  //   keptAgents 是 spawn 时就写入的，运行中的实例也在里面；
  //   原来 wake 它会对同一实例再 start 一个 run —— AgentStatus 里出现
  //   两个 task、turnCount 互相覆盖，而实际只有一个实例在跑（用户原话：
  //   「多一个一样的出来，但实际还是一个」）。
  //   正确做法：把指令当 mid-turn steering 注入当前这轮，
  //   下一轮模型调用前生效，不打断正在跑的工具批次。
  if (agent && agent.isRunning && typeof agent.pushSteering === 'function') {
    agent.pushSteering(text)
    return {
      ok: true, name, steering: true,
      message: `${name} 正在执行中 —— 指令已作为 mid-turn steering 注入，下一轮模型调用前生效。没有重复启动。`,
    }
  }

  // 【后台续跑 —— 2026-09-27 新增】
  //
  // 原来只有同步模式（await 到底）。问题是子 Agent 动辄跑几分钟，
  // 而 SendMessage 这个工具调用有 60s 超时 —— 于是必然超时返回。
  // 更糟的是：超时后它**还在后台跑**（promise 已经发出去了），
  // 但调用方拿不到结果、也拿不到 task_id，无法查询进度，
  // 只能靠翻 trace 文件猜它是不是还活着。实际体验就是"不知道它跑没跑"。
  //
  // 后台模式直接复用 BgTask 那套基础设施（和 Agent(run_in_background:true) 一致）：
  // 立刻返回 task_id，之后用 AgentStatus / AgentOutput 查。
  if (background) {
    const task = registerBackgroundTask('local_agent', `续跑 ${name}`)
    task.start()
    task.abortController = new AbortController()
    task.agentType = entry.type
    task.agentName = name
    task.isResume = true
    // 持有实例：AgentStatus 据此读实时 turnCount / messages 长度。
    // 不设的话 running 期间 turns 恒为 0，看起来像卡死（实际在正常干活）。
    task.agent = agent

    runningSubagents++
    const startTime = Date.now()
    ;(async () => {
      try {
        if (maxTurns) agent.maxTurns = maxTurns
        const result = await agent.run(text, { signal: task.abortController.signal })
        entry.lastRunAt = Date.now()
        if (!task.isTerminal()) {
          task.appendOutput(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
          task.complete(result)
        }
      } catch (e) {
        if (!task.isTerminal()) {
          task.appendOutput(`ERROR: ${e?.stack || e?.message || String(e)}`)
          task.fail(e?.message || String(e))
        }
      } finally {
        runningSubagents = Math.max(0, runningSubagents - 1)
      }
    })()

    return {
      ok: true, resumed: true, background: true, name, type: entry.type,
      task_id: task.taskId,
      duration_ms: Date.now() - startTime,
    }
  }

  runningSubagents++
  const startTime = Date.now()
  try {
    if (maxTurns) agent.maxTurns = maxTurns
    const result = await agent.run(text, { signal })
    entry.lastRunAt = Date.now()
    return {
      ok: true, resumed: true, name, type: entry.type,
      result,
      duration_ms: Date.now() - startTime,
      total_messages: agent.messages?.length || 0,
    }
  } catch (e) {
    return { ok: false, resumed: true, name, error: e?.message || String(e) }
  } finally {
    runningSubagents = Math.max(0, runningSubagents - 1)
  }
}

export class SubAgentTool extends Tool {
  constructor({ api, visionApi = null, systemPromptBase, tools, onPermissionRequest, getSubagentTypes, cwd = null, sessionId = null, hookManager = null, parentMessages = null }) {
    super({
      name: 'Agent',
      // 【2026-10-20 补编排纪律】原来这里只有一句「创建一个子 agent 独立完成任务」，
      // 而官方的编排纪律有近 130 行。CCM 把这些内容放在 Coordinator 子 Agent 类型
      // 和 /coordinate 模式里 —— 只在进入协调者模式时才可见。普通模式下 spawn
      // worker，模型看不到任何纪律，容易「见任务就扇出」。
      //
      // 这里补的是**普通模式也需要的**四条，不是把官方全文搬过来：
      //   1. 什么时候该派（判据），什么时候不该派
      //   2. 派了之后要自己读结果，不许偷懒转交
      //   3. worker 看不到主对话，prompt 必须自包含
      //   4. 并行按资源冲突分组，不是按个数
      description:
        '创建一个子 agent 独立完成任务。子 agent 有独立的上下文窗口，适合处理需要多步骤的独立子任务（避免污染主对话上下文）。\n' +
        '\n' +
        '【什么时候该派】任务能拆成**真正独立**的几块、且每块都需要大量探索/多轮工具调用时才值得。\n' +
        '**不该派的**：\n' +
        '- 几句话能答的、一两个工具调用能做完的 —— 自己做完更快，派出去反而要重讲一遍背景\n' +
        '- 「多角度」「彻底」「分几部分」这类描述**不等于**要派 agent，那是在要求你做仔细，不是要你扇出\n' +
        '- 用户没提 agent/subagent 时，优先自己用现有工具做完\n' +
        '\n' +
        '【默认在后台跑】spawn 后立即返回 task_id，你可以接着派下一个或自己干别的。\n' +
        '取结果用 `AgentOutput({task_id, block:true})` —— 它会一直等到 agent 完成再返回，\n' +
        '这是等结果的**正确方式**，不要写 Bash sleep + 反复 AgentStatus 轮询。\n' +
        '只有当下一步动作**必须**依赖这个 agent 的结果、且期间确实没有别的事可做时，\n' +
        '才传 `run_in_background: false` 同步等。\n' +
        '\n' +
        '【派了之后必须自己读结果】子 agent 的报告描述的是它**打算**做什么，不一定等于它真的做了。\n' +
        '它说「改完了」，你要去看实际 diff；它说「测试通过」，你要看跑的是什么命令。\n' +
        '**禁止偷懒转交**：后续派活时不要写「基于你的发现去修」这种话 —— 那是把「理解」这件事\n' +
        '丢回给 worker，你自己根本没读懂。要先自己读懂，再把具体到文件行号的 spec 交给它。\n' +
        '\n' +
        '【worker 看不到你的对话】它的 prompt 必须自包含：目标、约束、相关文件路径、\n' +
        '验收标准、报告长度上限，一样都不能少。\n' +
        '\n' +
        '【并行按资源冲突分组，不是按个数】只读任务（调研/搜索/读代码）可以放开并行；\n' +
        '**写同一批文件的任务必须串行** —— 否则两个 worker 各自读到旧内容再写回，\n' +
        '后写的静默覆盖前面的改动，不报错但工作丢失，最难查。',
      input_schema: {
        type: 'object',
        properties: {
          subagent_type: {
            type: 'string',
            description: '子 agent 类型。内置：general-purpose（全工具，独立完成复杂任务）/ Explore（只读，调研代码库）/ Plan（只读+TodoWrite，制定执行计划）/ Coordinator（编排多个 worker 并行）/ fork（继承主对话完整历史，并行分头去试不同方案）。也可填 .claude/agents 自定义名（见系统提示词）。默认 general-purpose。'
          },
          description: {
            type: 'string',
            description: '对任务的简短描述（3-5 个词），仅做标识用，不影响执行。'
          },
          agent_name: {
            type: 'string',
            description: '给这个子 agent 起个名字（如 worker-1 / reviewer）。之后可用 SendMessage(to:该名字) 唤醒它继续干活，复用它原有的上下文——它还记得自己之前做过什么，不需要你把背景重新讲一遍。省略则用 description 当名字。'
          },
          // 【官方字段名 `name`】官方 2.1.303 的 Agent inputSchema 用的是 `name`
          //（claude.js:1004370，带正则校验 + 保留名检查）。CCM 早期用了 agent_name，
          // 现在两个都收、`name` 优先 —— 按官方文档写 `name` 的用户不该静默失效。
          name: {
            type: 'string',
            description: '（官方同名字段，等价于 agent_name）给这个子 agent 起个名字，后续用 SendMessage(to:该名字) 唤醒。与 agent_name 二选一，同时给时以 name 为准。'
          },
          prompt: {
            type: 'string',
            description: '给子 agent 的完整任务指令。应该是一个自包含的 prompt，子 agent 会以此作为首轮 user message。'
          },
          // 【默认后台，对齐官方 claude.js:1004366】
          // 官方原文："Agents run in the background by default; you will be notified
          // when one completes. Set to false only when your very next action depends
          // on this agent's result and nothing else could usefully happen while it runs"
          //
          // CCM 原来默认 false（前台同步等），等于把「并行」这个子 Agent 最大的
          // 价值默认关掉了：模型 spawn 一个就得原地干等，扇出 N 个也要等 N 次。
          // 改成默认 true 后，spawn 立即返回 task_id，主对话可以接着派下一个、
          // 或者自己做别的事，最后用 AgentOutput({block:true}) 一次等全部。
          run_in_background: {
            type: 'boolean',
            description: '默认在后台运行（立即返回 task_id，完成后可用 AgentOutput 取结果）。'
              + '只有当下一步动作**必须**依赖这个 agent 的结果、且期间没有别的有用事情可做时才传 false（同步等待）。',
            default: true
          },
          // 对齐官方 Claude Code 2.1.x 的 effort：给这个子 Agent 单独指定
          // 思考强度。用途是「派一个只做机械搜索的 Explore 时别烧高思考预算，
          // 派一个攻坚型 agent 时拉满」。不传就沿用当前 provider 的全局设置。
          //
          // 档位与官方 EFFORT_LEVELS 一致（claude.js: EFFORT_LEVELS =
          // ["low","medium","high","xhigh","max"]），外加 auto。
          // CCM 底层 getThinkingPolicy 支持 none/minimal/low/medium/high/xhigh/max
          // 七档且**原样透传**给服务端，所以这里不需要降级映射 —— 传什么就是什么，
          // 服务端不认的档位由 _thinkingFallbackKeys 学习后停发思考参数。
          //
          // 兼容旧的 lower/higher（历史上只有这两档）：
          //   lower  → low     （旧语义「省 token」）
          //   higher → max     （旧语义「拉满」）
          effort: {
            type: 'string',
            enum: ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'lower', 'higher'],
            description: '可选：这个子 Agent 的思考强度。'
              + 'auto=沿用当前全局 /effort 设置（同不传）；'
              + 'low/medium/high/xhigh/max=指定档位（机械搜索用 low，疑难 bug/架构设计用 xhigh 或 max）。'
              + '兼容旧值：lower 等价 low、higher 等价 max。'
          },
          // 模型覆盖（对齐官方 model enum，"Takes precedence over the agent
          // definition's model frontmatter"）。
          //
          // 【不设 enum】官方是 `["sonnet","opus","haiku","fable"]`，但 CCM 的模型名
          // 由用户 /config 决定（deepseek-v4.1-flash / glm-4.6 / claude-sonnet-5 …），
          // 写死官方那四个会让几乎所有真实取值直接校验失败。这里只约束形态：
          // 一个非空字符串，交给 provider 自己判断认不认。
          model: {
            type: 'string',
            description: '可选：让这个子 Agent 用另一个模型（优先于子 Agent 类型卡里的 model frontmatter）。'
              + '不传则沿用主 Agent 当前模型。'
              + '注意：模型必须在当前 provider 的可用列表里 —— '
              + '只认一个模型的中转站会直接返回 400/404，此时会明确报错而不是静默退回主模型。'
          },
          // 工具黑名单（对齐官方 disallowedTools，claude.js:61717）。
          //
          // 【为什么用差集而不是只生效于白名单】角色卡的 tools 是白名单，
          // 这里是从「最终工具集」里减掉一批。语义：
          //   · toolNames 为 null（全部工具）→ 全部 - disallowed
          //   · toolNames 是白名单          → 白名单 - disallowed
          // 两种都是差集，不会出现「白名单里没有、黑名单却禁掉」的静默失效。
          //
          // 【为什么要这个】白名单要求调用方预先知道「该给哪些」，
          // 而常见需求是反过来的：「跟通用的一样，但别让它碰 Bash / Write」。
          // 写白名单就得把几十个工具名抄一遍，漏一个就是个残废 agent。
          disallowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：禁止这个子 Agent 使用的工具名（如 ["Bash","Write"]）。'
              + '在角色卡 tools 白名单的基础上做**差集**：白名单为「全部」时是 全部-禁用的。'
              + '与白名单冲突到「一个工具都不剩」时会直接报错并列出冲突项，不会建一个零工具的 agent。',
          },
        },
        required: ['prompt']
      },
      // 【元数据声明】原来全部走默认值，等于对框架说「我是只读的、且不能并行」。
      // 两个都错：
      //  · isReadOnly 默认 false —— 这个是对的（子 Agent 会改文件），但必须显式声明，
      //    否则哪天默认值改成 true，权限系统会放行一个会写盘的调用。
      //  · isConcurrencySafe 默认 false —— 这个把并行 spawn 全串行化了。
      //    官方 Agent 工具是允许并行的（这正是编排的意义：同时派 5 个 worker）。
      //    CCM 靠 MAX_CONCURRENT_SUBAGENTS 做真正的并发闸门，不该在工具层再串行一遍。
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      // 官方 Agent 的 aliases 含 "Task"（claude.js:945900）。模型按官方旧名
      // 调 `Task` 时不该 Tool not found。
      aliases: ['Task'],
      searchHint: 'spawn a subagent to work on a task',
      backgrounding: 'never',
      // 官方字段名 name → 内部 agent_name（见 coerceAgentInput 的注释）
      coerceInput: coerceAgentInput,
      // 官方 maxResultSizeChars 是 1e5；这里保持 30000 的全局默认不写死，
      // 因为子 Agent 的返回结果通常只有几段话，写死一个大值没有收益。
    })
    this.api = api
    this.visionApi = visionApi
    this.systemPromptBase = systemPromptBase
    // tools 可以是数组，也可以是返回数组的函数（惰性）。
    // 必须支持惰性：调用方在 registry 里注册 SubAgentTool 本身之前就要把
    // tools 传进来，若此时取数组快照，快照里就永远没有 'Agent' 自己
    // → 子 Agent 拿不到 Agent 工具，无法再往下 spawn（实测报 Tool not found）。
    this._tools = tools
    this.onPermissionRequest = onPermissionRequest || (async () => true)
    this.getSubagentTypes = getSubagentTypes || (() => BUILTIN_SUBAGENT_TYPES)
    this.cwd = cwd || null
    this.sessionId = sessionId || null
    // 【子 Agent 的 hooks（对齐官方 2.1.303 的 SubagentStart / SubagentStop）】
    //
    // 原来子 Agent 完全拿不到 hookManager（构造时不传，agent.hookManager 保持 null），
    // 于是子 Agent 内部所有 PreToolUse / PostToolUse hook 都不生效 —— 用户配的
    // 「禁止改某目录」「写文件前跑格式化」这类规则，**只在主 Agent 上生效**，
    // 子 Agent 可以绕过去。官方子 Agent 是有完整 hooks 的，这是行为差异不是设计。
    //
    // 可选参数（默认 null）：不传时行为与旧版完全一致，不会让任何既有调用方报错。
    // 真正的接线由 index.mjs / engine-setup.mjs 传进来（见那边的注释）。
    this.hookManager = hookManager
    // fork 类型要继承的父对话历史。
    // 传函数而不是数组：主对话的 messages 每轮都在变，构造时取快照会拿到旧历史；
    // 且 SubAgentTool 是长生命周期对象（registry 里只注册一次），快照必然过期。
    // 不传（null）时 fork 类型退化成 general-purpose（没有历史可继承），不报错。
    this._parentMessages = parentMessages
  }

  /** 取当前工具集（惰性时每次求值，才能拿到后注册的 Agent 工具） */
  get tools() {
    return typeof this._tools === 'function' ? (this._tools() || []) : (this._tools || [])
  }

  /** 取父对话历史（惰性；未接线时返回 null） */
  get parentMessages() {
    const src = this._parentMessages
    if (typeof src === 'function') {
      try { return src() || null } catch { return null }
    }
    return src || null
  }

  async execute(input) {
    // 【并发闸门】放在最前面：占额之前不做任何有副作用的事（如 keyPool.advance）
    if (runningSubagents >= MAX_CONCURRENT_SUBAGENTS) {
      recordRefused('concurrency_limit', { running: runningSubagents, limit: MAX_CONCURRENT_SUBAGENTS })
      return JSON.stringify({
        ok: false,
        rejected: 'concurrency_limit',
        running: runningSubagents,
        limit: MAX_CONCURRENT_SUBAGENTS,
        message: `当前已有 ${runningSubagents} 个子 Agent 在运行，达到并发上限 ${MAX_CONCURRENT_SUBAGENTS}，本次未启动。`,
        hint: '这不是错误、任务也没失败。请任选一种做法：(1) 先用 AgentStatus 等已有子 Agent 完成，再重试这次调用；(2) 把打算并行的子任务改成串行、一个个来；(3) 缩减这一层的扇出数量，或自己直接做掉其中一部分。不要因此放弃整个任务。',
      }, null, 2)
    }

    // 【派生深度闸门】并发管横向、深度管纵向，缺一个都会失控。
    // 判定放在并发闸门之后：深度超限是「结构问题」，比「资源暂时不够」更严重，
    // 但先报资源更容易被误读成「等一下就好」，所以让并发先说话。
    const depth = await getCurrentSpawnDepth()
    if (depth >= MAX_SUBAGENT_DEPTH) {
      recordRefused('depth_limit', { depth, limit: MAX_SUBAGENT_DEPTH })
      return JSON.stringify({
        ok: false,
        rejected: 'depth_limit',
        depth,
        limit: MAX_SUBAGENT_DEPTH,
        message: `子 Agent 嵌套深度已达上限（当前第 ${depth} 层 / 上限 ${MAX_SUBAGENT_DEPTH} 层），本次未启动。`,
        hint: '这不是错误、任务也没失败。请用你自己的工具直接把这个子任务做完——你已经在这条链路的末端了，再派下去没有可用的监督者。若确实需要更深的嵌套（例如三层扇出的完整协作树），请用户设置环境变量 CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH 后重启。',
      }, null, 2)
    }

    const { Agent } = await import('./agent.mjs')
    const types = this.getSubagentTypes()
    const type = types[input.subagent_type] ? input.subagent_type : 'general-purpose'
    const cfg = types[type] || BUILTIN_SUBAGENT_TYPES['general-purpose']

    let subTools
    if (cfg.toolNames === null) {
      const DISABLED_FOR_SUBAGENT = ['AskUserQuestion']
      subTools = this.tools.filter(t => !DISABLED_FOR_SUBAGENT.includes(t.name))
    } else {
      subTools = this.tools.filter(t => cfg.toolNames.includes(t.name))
    }

    // ── disallowedTools（对齐官方黑名单）────────────────────────────
    //
    // 做差集：白名单（或全部）减去禁用的。校验放在**过滤之前**算交集，
    // 因为「白名单只有 Read、disallowed 也是 Read」这种全冲突的情况，
    // 过滤后只是拿到空数组 —— 那既可能是配置写错、也可能是这个 agent
    // 本来就没工具可用，报错时要说清楚是哪一种。
    //
    // 来源两处合并：角色卡 frontmatter 的 disallowed-tools（长期配置）+
    // 本次调用的 input.disallowedTools（临时）。两者是并集，不互相覆盖 ——
    // 「卡片说别碰 Write、这次又说别碰 Bash」的意图是两个都禁。
    const cardDisallowed = normalizeDisallowedTools(cfg.disallowedTools)
    const disallowed = normalizeDisallowedTools(input.disallowedTools)
    for (const n of cardDisallowed) if (!disallowed.includes(n)) disallowed.push(n)
    if (disallowed.length && cfg.toolNames) {
      const conflict = disallowed.filter(n => cfg.toolNames.includes(n))
      const remain = cfg.toolNames.filter(n => !disallowed.includes(n))
      if (remain.length === 0) {
        return JSON.stringify({
          ok: false,
          rejected: 'tool_conflict',
          type,
          message: `disallowedTools 与角色卡 "${type}" 的工具白名单完全冲突：\n`
            + `  白名单: ${cfg.toolNames.join(', ')}\n`
            + `  禁用的: ${conflict.join(', ')}\n`
            + `  剩下: (无)\n`
            + `这会造出一个零工具的子 Agent（连话都说不成），所以本次未启动。\n`
            + `改法：把白名单放宽（角色卡 frontmatter 的 tools），或少禁几个。`,
        }, null, 2)
      }
    }
    if (disallowed.length) {
      subTools = subTools.filter(t => !disallowed.includes(t.name))
    }

    // AgentMemory 要按「子 Agent 自己的类型」读写，不能沿用主 Agent 的 type=main，
    // 否则所有子 Agent 的经验会混进同一个文件、失去按角色积累的意义。
    try {
      const idx = subTools.findIndex(t => t.name === 'AgentMemory')
      if (idx >= 0) {
        const { AgentMemoryTool } = await import('../tools/tools-agent-memory.mjs')
        subTools = [...subTools]
        subTools[idx] = new AgentMemoryTool({
          getAgentType: () => type,
          cwd: this.cwd || process.cwd(),
        })
      }
    } catch {}

    // 【自动注入同类 Agent 的长期记忆】
    // 不能指望子 Agent 自己想着去 read —— 它开局就该带着前人的经验，
    // 否则同一个 code-reviewer 第十次跑仍然不记得前九次踩过什么坑。
    // 只读一次、有上限（readMemory 内部裁到 6000 字符，取最近的部分）。
    let memoryBlock = ''
    try {
      const { readMemory } = await import('./agent-memory.mjs')
      const mem = readMemory({ type, cwd: this.cwd || process.cwd() })
      if (mem) {
        memoryBlock = `\n\n## 你这类 Agent 的长期记忆\n`
          + `（同类 Agent 历次积累，已自动读入，不必再调 AgentMemory read）\n\n${mem}\n`
          + `\n做完这次任务后，如果有值得留给"未来的自己"的经验，用 AgentMemory({action:"write"}) 记一条。\n`
      }
    } catch {}

    // 【ExtendTurns 必须写进可用工具清单】它是运行时注入的（不在角色卡 tools: 白名单里），
    // 如果这里不提，子 Agent 根本不知道自己能续轮 —— 撞上限时只会交半成品。
    // disallowedTools 要把扣掉的部分明说：子 Agent 看不到工具列表，
    // 得让它知道自己被禁了什么，否则它会反复尝试一个不存在的工具名。
    const effectiveToolNames = cfg.toolNames === null
      ? null
      : [...cfg.toolNames, 'ExtendTurns'].filter(n => !disallowed.includes(n))
    const toolListText = effectiveToolNames === null
      ? (disallowed.length ? `(全部，但禁用: ${disallowed.join(', ')})` : '(全部)')
      : effectiveToolNames.join(', ')
    const subSystemPrompt = this.systemPromptBase + '\n' + cfg.promptAddition +
      `\n\n## 当前子 Agent 类型：${type}\n可用工具：${toolListText}\n`
      + `\n## 轮次预算\n你的工具轮次上限是 ${cfg.maxTurns} 轮。快到上限时会收到系统提示，届时：\n`
      + `任务确实没做完 → 用 **ExtendTurns** 续轮（最多续 4 次、每次最多 +60、硬上限 400）；\n`
      + `已基本完成或发现自己在原地打转 → 立刻收尾，如实交代未完成部分。\n`
      + `**不要交「函数写好了但没接线」这类半成品**：要么做完并自测通过，要么在报告和 TaskUpdate 的 comment 里\n`
      + `写清「未完成的是什么、下一步该怎么做、有哪些已查明的前置结论」，让续做者能直接接手。\n`
      + memoryBlock

    const startTime = Date.now()

    // 子 agent 之间的 key 轮换：共享同一个 KeyPool 的前提下，
    // 每起一个子 agent 就把池指针前进一步，让并行子 agent 落在
    // 不同账号的 key 上——11 个号并行 4 个 agent 只占 4 个号，
    // 不再出现「全部挤同一个账号，429 连环触发」的拥挤。
    // 主 agent 接下来发请求时从池子当前位置取，也是错开的。
    // 单 key 池（size<2）则不 advance，key 转不动。
    try {
      if (this.api?.keyPool && this.api.keyPool.size >= 2) {
        this.api.keyPool.advance()
      }
    } catch {}

    // 计数在 runAndCollect 内增减：后台与同步两条路径都经过它，
    // 且 finally 保证异常/取消时一定归还名额（否则跑几次就永久占满 9 个）
    // onAgentReady：把刚建好的 agent 实例交给调用方（后台分支用它读实时 turnCount）。
    // 不这么做的话 sub 只是局部变量，AgentStatus 只能读 result.turns —— 而 result
    // 要等跑完才有，running 期间 turns 恒为 0，看起来像卡死（实际在正常干活）。
    const runAndCollect = async (signal = null, onAgentReady = null) => {
      runningSubagents++
      // 子 Agent 内部再调 Agent 工具时，深度 +1。
      // 用 ALS.run 包住整条链路（含它的所有 await），子 Agent 里任何深度的
      // Agent 调用都能读到正确的 depth —— 见 getCurrentSpawnDepth 的注释。
      const als = await getDepthAls()
      return als.run({ depth: depth + 1 }, async () => {
      try {
        let sub = null
        // 【给子 Agent 自主续轮的能力】它不能用 EnterDeepMode（那是主进程全局单例，
        // 对自己无效）。ExtendTurns 直接改 sub.maxTurns，getAgent 用闭包拿当前实例。
        // 必须在 new Agent 之前把工具接好：工具列表是构造参数，事后动不了。
        const extendTool = new ExtendTurnsTool({ getAgent: () => sub })
        const toolsWithExtend = [...subTools, extendTool]
        // effort 参数换算成具体档位。
        //
        // 官方 EFFORT_LEVELS = ["low","medium","high","xhigh","max"]，CCM 底层
        // getThinkingPolicy 支持 none/minimal/low/medium/high/xhigh/max 且原样
        // 透传，所以官方档位直接透传，不做降级。
        // auto（或不传）= 不覆盖，沿用全局 /effort 设置。
        // lower/higher 是 CCM 历史档位，保留映射：lower→low、higher→max。
        const EFFORT_ALIASES = { lower: 'low', higher: 'max' }
        const rawEffort = typeof input.effort === 'string' ? input.effort.trim().toLowerCase() : ''
        const effortOverride = (!rawEffort || rawEffort === 'auto')
          ? null
          : (EFFORT_ALIASES[rawEffort] || rawEffort)
        // 【model 覆盖】官方 Agent 工具有 model 参数（优先于角色卡的 frontmatter）。
        // 用 ApiClient.clone() 拿一份独立 client，而不是直接改 this.api.model ——
        // 后者会把主 Agent 的模型也改掉（子 Agent 一跑完，主对话就换了后端）。
        //
        // 为什么 clone 而不是 Object.create：原型链继承会让「后续对父对象的修改」穿透
        // 到子 Agent。切 provider 时主 api 会原地改 model/baseUrl，已经派出去的
        // 子 Agent 会跟着换后端，症状是跑到一半开始报 400。见 ApiClient.clone 注释。
        //
        // 【provider 不认指定模型时怎么办】不静默退回。只认一个模型的中转站会返回
        // 400/404，那时错误原样报给调用方（含指定的模型名），让人能立刻看出是
        // 「这个 provider 没有这个模型」而不是别的故障。
        let subApi = this.api
        const requestedModel = typeof input.model === 'string' ? input.model.trim() : ''
        if (requestedModel && this.api && typeof this.api.clone === 'function') {
          if (String(this.api.model || '') === requestedModel) {
            subApi = this.api  // 就是当前模型，没必要 clone
          } else {
            subApi = this.api.clone({ model: requestedModel })
          }
        }
        sub = new Agent({
          api: subApi,
          visionApi: this.visionApi,
          systemPrompt: subSystemPrompt,
          tools: toolsWithExtend,
          maxTurns: cfg.maxTurns,
          onPermissionRequest: this.onPermissionRequest,
          cwd: this.cwd,
          sessionId: this.sessionId,
          effortOverride,
        })
        // 子 Agent 继承同一份 hooks（对齐官方：子 Agent 也受 PreToolUse 等约束）。
        // 不继承的话，用户配的「禁止改 X 目录」只在主 Agent 生效，子 Agent 能绕过去 ——
        // 那是权限漏洞，不是风格差异。hookManager 为 null 时保持旧行为。
        if (this.hookManager) sub.hookManager = this.hookManager
        // 标记「这是子 Agent 的一次 run」—— agent.mjs 的 Stop hook 据此跳过。
        // 子 Agent 有自己的生命周期事件（SubagentStop，见下方 fireStop），
        // 两者语义不同：Stop 是「主对话这一轮说完了」，SubagentStop 是「这个子任务结束了」。
        // 不区分的话，一个子 Agent 收尾会触发用户配的 Stop hook（比如"跑完自动跑测试"），
        // 十几个子 Agent 就触发十几次，而且每次都在错误的时机。
        sub._isSubagentRun = true
        // 【fork：继承主对话的完整历史】
        //
        // 官方 fork 类型（claude.js:226341 str836="fork"）的价值在于「同一份上下文、
        // 并行分头干活」——省掉重建上下文的全部 token，而且它记得每个决定。
        // CCM 的 SendMessage(wake) 只覆盖了「复用上下文」这半，它是**串行**的
        // （同一个实例接着跑）；fork 要的是**并行**。
        //
        // 实现要点：浅拷贝消息数组再逐条深拷贝，绝不能共享同一批消息对象 ——
        // 子 Agent 会往自己的 messages 里 push，共享数组会让主对话历史被污染
        //（表现为主对话突然出现自己没说过的话，极难查）。
        if (type === 'fork' && Array.isArray(this.parentMessages)) {
          sub.messages = this.parentMessages.map(m => ({ ...m }))
        }
        // 子 agent 接近上限的提示：告知两条路（续轮 / 收尾）并要求它自己判断。
        // 原来只说「立即收尾」，于是真的没做完也只能交半成品（实测：CPO 60 轮用尽，
        // 四件事只完成两件的逻辑且未接线）。现在让它分清「真的需要更多轮」和
        // 「在原地打转」，前者续、后者收 —— 判断线索写具体（空转的典型形态）。
        sub.onTurnLimitApproaching = (turns, max) => {
          sub.messages.push({
            role: 'user',
            hidden: true,
            content: `（系统提示：本子任务已执行 ${turns} 轮，距上限 ${max} 只剩不到 10 轮。`
              + `先自查最近几轮是不是在**空转**：反复调用同一个工具却拿不到新信息、同一处改了又改、同一个错误反复出现而没有实质推进。`
              + `① 不是空转、任务确实还需要更多轮 —— 用 ExtendTurns 工具给自己续轮（写明已完成什么、还剩什么、预计几轮收尾），然后继续干，不要草草收尾；`
              + `② 是空转（或已基本完成）—— 立即收尾，把已完成和未完成的部分如实写进最终报告，不要无声中断。`
              + `禁止为了看起来「完成了」而交未接线/未验证的半成品。）`,
          })
        }
        // 留下实例供后续 SendMessage 唤醒续跑（复用上下文）。
        // 放在 run 之前登记：万一中途报错，之后也能唤醒它问"你卡在哪了"。
        keepAgent(input.agent_name || input.description, sub, type)
        try { onAgentReady?.(sub) } catch {}
        // SubagentStart / SubagentStop（对齐官方 2.1.303）
        //
        // 【为什么需要】子 Agent 是个黑盒：主对话只看得到「在跑 / 跑完了」，
        // 中间既不进主对话、也不进终端。用户想「子 Agent 一启动就给我发个通知」
        // 「跑完自动跑测试」以前完全做不到 —— 只能在主 Agent 侧轮询 AgentStatus。
        // 官方把这两个时点做成 hook 事件，正是为了解决这个。
        //
        // 【agent_name 传什么】优先用户指定的 agent_name，否则用类型名。
        // matcher 按它匹配，所以写 "worker-1" 或 "Explore" 都能命中。
        const agentLabel = input.agent_name || input.description || type
        const hookBase = { agentName: agentLabel, agentType: type, matcher: type }
        if (this.hookManager) {
          try {
            await this.hookManager.trigger('SubagentStart', {
              event: 'SubagentStart', ...hookBase,
              prompt: String(input.prompt || '').slice(0, 2000),
            })
          } catch (e) { /* hook 失败不能挡住子 Agent 启动 */ }
        }
        // 无论成功失败都要发 Stop —— 否则失败/中断的子 Agent 会「有始无终」，
        // 依赖 Stop 做清理的 hook 永远等不到。
        // 【background_tasks / session_crons】官方 SubagentStop payload 带这两个计数
        // （regex122.js:6912：告诉 hook「这个子任务留下了哪些会话内后台资产」）。
        // CCM 有对应物：后台任务 Map（bg-tasks）+ session 级 cron（非 durable）。
        // hook 脚本常用来决定「要不要等它 / 要不要清理」，缺了这俩只能盲等。
        const countBackgroundTasks = () => {
          try { return listBackgroundTasks().filter(t => t.status === 'running' || t.status === 'pending').length } catch { return 0 }
        }
        const countSessionCrons = () => {
          try { return listCronTasks().filter(t => !t.durable).length } catch { return 0 }
        }
        const fireStop = async (outcome, detail) => {
          if (!this.hookManager) return
          try {
            await this.hookManager.trigger('SubagentStop', {
              event: 'SubagentStop', ...hookBase, outcome, ...detail,
              background_tasks: countBackgroundTasks(),
              session_crons: countSessionCrons(),
            })
          } catch (e) { /* 同上，不阻塞 */ }
        }
        try {
          const result = await sub.run(input.prompt, { signal })
          const duration = Date.now() - startTime
          const tokenUsage = sub.getTokenUsage()
          await fireStop('ok', { duration_ms: duration, turns: sub.turnCount, result: String(result || '').slice(0, 2000) })
          // 【防注入】子 Agent 的报告会作为工具结果回到主 Agent 上下文。
          // 子 Agent 读的是不可信内容（网页 / issue / 被审代码的注释），
          // 里面可能藏伪造的 harness 标记。这里转义后再交回主 Agent ——
          // 见 escapeHarnessMarkup 的注释（对齐官方 SubagentHandback 的处理）。
          // 只转义 result 正文，不动 error（错误信息来自我们自己的代码）。
          return {
            ok: true,
            type,
            description: input.description || input.prompt.slice(0, 60),
            result: escapeHarnessMarkup(String(result || '')) || '(no output)',
            duration_ms: duration,
            duration_human: duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`,
            token_usage: tokenUsage,
            turns: sub.turnCount
          }
        } catch (e) {
          const duration = Date.now() - startTime
          await fireStop('error', { duration_ms: duration, turns: 0, error: e.message })
          return {
            ok: false,
            type,
            description: input.description || input.prompt.slice(0, 60),
            error: e.message,
            duration_ms: duration,
            duration_human: duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`,
            turns: 0
          }
        }
      } finally {
        runningSubagents = Math.max(0, runningSubagents - 1)
      }
      })
    }

    // 【默认后台】`!== false` 而不是 `=== true`：模型没传这个字段时走后台。
    // 与 schema 的 default: true 一致（Tool 基类不应用 schema default，
    // 真正的默认值只能在这里体现，两边必须同步）。
    if (input.run_in_background !== false) {
      const task = registerBackgroundTask('local_agent', input.description || input.prompt.slice(0, 60))
      task.start()
      task.abortController = new AbortController()
      task.agentType = type
      task.agentName = input.agent_name || input.description || null
      // 持有实例：AgentStatus 据此读实时 turnCount / messages 长度
      const promise = runAndCollect(task.abortController.signal, (sub) => { task.agent = sub })
      promise.then(result => {
        if (!task.isTerminal()) {
          task.appendOutput(JSON.stringify(result, null, 2))
          task.complete(result)
        }
      }).catch(e => {
        if (!task.isTerminal()) {
          task.appendOutput(`ERROR: ${e?.stack || e?.message || String(e)}`)
          task.fail(e.message)
        }
      })
      // 【返回文案必须教它下一步怎么取结果】默认后台后，模型如果不知道要主动查，
      // 会以为「派出去就没下文了」或者以为任务失败了。这里把正确做法写死：
      // 用 AgentOutput({block:true}) 等，而不是 /bg-status（那是给用户看的命令）。
      return JSON.stringify({
        task_id: task.taskId,
        status: 'running',
        message: `子 agent [${type}] 已在后台启动，描述：${input.description || '(未命名)'}`,
        next: `用 AgentOutput({task_id:"${task.taskId}", block:true}) 阻塞等它完成并取结果；`
          + `想先看进度用 AgentStatus({task_id:"${task.taskId}"})。`
          + `不要因为现在没结果就以为它失败了 —— 它正在跑。`,
      })
    }

    const out = await runAndCollect()
    return JSON.stringify(out, null, 2)
  }
}

// 转发任务集合变化钩子（index.mjs 用来刷新活动面板）
export function setOnTasksChanged(fn) { return _setOnTasksChanged(fn) }
