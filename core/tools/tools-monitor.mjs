// Monitor 工具（对标官方 Monitor：后台输出**推式**通知，不是模型轮询）
//
// 官方语义（chunk-6kxyzcjw.js:52，官方 cron 工具描述里的对比说明）：
//   「To watch a log file, process, or command output and be notified the moment
//     something changes, use the `Monitor` tool instead — `Monitor` streams
//     events as they happen; cron polls on a schedule.」
//
// 与 BashOutput 的分工：
//   BashOutput  = 轮询式，要模型主动调，timeout 上限 30000ms
//   Monitor     = 推式，stdout 每出一行就往模型上下文里注入一条 <task_notification>
//
// 【推送通道】不直接碰 agent.mjs：本工具构造时收一个 `pushSteering` 函数
//（由注册方注入 `() => agent.pushSteering`）。没有这个函数时降级成
// 「可轮询 handle」——把累积的行留在内存里，由 BashOutput 的增量读取走，
// 报告里对 main 的接线说明见 audit/fix-monitor-r4-report.md。
//
// 【三个坑】去重 / 行数上限 / 通道缺失，处理见下方常量与注释。
import { Tool } from './tools.mjs'
import {
  startBackgroundBash,
  attachOutputSink,
  onBackgroundTaskClose,
} from '../agent/bg-bash.mjs'
import { getBackgroundTask } from '../agent/bg-tasks.mjs'

// ── 上限（坑 2：刷屏日志瞬间爆上下文）─────────────────────────────
// 单次 chunk 最多推送多少行。一个 chunk 里可能挤了几十行（进程批量 flush），
// 全推会让一次注入把上下文撑爆；剩下的行丢弃并告知模型。
const MAX_LINES_PER_PUSH = 10
// 整个监控任务累计推送行数上限。到顶后停止推送、通知模型改用 BashOutput 手动读。
const MAX_TOTAL_LINES = 1000
// 单行长度上限：超长行（堆栈/JSON blob）截断，防止一行就吃掉几千 token。
const MAX_LINE_CHARS = 500
// 推送文本总长度上限（兜底）：一次注入的消息体最大字符数。
const MAX_PUSH_CHARS = 4000

const monitorStates = new Map()

function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

function truncateLine(line) {
  if (line.length <= MAX_LINE_CHARS) return line
  return line.slice(0, MAX_LINE_CHARS) + `…[截断, 原 ${line.length} 字符]`
}

/**
 * 行切分器：把任意 chunk 边界的数据切成「完整行」。
 * 保留末尾半行到 buf，等下一个 chunk 补全 —— 不按 chunk 边界硬切，
 * 否则 `for i in 1 2 3; do echo "line $i"; done` 这种一次 flush 三行的
 * 输出会被当成三块各含半个换行，行号全错。
 */
class LineSplitter {
  constructor() { this.buf = '' }
  push(chunk) {
    this.buf += chunk
    const out = []
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      out.push(this.buf.slice(0, idx))
      this.buf = this.buf.slice(idx + 1)
    }
    return out
  }
  /** 进程退出时调：把残留半行作为最后一行吐出（可能为空串） */
  flush() {
    const rest = this.buf
    this.buf = ''
    return rest
  }
}

/**
 * 给一个后台任务挂监控（按行切分 + 去重 + 上限 + 推送）。
 * 启动命令和挂监控分开：这样「对已存在的 task_id 调 Monitor」只需后半段，
 * 不会重复 spawn 一个进程。
 * @returns {{state}} state 是内部句柄（测试与降级路径用）
 */
