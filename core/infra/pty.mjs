// Claude Code Mobile - PTY 伪终端 + 进程树清理
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { getShellPath } from './shell-path.mjs'

const activeChildren = new Set()

export function trackChild(proc) {
  activeChildren.add(proc)
  proc.on('exit', () => { activeChildren.delete(proc) })
}

export function killAllChildren() {
  for (const proc of activeChildren) {
    try { proc.kill('SIGKILL') } catch {}
  }
  activeChildren.clear()
}

// 只注册一次 exit 清理，不要单独处理 SIGINT/SIGTERM
// 信号处理由 index.mjs 和 session-auto.mjs 统一协调
process.on('exit', killAllChildren)

export class PTYBox {
  constructor(command, args = [], options = {}) {
    this.command = command
    this.args = args
    this.cwd = options.cwd || process.cwd()
    this.env = options.env || {}
    this.timeout = options.timeout || 30000
    this.process = null
    this.output = ''
  }

  // signal: 外部取消（Agent 层超时或用户 Ctrl+C）—— abort 时立即 kill 子进程，
  // 避免只 reject 而子进程变孤儿继续在后台跑。
  async run({ signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve({ stdout: '', stderr: '', exitCode: -1, timedOut: false, cancelled: true })
        return
      }
      const proc = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: getShellPath(),
      })
      this.process = proc
      trackChild(proc)

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
        resolve({ stdout, stderr, exitCode: -1, timedOut: true })
      }, this.timeout)

      // 外部取消：真杀进程并带回已有输出，不丢失半截结果
      let abortListener = null
      if (signal) {
        abortListener = () => {
          clearTimeout(timer)
          try { proc.kill('SIGKILL') } catch {}
          resolve({ stdout, stderr, exitCode: -1, timedOut: false, cancelled: true })
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }
      const cleanup = () => {
        clearTimeout(timer)
        if (signal && abortListener) {
          try { signal.removeEventListener('abort', abortListener) } catch {}
        }
      }

      // 边收边回报：长命令（npm install、构建、测试）不该让用户干等，
      // onProgress 由 agent 注入，UI 侧只显示最后一行（对齐 Kimi 的 liveOutputTail）。
      proc.stdout.on('data', (data) => {
        const s = data.toString()
        stdout += s
        if (onProgress) { try { onProgress(s) } catch {} }
      })
      proc.stderr.on('data', (data) => {
        const s = data.toString()
        stderr += s
        // stderr 也报：很多工具（ffmpeg/npm）的进度就走 stderr
        if (onProgress) { try { onProgress(s) } catch {} }
      })
      proc.on('close', (code) => {
        cleanup()
        resolve({ stdout, stderr, exitCode: code, timedOut: false })
      })
      proc.on('error', (e) => { cleanup(); reject(e) })
    })
  }

  kill() {
    if (this.process) {
      try { this.process.kill('SIGKILL') } catch {}
      this.process = null
    }
  }
}

// 基于 PTY 的 Bash 工具
import { Tool } from '../tools/tools.mjs'
import { maybeBackupRm } from '../session/trash.mjs'

/**
 * Bash 超时的**唯一真值源**（schema description 里写的数字也以这里为准）。
 *
 * 三层关系，改任何一层前先读这段：
 *   · 模型传的 timeout —— 优先，受 MAX 约束
 *   · 本文件默认值      —— DEFAULT，未传时用
 *   · Agent 层 LONG     —— 600000（tool-timeout.mjs），外层兜底
 *
 * 为什么 DEFAULT 不取官方那 120000：官方内层 120s、外层 600s 是两套独立上限；
 * CCM 的 Agent 层对 Bash 直接给 600s。内层若只等 120s，`npm install`
 * 这类允许跑 10 分钟的命令会在 2 分钟被 SIGKILL —— 那是功能退化。
 *
 * 为什么比 Agent 层小 5000ms：两层同时到期会竞态。内层先到点，用户拿到的是
 * 「(超时) + 已产生的输出」；外层先到点，只剩 `Tool timeout (10min)`，半截
 * 输出全丢。留 5 秒余量确保前者总是赢。
 */
const BASH_DEFAULT_TIMEOUT_MS = 600_000
const BASH_MAX_TIMEOUT_MS = 600_000
const BASH_INNER_MARGIN_MS = 5_000

/** 解析最终使用的内层超时（毫秒）。0/负数 = 不超时（交给外层）。 */
function resolveBashTimeout(raw) {
  if (raw === 0) return 0                      // 显式 0 = 不设内层超时
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return BASH_DEFAULT_TIMEOUT_MS
  // 不能超过外层上限，否则内层永远等不到（外层先掐断，且丢掉半截输出）
  return Math.min(n, BASH_MAX_TIMEOUT_MS - BASH_INNER_MARGIN_MS)
}

