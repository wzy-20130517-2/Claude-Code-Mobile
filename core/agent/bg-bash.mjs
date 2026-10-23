// 后台 Bash：run_in_background + BashOutput + KillShell（对标原版 Claude Code）
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, openSync, closeSync, statSync, readSync } from 'node:fs'
import { Tool } from '../tools/tools.mjs'
import { maybeBackupRm } from '../session/trash.mjs'
import { trackChild } from '../infra/pty.mjs'
import {
  registerBackgroundTask,
  getBackgroundTask,
  listBackgroundTasks,
  killBackgroundTask,
} from './bg-tasks.mjs'

const MAX_OUTPUT_CHARS = 200_000
// shell 路径自适应（Termux / proot Ubuntu 都能用）
// 逻辑见 core/shell-path.mjs，这里包一层保持调用点不变
import { getShellPath } from '../infra/shell-path.mjs'
function shellPath() {
  return getShellPath()
}

// 导出给 Monitor 工具复用（tools-monitor.mjs）：同一个后台任务管理体系，
// 不另起一套 spawn。改这里的副作用都会同时影响 Monitor。
export function startBackgroundBash(command, { timeout = 0, cwd = process.cwd() } = {}) {
  const task = registerBackgroundTask('local_bash', command.slice(0, 80))
  task.start()

  const { command: cmd } = maybeBackupRm(command, cwd)
  const proc = spawn(cmd, [], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: shellPath(),
  })
  task.proc = proc
  trackChild(proc)

  const append = (chunk) => {
    task.appendOutput(chunk.toString())
    // 只裁剪内存副本，不再递归 appendOutput（原写法会无限增长/重复写盘）
    if (task.output.length > MAX_OUTPUT_CHARS) {
      task.output = '…[earlier output truncated]…\n' + task.output.slice(-MAX_OUTPUT_CHARS)
      if (task.outputOffset > task.output.length) task.outputOffset = 0
    }
  }
  proc.stdout.on('data', append)
  proc.stderr.on('data', append)

  // 推式通道（Monitor 工具用）：stdout/stderr 的每个 chunk 同时喂给所有 sink。
  // sink 由 attachOutputSink 挂上，负责按行切分 + 去重 + 上限。
  // stdout 与 stderr 分别挂而不是合成一个流：两份流交错到达时，
  // 合成流会在行边界出现错位的半行，按行切分会把一行拆成两半。
  // 用 Set 而不是单个变量：多个消费者（两个 Monitor、或 Monitor + 别的观察者）
  // 要能同时收，后挂的不能把先挂的顶掉 —— 那正是「重复调用 Monitor 就静默丢推送」的坑。
  const sinks = new Set()
  proc.stdout.on('data', (chunk) => { const s = String(chunk); for (const fn of sinks) { try { fn(s) } catch {} } })
  proc.stderr.on('data', (chunk) => { const s = String(chunk); for (const fn of sinks) { try { fn(s) } catch {} } })

  let timer = null
  if (timeout && timeout > 0) {
    timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      if (!task.isTerminal()) {
        task.appendOutput(`\n(超时 ${timeout}ms，已 kill)\n`)
        task.fail(`timeout ${timeout}ms`)
      }
    }, timeout)
    if (typeof timer.unref === 'function') timer.unref()
  }

  proc.on('close', (code) => {
    if (timer) clearTimeout(timer)
    if (task.isTerminal()) return
    task.exitCode = code
    task.complete({ exitCode: code, output_len: task.output.length })
    // 进程退出：通知 sink flush 尾部半行。放在 complete 之后 ——
    // sink 触发时 task 已是终态，工具据此发「任务已结束」通知。
    if (task._closeListeners) {
      const ls = task._closeListeners; task._closeListeners = []
      for (const cb of ls) { try { cb() } catch {} }
    }
  })
  proc.on('error', (e) => {
    if (timer) clearTimeout(timer)
    if (!task.isTerminal()) task.fail(e.message)
    if (task._closeListeners) {
      const ls = task._closeListeners; task._closeListeners = []
      for (const cb of ls) { try { cb() } catch {} }
    }
  })

  // 推式通道出口：Monitor 工具经 attachOutputSink 挂消费者。
  // 做成 task 上的 setter 而不是让 Monitor 自己去 proc 上挂 data 监听：
  // 那样 Monitor 会与 append 抢同一个流，且拿不到「进程已退出」的时序。
  task._setOutputSink = (fn) => {
    if (typeof fn !== 'function') {
      // 传 null = 摘除全部（任务收尾时用）
      sinks.clear()
      return
    }
    sinks.add(fn)
    // 进程已退出时不会再触发 data —— 立刻 flush 一次让 sink 吐掉残留半行
    if (task.isTerminal()) { try { fn('') } catch {} }
  }

  return task
}