function monitorTask(task, { pattern, tailLines, push }) {
  const state = {
    taskId: task.taskId,
    command: task.description,
    pattern: pattern || null,
    regex: null,
    splitter: new LineSplitter(),
    // 坑 1（去重）：行号单调递增，只推没推过的。重复调用 Monitor 挂同一个
    // task 时复用同一个 state，不会从头再推一遍。
    lineNo: 0,
    pushedTotal: 0,
    // 已处理（发出 + 因上限丢弃）的行数。累计上限判它而不是 pushedTotal：
    // 否则刷屏日志永远发不满 MAX_TOTAL_LINES，上限失效（实测踩过）。
    consumed: 0,
    stopped: false,
    push,
    finished: false,
    tailPending: tailLines > 0,
  }
  if (pattern) {
    try {
      // 不带 g：每行只判一次匹配，不需要全局
      state.regex = new RegExp(pattern)
    } catch (e) {
      state.badPattern = e.message
    }
  }
  monitorStates.set(task.taskId, state)

  // ── 单批预算（跨 chunk 累积）──────────────────────────────────────
  // 「单次推送最多 N 行」的"次"指的是**一次注入事件**，不是"一次 data 回调"。
  // 进程批量 flush 时同一批输出可能拆成 2~3 个 chunk 在同一毫秒到达，
  // 每个 chunk 独立享受 10 行预算的话实际推了 20~30 行，上限形同虚设
  //（实测 seq 1 40 推出 20 行）。
  // 方案：预算按时间窗重置 —— 距上次推送 < WINDOW_MS 视为同一次注入，
  // 共享同一个预算；安静超过 WINDOW_MS 才重新给满。
  const BURST_WINDOW_MS = 200
  let burstBudget = MAX_LINES_PER_PUSH
  let lastPushAt = 0
  const refillBurst = () => {
    const now = Date.now()
    if (now - lastPushAt >= BURST_WINDOW_MS) burstBudget = MAX_LINES_PER_PUSH
  }

  const pushLines = (lines) => {
    if (state.stopped || !state.push || !lines.length) return 0
    refillBurst()
    let charBudget = MAX_PUSH_CHARS
    const parts = []
    let sent = 0
    let dropped = 0
    for (const raw of lines) {
      // 已发出的 + 因上限丢弃的都计入 consumed：只看发出量的话，
      // 一次涌来 2000 行的日志每批只能发 10 行，pushedTotal 永远爬不到
      // MAX_TOTAL_LINES，累计上限形同虚设。
      state.consumed++
      if (state.consumed >= MAX_TOTAL_LINES) state.stopped = true
      if (burstBudget <= 0 || charBudget <= 0) { dropped++; continue }
      const line = truncateLine(raw)
      parts.push(`<task_notification task="${task.taskId}" line="${state.lineNo + 1}">${line}</task_notification>`)
      state.lineNo++
      sent++
      burstBudget--
      charBudget -= line.length + 60
      state.pushedTotal++
    }
    if (sent > 0) lastPushAt = Date.now()
    if (dropped > 0 && !state.stopped) {
      parts.push(`<task_notification task="${task.taskId}">[本批 ${dropped} 行未推送：单次注入上限 ${MAX_LINES_PER_PUSH} 行，用 BashOutput(task_id="${task.taskId}") 读全量]</task_notification>`)
    }
    if (parts.length) {
      try { state.push(parts.join('\n')) } catch {}
    }
    if (state.stopped) {
      try {
        state.push(
          `<task_notification task="${task.taskId}">[已停止推送：累计已达上限 ${MAX_TOTAL_LINES} 行。任务仍在后台运行，` +
          `后续输出用 BashOutput(task_id="${task.taskId}") 手动读取；KillShell(task_id="${task.taskId}") 终止]</task_notification>`
        )
      } catch {}
    }
    return sent
  }

  attachOutputSink(task, (chunk) => {
    const lines = state.splitter.push(chunk)
    // tail_lines：启动后首批输出只登记行号不推送（用户要的是"从这之后的变化"）。
    // 首批结束后再正常推 —— 用行数判定而不是定时器，避免"日志刷得快/慢"误判。
    if (state.tailPending) {
      state.lineNo += lines.length
      if (state.lineNo >= tailLines) state.tailPending = false
      return
    }
    if (!lines.length) return
    const matched = state.regex ? lines.filter(l => state.regex.test(l)) : lines
    // 被 pattern 过滤掉的行也占行号，保证 line="N" 与文件真实行号一致
    if (state.regex) state.lineNo += lines.length - matched.length
    pushLines(matched)
  })

  onBackgroundTaskClose(task, () => {
    if (state.finished) return
    state.finished = true
    const tail = state.splitter.flush()
    if (tail && !state.tailPending && !state.stopped) {
      const matched = state.regex && !state.regex.test(tail) ? [] : [tail]
      if (matched.length) pushLines(matched)
    }
    const t = getBackgroundTask(task.taskId)
    const code = t?.exitCode ?? null
    if (state.push) {
      try {
        state.push(
          `<task_notification task="${task.taskId}">[Monitor 结束：命令已退出，exitCode=${code}。` +
          `共推送 ${state.pushedTotal} 行${state.stopped ? '（已达上限后停止）' : ''}。` +
          `完整输出用 BashOutput(task_id="${task.taskId}") 读取]</task_notification>`
        )
      } catch {}
    }
    // 清理 sink 引用：任务已终态，gcTerminalTasks 之后 task 会被删，
    // state 留着没有意义（再去 Monitor 同一个 id 会被判"不存在"重新起）
    monitorStates.delete(task.taskId)
  })

  return { task, state }
}

/**
 * 挂一个监控到**已存在**的后台任务上（去重入口）。
 *
 * 模型对同一个 task_id 重复调 Monitor 时，走这里：复用已有 state，
 * 不新建 splitter、不从第 0 行重推。若该 task 上已有别的 monitor，
 * 直接返回它的状态（不是错误 —— 已经在盯了，再"启动"一次只会推重复内容）。
 * @returns {{reused: boolean, state: object|null}}
 */
function attachToExisting(taskId) {
  const existing = monitorStates.get(taskId)
  if (existing) return { reused: true, state: existing }
  return { reused: false, state: null }
}