export class PTYBashTool extends Tool {
  constructor() {
    super({
      name: 'Bash',
      description: '执行 shell 命令（基于 PTY，支持交互式命令）。设 run_in_background=true 可后台跑，再用 BashOutput/KillShell 管理。',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          // ── timeout：三处必须一致（2026-10-20 统一）──────────────────
          // 改之前的状态是个真 bug：description 写「默认 30000」，
          // 代码里 `input.timeout || 600000` 用的是 600000 —— 模型照提示
          // 以为 30 秒就超时，实际要等 10 分钟，判断全错。
          //
          // 【为什么默认不是官方那 120000】官方 Bash 的 Agent 层上限与内层默认
          // 是两个独立值（120000 / 600000）。CCM 的 Agent 层给 Bash 的是
          // tool-timeout.mjs 的 LONG = 600000，内层如果只等 120s，
          // `npm install`、全量测试这类本来允许跑 10 分钟的命令会在 2 分钟被
          // 内层 SIGKILL —— 外层的宽限等于白给，是功能退化，不是对齐。
          // 所以内层默认跟外层同档（600000），并比外层**略小 5s**：
          // 让内层先到点、返回带 `(超时)` 的清晰结果；否则两层同时到期，
          // 谁先触发不确定，外层赢了就只剩一句 `Tool timeout (10min)`。
          timeout: {
            type: 'number',
            description: `可选超时 ms。默认 ${BASH_DEFAULT_TIMEOUT_MS}（${BASH_DEFAULT_TIMEOUT_MS / 60000} 分钟），`
              + `上限 ${BASH_MAX_TIMEOUT_MS}；后台模式 0=不超时。`
              + '简单命令无需传，跑构建/全量测试等长任务时才需要显式调大。',
          },
          run_in_background: {
            type: 'boolean',
            description: '后台执行，立即返回 task_id。'
              + '配合 timeout 使用时，timeout 限制的是「命令在后台最长可运行多久」而不是「等多久返回」。'
              + '之后用 BashOutput 读增量输出、KillShell 终止。',
          },
          // ── 对齐官方 Claude Code 2.1.303 新增的 description ──
          // 官方用它做「用户能看懂的一句话说明」，渲染层显示在人读的那一行，
          // 而不是把 command 原文怼给用户。CCM 之前没这个字段，模型只能靠
          // command 猜意图。接受但只在 UI 侧用，不影响执行。
          description: {
            type: 'string',
            description: '一句话说明这条命令在做什么（给用户看，不是给 shell 看）。写「列出当前目录文件」而不是复述命令原文；复杂管道命令尤其需要写清楚目的，如「找到并删除所有 .tmp 文件」。',
          },
          // ── 对齐官方 2.1.303：网络沙箱白名单 ──
          // 官方语义：沙箱化的命令默认拒绝所有网络，这个列表声明「本次命令需要
          // 访问哪些主机」。CCM 跑在 Termux/Android 上，**没有命令级网络沙箱**
          //（Bash 就是直接 spawn 一个 PTY，没有 seccomp/网络命名空间可用），
          // 所以这里只能做兼容解析：接受参数、不报错、也不假装拦了。
          // 为什么要收而不是直接拒：跨端 prompt 里可能带着这个字段，硬拒会让
          // 整次调用失败（工具参数校验失败 → 模型以为命令跑不了）。
          // 若真要限制网络，用 allowed_domains 之外的机制（/permissions deny Bash）。
          allowed_domains: {
            type: 'array',
            items: { type: 'string' },
            description: '（官方网络沙箱字段，CCM 无沙箱，接受但不生效）声明这条命令需要访问的主机白名单。本机 Bash 不做网络隔离，传了也不会限制；要真正禁网请用 /permissions 的 deny 规则。',
          },
          // ── 对齐官方 2.1.303：_host（多机附挂）──
          // 官方用于「把这次调用转发到另一台已附挂的机器」。CCM 是单机
          //（Termux 本机 / proot），没有附挂机器的概念，所以只做解析：
          // 留空或写本机标识 = 正常执行；写了别的机器名 = 明确告知不支持，
          // 而不是静默在本机执行（那会让模型以为命令跑在目标机器上）。
          _host: {
            type: 'string',
            description: '（多机附挂字段，CCM 单机）指定这次调用在哪台附挂机器上执行。本机只有 "this-machine"，省略或填它即在本机执行；填其他名字会被拒绝并说明。',
          },
          // ── 对齐官方 2.1.303：dangerouslyDisableSandbox ──
          // 官方语义：默认在沙箱里跑，传 true 才允许命令逃出沙箱（写系统目录等）。
          // CCM **本来就没有沙箱**（Termux 里 Bash 就是直接 spawn PTY，
          // 没有 seccomp / 命名空间可用），所有命令天然是全权限的。
          // 所以这个字段是纯粹的兼容位：接受、不报错、不改变行为。
          // 为什么不直接拒绝：跨端 prompt / 别的 harness 生成的调用里会带它，
          // 硬拒会让整次工具调用失败，模型以为命令跑不了。
          dangerouslyDisableSandbox: {
            type: 'boolean',
            description: '（官方沙箱字段，CCM 无沙箱）本机命令本来就无沙箱限制，此字段接受但不改变行为。',
          },
          // ── 对齐官方 2.1.303：_simulatedSedEdit ──
          // 官方用于「在用户确认前预演 sed 编辑结果」。CCM 没有审批预演流程
          // （权限自动通过），接受并忽略。
          _simulatedSedEdit: {
            type: 'object',
            description: '（官方预演字段，CCM 无审批预演）接受但不生效。',
          },
        },
        required: ['command'],
      },
    })
  }

  // 供 Agent 层超时/中断时主动调用，双保险干掉子进程
  cancel() {
    try { this._activePty?.kill() } catch {}
    this._activePty = null
  }

  async execute(input, ctx = {}) {
    // 【_host 兼容解析】官方 2.1.303 支持「把这次 Bash 调用转发到另一台已附挂的机器」。
    // CCM 是单机（Termux 本机 / proot），没有附挂机器。这里必须显式区分两种情况：
    //   · 省略 / 空串 / "this-machine" → 就在本机执行（默认行为，模型可以放心省略）
    //   · 其它值 → 直接拒绝，**不能静默在本机跑**
    // 为什么不能静默：模型以为命令跑在目标机器上，实际动的是本机文件，
    // 这种「结果看起来正常、实际改错了地方」的错误最难查，宁可当场报错。
    const host = typeof input._host === 'string' ? input._host.trim() : ''
    if (host && host !== 'this-machine' && host !== 'container') {
      // 用 String 包装 + __ok=false，与正常返回同一形状：渲染层按 __ok 判成败，
      // 纯字符串会让它退回「按输出文本猜」的老路（见下面 withStatus 的注释）。
      const s = new String(
        `未执行：_host="${host}" 指定了另一台附挂机器，但 CCM 运行在单机上（只有 "this-machine"）。\n`
        + `请省略 _host 在本机执行；如果这条命令本该在别的机器上跑，本机无法代劳。`
      )
      s.__ok = false
      s.__hostRejected = true
      return s
    }

    // 后台模式
    if (input.run_in_background) {
      const { runBashMaybeBackground } = await import('../agent/bg-bash.mjs')
      return runBashMaybeBackground(input, ctx)
    }

    // 拦截 rm 命令，备份要删的文件到回收站
    //
    // cwd 保护：engine 传的工作区路径可能还没创建（首次运行 / 用户删了目录），
    // 直接 spawn 会 ENOENT。退回到进程当前目录（在 CCM 里是内核目录，一定存在）。
    let cwd = ctx?.cwd || process.cwd()
    try {
      if (!existsSync(cwd)) {
        // 尝试创建（工作区本该存在，缺了多半是首次）
        mkdirSync(cwd, { recursive: true })
      }
    } catch {
      cwd = process.cwd()
    }
    const { command, backed } = maybeBackupRm(input.command, cwd)
    // 回收站备份信息不能直写 stderr：全屏模式下输入框画在固定位置，
    // 绕过渲染层的输出会怼到输入框那一行（用户反馈「[回收站] 跑输入框那里」）。
    // 并进工具返回值，作为正常工具结果走渲染层。
    const trashNote = backed.length
      ? backed.map(b => `  [回收站] ${b}`).join('\n') + '\n'
      : ''
    // 内层超时与 Agent 层分级超时保持一致：用户显式 timeout 优先。
    //
    // 【数值统一于 2026-10-20】改之前 description 说默认 30000、代码用 600000，
    // 模型按提示估算时间，实际行为差 20 倍。现在三处（schema description /
    // 这里的默认值 / BASH_DEFAULT_TIMEOUT_MS 常量）共用同一个来源。
    //
    // 为什么内层比 Agent 层（LONG=600000）小 5 秒：见 schema 里 timeout 的注释。
    // 一句话 —— 让内层先超时，用户看到的是「(超时) + 已有输出」，
    // 而不是一句干巴巴的 `Tool timeout (10min)`。
    this._activePty = new PTYBox(command, [], {
      timeout: resolveBashTimeout(input.timeout),
      cwd,
    })
    const result = await this._activePty.run({ signal: ctx?.signal, onProgress: ctx?.onProgress })
    this._activePty = null

    // 用 String 包装对象带出真实成败：模型侧仍拿到纯文本（toString），
    // 渲染层可读 __ok/__exitCode。不这么做的话下游只能按输出文本猜，
    // 于是 grep 到一行 `throw new Error(...)` 就被误判成命令失败（踩过）。
    const withStatus = (text, ok, extra = {}) => {
      const s = new String(trashNote + text)
      s.__ok = ok
      s.__exitCode = result.exitCode
      Object.assign(s, extra)
      return s
    }

    if (result.cancelled) {
      return withStatus(`(已取消，子进程已终止) ${result.stdout}${result.stderr ? `\nstderr:\n${result.stderr}` : ''}`, false, { __cancelled: true })
    }
    if (result.timedOut) {
      return withStatus(`(超时) ${result.stdout}\n${result.stderr}`, false, { __timedOut: true })
    }
    const output = result.stdout + (result.stderr ? `\nstderr:\n${result.stderr}` : '')
    return withStatus(output || '(no output)', result.exitCode === 0)
  }
}