/**
 * 给后台任务挂一个「输出 sink」：stdout/stderr 的每个 chunk 都会喂给它。
 * @returns {boolean} 挂上返回 true；任务不存在或不是 startBackgroundBash 起的返回 false
 */
export function attachOutputSink(task, fn) {
  if (!task || typeof task._setOutputSink !== 'function') return false
  task._setOutputSink(fn)
  return true
}

/**
 * 注册进程退出回调（Monitor 用来 flush 尾部半行 + 发终止通知）。
 * 已在终态则立即同步触发一次。
 */
export function onBackgroundTaskClose(task, cb) {
  if (!task) return false
  if (task.isTerminal()) { try { cb() } catch {}; return true }
  task._closeListeners = task._closeListeners || []
  task._closeListeners.push(cb)
  return true
}

/** 给 PTYBashTool 注入：支持 run_in_background
 *  （2026-09-26：原 confirm_dangerous 机制已删，后台模式同样不再做高危判定。）*/
export function runBashMaybeBackground(input, ctx = {}) {
  if (input.run_in_background) {
    const task = startBackgroundBash(input.command, { timeout: input.timeout || 0, cwd: ctx.cwd || process.cwd() })
    return [
      `后台 Bash 已启动`,
      `  task_id: ${task.taskId}`,
      `  command: ${input.command.slice(0, 120)}`,
      `用 BashOutput(task_id="${task.taskId}") 读输出；KillShell 终止。`,
    ].join('\n')
  }
  return null // 调用方走同步路径
}

export class BashOutputTool extends Tool {
  constructor() {
    super({
      name: 'BashOutput',
      description: '读取后台 Bash 任务的输出（增量）。配合 Bash(run_in_background:true) 使用。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台任务 id' },
          timeout: { type: 'number', description: '可选：最多等待多少 ms 再返回（等有新输出或结束）' },
        },
        required: ['task_id'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    })
  }
  async execute(input) {
    const task = getBackgroundTask(input.task_id)
    if (!task) {
      const list = listBackgroundTasks().filter(t => t.type === 'local_bash')
      return `未找到任务 ${input.task_id}。当前 bash 后台: ${list.length ? list.map(t => t.id).join(', ') : '(无)'}`
    }
    const waitMs = Math.min(Number(input.timeout) || 0, 30000)
    if (waitMs > 0 && !task.isTerminal() && task.outputOffset >= task.output.length) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, waitMs)
        const iv = setInterval(() => {
          if (task.isTerminal() || task.output.length > task.outputOffset) {
            clearInterval(iv); clearTimeout(t); resolve()
          }
        }, 100)
      })
    }
    const delta = task.getOutputDelta()
    const status = {
      task_id: task.taskId,
      status: task.status,
      exitCode: task.exitCode ?? task.result?.exitCode ?? null,
      duration_ms: task.startTime ? (task.endTime || Date.now()) - task.startTime : 0,
      total_output_len: task.output.length,
    }
    return JSON.stringify({ ...status, output: delta || '(no new output)' }, null, 2)
  }
}

export class KillShellTool extends Tool {
  constructor() {
    super({
      name: 'KillShell',
      description: '终止后台 Bash 任务。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
        },
        required: ['task_id'],
      },
      isDestructive: () => true,
    })
  }
  async execute(input) {
    const ok = killBackgroundTask(input.task_id)
    if (!ok) return `未找到或无法终止任务: ${input.task_id}`
    return `已终止任务 ${input.task_id}`
  }
}