export class MonitorTool extends Tool {
  /**
   * @param {{pushSteering?: () => ((text: string) => void) | null}} opts
   *   pushSteering 返回真正的推送函数（agent.pushSteering）。缺省 = 降级模式。
   */
  constructor({ pushSteering = null } = {}) {
    super({
      name: 'Monitor',
      description: '启动一个后台命令并把它的 stdout/stderr **逐行实时推送**给你（不等你轮询）。'
        + '适合盯日志文件、进程输出、构建输出：出现匹配行的那一刻就会注入一条 <task_notification>。'
        + '与 BashOutput 的分工：Monitor 是推式（事件发生时即通知），BashOutput 是轮询（你要主动调）。'
        + '上限：单批最多 10 行、累计最多 1000 行，超限后自动停止推送并提示改用 BashOutput 手动读。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要监控的命令（在 shell 里执行）。盯已有后台任务时可省略，改传 task_id' },
          task_id: { type: 'string', description: '可选：盯一个已存在的 Bash 后台任务（不给 command 时必填）。已在监控中的任务会返回当前进度，不会重复推送' },
          pattern: { type: 'string', description: '可选：只推送匹配该正则的行，如 "ERROR|FATAL"' },
          tail_lines: { type: 'number', description: '可选：启动时跳过前 N 行不推送（默认 0，即全推）' },
          timeout: { type: 'number', description: '可选：命令运行多少 ms 后自动 kill（默认 0 = 不限）' },
        },
        required: ['command'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
    })
    this.getPush = pushSteering
  }

  async execute(input) {
    const command = String(input.command || '').trim()
    const taskId = input.task_id ? String(input.task_id).trim() : null
    if (!command && !taskId) return '缺少参数：要给新命令加监控请传 command；要盯已有后台任务请传 task_id'
    const tailLines = clampInt(input.tail_lines, 0, 10000, 0)
    const timeout = clampInt(input.timeout, 0, 24 * 3600 * 1000, 0)
    const pattern = input.pattern ? String(input.pattern) : null

    const push = (() => {
      try { return this.getPush?.() || null } catch { return null }
    })()

    // 坑 1（去重）：给了 task_id 且该 task 已在被 monitor → 复用，不重推
    if (taskId) {
      const { reused, state } = attachToExisting(taskId)
      if (reused) {
        return [
          `该任务已在监控中：task_id=${taskId}`,
          `  已推送到第 ${state.lineNo} 行（累计推送 ${state.pushedTotal} 行）`,
          state.stopped
            ? `  已达上限，推送已停止；用 BashOutput(task_id="${taskId}") 读全量`
            : `  继续推送中，无需重复启动。`,
        ].join('\n')
      }
    }

    let task
    if (command) {
      try {
        task = startBackgroundBash(command, { timeout, cwd: this.ctx?.cwd || process.cwd() })
      } catch (e) {
        return `Monitor 启动失败：${e.message}`
      }
    } else {
      task = getBackgroundTask(taskId)
      if (!task) return `未找到后台任务 ${taskId}。用 Bash(run_in_background:true) 启动，或直接给 command 让 Monitor 启动。`
      if (task.type !== 'local_bash') return `任务 ${taskId} 类型是 ${task.type}，不是 Bash 后台命令。`
    }

    let state
    try {
      state = monitorTask(task, { pattern, tailLines, push }).state
    } catch (e) {
      return `Monitor 挂载失败：${e.message}`
    }
    if (state.badPattern) {
      return `Monitor 已启动（task_id=${task.taskId}），但 pattern 正则无效：${state.badPattern}\n` +
        `本次不过滤，全部推送。要过滤请用合法正则重新 Monitor。`
    }

    const lines = [
      `Monitor 已启动：task_id=${task.taskId}`,
      `  command: ${command ? command.slice(0, 120) : task.description}`,
    ]
    if (pattern) lines.push(`  pattern: ${pattern}`)
    if (tailLines > 0) lines.push(`  tail_lines: ${tailLines}（前 ${tailLines} 行不推送）`)
    if (push) {
      lines.push('推送模式：stdout/stderr 每出一行（或匹配 pattern 的行）就会作为 <task_notification> 注入。')
      lines.push(`上限：单批 ${MAX_LINES_PER_PUSH} 行 / 累计 ${MAX_TOTAL_LINES} 行，到顶自动停止并提示。`)
    } else {
      lines.push('降级模式：当前环境没有注入通道，输出只累积不推送。')
      lines.push(`请用 BashOutput(task_id="${task.taskId}") 增量读（不会重复读同一段），KillShell 终止。`)
    }
    lines.push('任务退出时会自动推送一条结束通知。')
    return lines.join('\n')
  }
}

/** 测试/诊断用：当前活着的监控句柄 */
export function listMonitors() {
  return [...monitorStates.values()].map(s => ({
    taskId: s.taskId, command: s.command, pattern: s.pattern,
    lineNo: s.lineNo, pushedTotal: s.pushedTotal, consumed: s.consumed, stopped: s.stopped,
    hasPush: !!s.push,
  }))
}

export const MONITOR_LIMITS = { MAX_LINES_PER_PUSH, MAX_TOTAL_LINES, MAX_LINE_CHARS, MAX_PUSH_CHARS }
