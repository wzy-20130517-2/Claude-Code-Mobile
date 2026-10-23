// 定时任务工具（仿官方 ScheduleCronTool）：CronCreate / CronList / CronDelete
import { Tool } from './tools.mjs'
import { addCronTask, deleteCronTask, listCronTasks, computeNextCronRun, cronToHuman } from '../infra/cron.mjs'

export class CronCreateTool extends Tool {
  constructor() {
    super({
      name: 'CronCreate',
      description: '创建一个定时任务：到点自动执行一段 prompt。cron 用标准5字段（分 时 日 月 周），如 "0 9 * * *" 每天9点、"*/5 * * * *" 每5分钟。'
        + 'recurring 默认 true（每次匹配都触发，直到删除）；要只触发一次就显式传 recurring:false。'
        + 'durable=true 写盘持久（CLI重启后还在；只有用户明确说每天/长期才用，否则默认session级，退出即消失）。',
      input_schema: {
        type: 'object',
        properties: {
          cron: {
            type: 'string',
            description: '标准5字段 cron 表达式（本地时间）："分 时 日 月 周"。例："*/5 * * * *"=每5分钟；"30 14 28 2 *"=2月28日14:30 一次。'
          },
          prompt: { type: 'string', description: '每次触发时要执行的 prompt。' },
          recurring: {
            type: 'boolean',
            description: '默认 true = 每次 cron 匹配都触发，直到删除或过期。false = 只在下一个匹配点触发一次，然后自动删除。'
          },
          durable: { type: 'boolean', description: '是否持久化，默认false（session级）' },
        },
        required: ['cron', 'prompt'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      // 官方元数据（claude.js:1005736）：enablesCodeExecution / backgrounding:"never"
      searchHint: 'schedule a recurring or one-shot prompt',
      backgrounding: 'never',
    })
  }
  async execute(input) {
    try {
      // recurring 缺省为 true（官方语义）；只有显式传 false 才是一次性任务。
      // 这里不能写 !!input.recurring —— 那样缺省值变成 false，与官方相反。
      const recurring = input.recurring === undefined ? true : !!input.recurring
      const t = addCronTask({ cron: input.cron, prompt: input.prompt, recurring, durable: !!input.durable })
      const where = t.durable ? '已持久化（重启后还在）' : 'session级（退出即消失）'
      const kind = t.recurring ? `循环任务，每次触发后重算下次` : `一次性任务，触发后自动删除`
      return `已创建定时任务 ${t.id}（${t.human}）。${where}。${kind}。下次触发：${new Date(t.nextRun).toLocaleString('zh-CN')}。用 CronDelete 取消。`
    } catch (e) {
      return `创建失败：${e.message}`
    }
  }
}

export class CronListTool extends Tool {
  constructor() {
    super({
      name: 'CronList',
      description: '列出所有定时任务（含下次触发时间）。',
      input_schema: { type: 'object', properties: {} },
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      searchHint: 'List scheduled cron jobs',
    })
  }
  async execute() {
    const tasks = listCronTasks()
    if (!tasks.length) return '暂无定时任务'
    const lines = tasks.map(t => {
      const next = computeNextCronRun(t.cron, t.recurring ? (t.lastFiredAt ?? t.createdAt) : t.createdAt)
      return `- ${t.id} [${t.recurring ? '循环' : '一次'}|${t.durable ? '持久' : 'session'}] ${cronToHuman(t.cron)} → 下次 ${next ? new Date(next).toLocaleString('zh-CN') : '无'}\n  ${String(t.prompt).slice(0, 80)}`
    })
    return lines.join('\n')
  }
}

export class CronDeleteTool extends Tool {
  constructor() {
    super({
      name: 'CronDelete',
      description: '删除一个定时任务。',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务ID（CronList里看）' } },
        required: ['id'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      searchHint: 'Cancel a scheduled cron job by ID',
    })
  }
  async execute(input) {
    if (!input.id) return '缺少 id：请提供任务ID（CronList里看）'
    const ok = deleteCronTask(String(input.id))
    return ok ? `已删除 ${input.id}` : `找不到任务 ${input.id}`
  }
}

/** 最短唤醒间隔：低于 30 秒不如在本轮直接等（还省一次 API 往返）。 */
const MIN_WAKEUP_SECONDS = 30
/** 最长 24 小时：再长用户多半是想用 cron，而不是睡一天。 */
const MAX_WAKEUP_SECONDS = 86400

/**
 * ScheduleWakeup —— 让 Agent 自己给自己排一次唤醒。
 *
 * 对应官方 Claude Code 2.1.x 的 ScheduleWakeup（`claude.js` 里 `str2149` 同级的工具）。
 *
 * 【它解决什么问题】
 * CCM 原来的「等一会儿再继续」只有两条路，都不适合手机：
 *   · `EnterWatch` —— agent 内 while 循环，**一直占着进程**。手机端表现为
 *     屏幕常亮、CPU 一直跑、电池一直耗，20 分钟能掉十几个点。
 *   · 用户手动再发一条 —— 得人守着。
 *
 * ScheduleWakeup 是第三种：**结束本轮、释放进程、到点由 runtime 重新注入 prompt**。
 * 睡着的这段时间 CLI 可以做别的事，也可以什么都不做。
 *
 * 【与 CronCreate 的分工】
 *   CronCreate：按 cron 表达式周期触发（"每天9点"、"每5分钟"），适合固定节奏
 *   ScheduleWakeup：一次性、相对时间（"20 分钟后"），适合「等构建完/等限流恢复」
 *
 * 底层复用同一套调度器（`core/infra/cron.mjs`），只是走 `atMs` 绝对时刻路径。
 */
export class ScheduleWakeupTool extends Tool {
  constructor({ getAgent = null } = {}) {
    super({
      name: 'ScheduleWakeup',
      description:
        '给自己排一次唤醒：结束本轮、释放进程，到点后 runtime 会带着 prompt 重新唤醒你。\n' +
        '适用于「等一会儿再继续」——等构建完成、等限流窗口恢复、等外部状态变化。\n' +
        '**优于 EnterWatch**：watch 是 agent 内循环，一直占着进程（手机端屏幕常亮、CPU 空转、电池狂掉）；\n' +
        'ScheduleWakeup 睡着的这段时间进程是空闲的。\n' +
        '与 CronCreate 的分工：要「每天9点」这种固定节奏用 CronCreate；要「20 分钟后叫醒我」用这个。',
      input_schema: {
        type: 'object',
        properties: {
          delay_seconds: {
            type: 'number',
            description: '多少秒后唤醒。最短 30 秒（更短的话不如直接等），最长 24 小时（86400）。',
          },
          prompt: {
            type: 'string',
            description: '醒来时要执行的 prompt。要自包含——那时的你只记得这段文字，不记得现在在想什么。',
          },
          reason: {
            type: 'string',
            description: '可选：为什么定这个时间。会拼进唤醒 prompt 的第一行（「（定时唤醒｜原因：xxx）」），'
              + '醒来时模型自己能看到，不会被单独存成字段。',
          },
        },
        required: ['delay_seconds', 'prompt'],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      searchHint: 'sleep then wake me up later with a prompt',
      backgrounding: 'never',
      maxResultSizeChars: 2000,
      validateInput: (input) => {
        const errors = []
        const d = Number(input.delay_seconds)
        if (!Number.isFinite(d)) errors.push('delay_seconds 必须是数字')
        else if (d < MIN_WAKEUP_SECONDS) errors.push(`delay_seconds 不能小于 ${MIN_WAKEUP_SECONDS} 秒（更短请直接等）`)
        else if (d > MAX_WAKEUP_SECONDS) errors.push(`delay_seconds 不能超过 ${MAX_WAKEUP_SECONDS} 秒（24 小时）`)
        if (!input.prompt || !String(input.prompt).trim()) errors.push('prompt 不能为空')
        return { valid: errors.length === 0, errors }
      },
    })
    // 用来置位 agent._wakeupScheduled —— 让主循环本轮结束、释放进程。
    // 拿不到实例时不置位：任务照样排定，只是本轮不会提前退出（退化成 CronCreate 的行为），
    // 比整个工具报错好。
    this.getAgent = getAgent
  }

  async execute(input) {
    const seconds = Math.round(Number(input.delay_seconds))
    const at = Date.now() + seconds * 1000
    const reason = input.reason ? String(input.reason).trim() : ''
    // reason 拼进 prompt 的第一行，这样醒来时能看到「当初为什么定这个时间」。
    // 不单独存字段：cron 任务结构里没有 reason，加字段要改存储格式和面板。
    const prompt = reason
      ? `（定时唤醒｜原因：${reason}）\n${String(input.prompt)}`
      : String(input.prompt)
    try {
      const t = addCronTask({ cron: '', prompt, recurring: false, durable: false, atMs: at })
      // 置位让主循环在本轮无工具调用时结束 —— 这是它与 CronCreate 的本质区别：
      // CronCreate 只排任务、本轮继续跑；ScheduleWakeup 排完就收工。
      try { const a = this.getAgent?.(); if (a) a._wakeupScheduled = true } catch {}
      return `已排定 ${t.human}唤醒（任务 ${t.id}）。本轮结束后会释放进程，到点 runtime 带着 prompt 重新唤醒你。\n`
        + `要取消用 CronDelete({id:"${t.id}"})。`
    } catch (e) {
      return `排定失败：${e.message}`
    }
  }
}
