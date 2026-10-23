// Agent 侧后台子 Agent 观察工具：不依赖 BashOutput 或用户手动 slash。
import { Tool } from './tools.mjs'
import { getBackgroundTaskStatus, listBackgroundTasksGc as listBackgroundTasks, killBackgroundTask, findTaskByName } from '../agent/bg-tasks.mjs'
import { listTraces, formatTraceList } from '../api/trace.mjs'
import { getRefusedRecords } from '../agent/plan.mjs'

const STATUS_ICON = {
  pending: '○ 排队中', running: '→ 运行中',
  completed: '✓ 已完成', failed: '✗ 失败', killed: '⊘ 已中止',
}

/**
 * 非子 Agent 的后台任务（Bash 后台命令、cron 等）的统一视图。
 *
 * 为什么不直接回「去用 BashOutput」：调用方在拿到一个 task_id 时，未必知道
 * 它是哪种类型。让它先猜类型、再选工具，等于把一次查询拆成两步，还容易选错
 *（官方 Claude Code 2.1.x 删掉 TaskOutput、统一成 GetTask 就是这个理由）。
 * 这里给出共同字段（状态/耗时/输出尾部），再提示该用哪个专用工具做深入操作。
 */
function formatNonAgentTask(id, task) {
  const label = STATUS_ICON[task.status] || task.status
  const bits = [label]
  if (task.duration_human) bits.push(task.duration_human)
  if (task.turns > 0) bits.push(`${task.turns} turns`)

  const lines = [
    `后台任务 ${id} [${task.type}]`,
    `  ${bits.join(' · ')}`,
  ]
  if (task.description) lines.push(`  任务: ${task.description}`)
  if (task.status === 'failed' || task.status === 'killed') {
    lines.push(`\n【${task.status === 'failed' ? '失败原因' : '中止原因'}】\n${task.error || '(未记录原因)'}`)
  }
  if (task.output_preview) {
    lines.push(`\n输出尾部:\n${task.output_preview}`)
  }

  // 按类型给下一步的正确工具 —— 但不强制，因为上面的信息已经够回答
  // 「它跑完了吗」这个最常见的问题。
  const hint = task.type === 'bash'
    ? '看完整输出用 BashOutput({task_id})，终止用 KillShell({task_id})。'
    : '终止用 AgentStop({task_id})（子 Agent）或对应工具的 stop 操作。'
  lines.push(`\n${hint}`)
  return lines.join('\n')
}

function formatTask(id, task, detail = false) {
  const label = STATUS_ICON[task.status] || task.status
  const bits = [label, task.duration_human]
  // turns 现在是实时值。0 轮且已跑了一会儿 = 还在等第一次模型响应，
  // 不是卡死；写清楚免得又误判（上次就因为恒显示 0 以为郡守挂了）。
  if (task.turns > 0) bits.push(`${task.turns} turns`)
  else if (task.status === 'running') bits.push('尚未完成首轮')
  if (task.messages) bits.push(`${task.messages} 条上下文`)

  const nameTag = task.agentName ? `「${task.agentName}」` : ''
  const typeTag = task.agentType ? ` [${task.agentType}]` : ''
  const head = `子 Agent ${id}${nameTag}${typeTag}\n  ${bits.join(' · ')}\n  任务: ${task.description || '(无描述)'}`

  if (!detail) return head

  const parts = [head]
  // 失败/中止时把原因摆在最前面：这是唯一需要立刻看到的东西
  if (task.status === 'failed' || task.status === 'killed') {
    parts.push(`\n【${task.status === 'failed' ? '失败原因' : '中止原因'}】\n${task.error || task.result_preview || '(未记录原因)'}`)
  }
  parts.push(`\n最近输出:\n${task.output_preview || '(暂无输出)'}`)
  if (task.status === 'completed') {
    parts.push(`\n最终结果:\n${task.result_preview || '(空)'}`)
  } else if (task.status === 'running' || task.status === 'pending') {
    parts.push(`\n(仍在运行，尚无最终结果)`)
  }
  // 按状态给出下一步该干什么，而不是让调用方自己猜
  const advice = {
    running: '仍在跑。别急着重复查询——隔一段时间再看，或用 AgentStop 中止它。',
    pending: '排队中（可能撞上并发上限）。等前面的完成即可。',
    failed: '已失败。若给过 agent_name，可用 SendMessage(to:该名, wake:true) 唤醒它带上下文重试。',
    killed: '已被中止。同样可用 SendMessage(wake:true) 唤醒重来。',
    completed: '已完成。要它返工/补做，用 SendMessage(to:agent_name, wake:true) 而不是重新 spawn。',
  }[task.status]
  if (advice) parts.push(`\n→ ${advice}`)
  return parts.join('\n')
}

export class AgentStatusTool extends Tool {
  constructor() {
    super({
      name: 'AgentStatus',
      description: '查看由 Agent 工具启动的后台子 Agent 状态、耗时、turn、最近输出和最终结果。不要用 BashOutput 轮询子 Agent；子 Agent 完成与否以这里的状态为准。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '可选。指定后台子 Agent task_id；省略则列出全部子 Agent。' },
          include_traces: { type: 'boolean', description: '是否附带最近 Agent trace 摘要；默认 false。', default: false }
        },
        required: []
      }
    })
  }

  async execute(input = {}) {
    const traces = input.include_traces ? `\n\n${formatTraceList(listTraces({ limit: 5 }))}` : ''
    const id = String(input.task_id || '').trim()

    if (id) {
      const task = getBackgroundTaskStatus(id)
      // 【区分两种失败】原来 !task 和 type 不符共用一句"未找到"，
      // 调用方分不清是 id 打错了还是查错了工具，只能瞎试。
      if (!task) {
        const all = listBackgroundTasks()
        const avail = all.map(t => `${t.id}(${t.type}/${t.status})`).join(', ')
        return `没有 task_id = ${id} 的后台任务。\n`
          + (avail ? `当前后台任务: ${avail}` : '当前没有任何后台任务。')
          + `\n提示：task_id 来自 Agent / Bash(run_in_background) 的返回值；不带参数调用 AgentStatus 可列出全部。`
      }
      // 【2026-10-20 改】原来非 local_agent 一律回「不是子 Agent，去用 BashOutput」，
      // 等于把「查任务」这件事劈成两半：调用方得先知道类型才能选工具。
      // 官方 Claude Code 2.1.x 把 TaskOutput 删掉、统一成 GetTask，正是这个理由。
      // 现在这里直接给出统一视图：任何类型的后台任务都能查，只是输出详略不同。
      if (task.type !== 'local_agent') {
        return formatNonAgentTask(id, task)
      }
      return formatTask(id, task, true) + traces
    }

    const tasks = listBackgroundTasks()
      .map(t => ({ id: t.id, detail: getBackgroundTaskStatus(t.id) }))
      .filter(t => t.detail)
    if (!tasks.length) {
      return '暂无后台任务。\n（用 Agent 工具并设 run_in_background:true 产生后台子 Agent；Bash 设 run_in_background:true 产生后台命令。）'
    }
    // 按状态归组统计，一眼看出还剩几个在跑
    const tally = {}
    const byType = {}
    for (const { detail } of tasks) {
      tally[detail.status] = (tally[detail.status] || 0) + 1
      byType[detail.type] = (byType[detail.type] || 0) + 1
    }
    const summary = Object.entries(tally).map(([s, n]) => `${STATUS_ICON[s] || s}×${n}`).join(' · ')
    const typeSummary = Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(' · ')
    const body = tasks.map(({ id: taskId, detail }) =>
      detail.type === 'local_agent'
        ? formatTask(taskId, detail, false)
        : formatNonAgentTask(taskId, detail)).join('\n\n')
    const running = tally.running || tally.pending
    // 【超限拒绝记录】对齐官方 recordRefused：并发/深度超限只回给模型的话，
    // 排查「为什么这个任务没派出去」时完全看不到（trace 里没有、状态栏没有）。
    // 这里把它摊在列表末尾 —— 有记录才显示，正常情况不占地方。
    const refused = (() => {
      try { return getRefusedRecords() } catch { return [] }
    })()
    const refusedLine = refused.length
      ? `\n\n⚠ 本次会话有 ${refused.length} 次 spawn 被拒：`
        + refused.slice(-5).map(r => {
          const when = String(r.at || '').slice(11, 19)
          return `\n  · ${when} ${r.kind}${r.running != null ? `（在跑 ${r.running}/${r.limit}）` : ''}${r.depth != null ? `（深度 ${r.depth}/${r.limit}）` : ''}`
        }).join('')
        + (refused.length > 5 ? `\n  …还有 ${refused.length - 5} 条` : '')
      : ''
    return `后台任务（${tasks.length}）: ${summary}\n类型: ${typeSummary}\n\n${body}${refusedLine}\n\n`
      + (running
        ? '仍有任务在跑。completed/failed/killed 才是终态，"尚未完成首轮"不等于卡死。查详情用 AgentStatus({task_id})，子 Agent 中止用 AgentStop({task_id})。'
        : '全部已进入终态。要某个 Agent 返工，用 SendMessage(to:agent_name, wake:true) 复用它的上下文。')
      + traces
  }
}

/**
 * 取子 Agent 的输出，支持**阻塞等待**（对齐官方 TaskOutput 工具）。
 *
 * 【为什么需要】原来只有 AgentStatus 快照查询，模型想等子 Agent 完成只能
 * 自己写 `Bash sleep 20` + 反复 AgentStatus 轮询 —— 每轮都烧一次模型调用。
 * 实测图灵测试那局 4 个 Agent 跑 33 分钟，大量轮次耗在轮询上。
 * 这里内部用 200ms 轮询，但对模型是**一次调用**，直接省掉那些轮次。
 */
export class AgentOutputTool extends Tool {
  constructor() {
    super({
      name: 'AgentOutput',
      description: '取后台子 Agent 的输出。\n【block:true】阻塞等到它结束或产出新内容才返回——这是等子 Agent 的正确方式，别再用 Bash sleep + 反复 AgentStatus 轮询，那样每轮都白烧一次模型调用。\n配合 wait 设上限（秒，默认 120，最大 600；timeout 是兼容旧名，等价 wait）。超时不算失败，任务还在跑，可以再等一次。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '后台子 Agent 的 task_id（来自 Agent 工具返回值或 AgentStatus）' },
          block: { type: 'boolean', description: 'true = 阻塞等待它结束（推荐）；false = 立刻返回当前快照' },
          wait: { type: 'number', description: '阻塞最长等多少秒，默认 120，上限 600' },
          timeout: { type: 'number', description: '（兼容旧名，等价 wait）阻塞最长等多少秒' },
        },
        required: ['task_id'],
      },
      maxResultSizeChars: 30000,
    })
  }

  // 返回框杂约定的 { valid, errors }（旧的字符串/null 风格会让 run() 里
  // v.valid 抽空弹，AgentOutput({block:true}) 当场就崩）。
  validateInput(input = {}) {
    if (!String(input.task_id || '').trim()) {
      return { valid: false, errors: ['task_id 不能为空'] }
    }
    const t = input.wait ?? input.timeout
    if (t != null && (typeof t !== 'number' || t <= 0)) {
      return { valid: false, errors: ['wait 必须是正数（秒）'] }
    }
    return { valid: true }
  }

  async execute(input = {}, ctx = {}) {
    const id = String(input.task_id).trim()
    let task = getBackgroundTaskStatus(id)
    if (!task) {
      const all = listBackgroundTasks().filter(t => t.type === 'local_agent')
      return `没有 task_id = ${id} 的后台任务。\n当前子 Agent: ${all.map(t => `${t.id}(${t.status})`).join(', ') || '(无)'}`
    }
    if (task.type !== 'local_agent') {
      return `${id} 不是子 Agent（type=${task.type}）。Bash 后台任务请用 BashOutput。`
    }

    if (input.block && !['completed', 'failed', 'killed'].includes(task.status)) {
      // 【修】原来只读 input.timeout，而工具描述推荐的是 wait（timeout 是兼容旧名）——
      // 传 wait:300 会被静默忽略、按默认 120s 走。两者都要认，wait 优先。
      const rawWait = input.wait ?? input.timeout
      const limitMs = Math.min(Math.max(Number(rawWait) || 120, 1), 600) * 1000
      const started = Date.now()
      const before = task.output_preview || ''
      // 200ms 轮询：够灵敏又不至于空转烧 CPU。手机上别调太密。
      while (Date.now() - started < limitMs) {
        if (ctx?.signal?.aborted) return `等待被取消（${id} 仍在后台运行）`
        await new Promise(r => setTimeout(r, 200))
        task = getBackgroundTaskStatus(id) || task
        if (['completed', 'failed', 'killed'].includes(task.status)) break
        // 有新输出也返回，让调用方能看到进展而不是干等到底
        if ((task.output_preview || '') !== before) break
      }
      const waited = ((Date.now() - started) / 1000).toFixed(1)
      const done = ['completed', 'failed', 'killed'].includes(task.status)
      const head = done
        ? `等待 ${waited}s 后 ${id} 已进入终态：${task.status}`
        : `等待 ${waited}s（未结束，任务仍在跑——超时不是失败，可以再等一次）`
      return `${head}\n\n${formatTask(id, task, true)}`
    }

    return formatTask(id, task, true)
  }
}

/**
 * 中止跑偏的后台子 Agent（对齐官方 TaskStop 工具）。
 *
 * 【为什么需要】原来派错方向只能干等它跑完：白烧 token、白占一个并发名额，
 * 而且它可能正在改文件。KillShell 只管 Bash 后台任务，管不了子 Agent。
 * 底层能力其实一直都有（plan.mjs:360 给每个后台 task 挂了 abortController，
 * bg-tasks.killBackgroundTask 会 abort 它），只是没有工具暴露出来。
 */
export class AgentStopTool extends Tool {
  constructor() {
    super({
      name: 'AgentStop',
      description: '中止一个正在后台运行的子 Agent。用于：发现派错了方向、需求变了、或它明显跑偏在浪费时间——不用干等它跑完。中止后它占的并发名额立刻释放。\n'
        + '**target 可以是 task_id（a1b2c3d4 这种），也可以直接写 agent 名字**（spawn 时的 agent_name 或 description，如 "worker-1"、"reviewer"）——记不住 id 就填名字。\n'
        + '注意：如果创建时给了 agent_name，中止后仍可用 SendMessage(to:该名字, wake:true) 唤醒它带着已有上下文重新来一遍。\n'
        + '这个工具只管子 Agent；Bash 后台任务用 KillShell。',
      input_schema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: '要中止的后台子 Agent。可以是 task_id（从 Agent 工具返回值或 AgentStatus 获取），也可以是 agent 名字（spawn 时的 agent_name，或 description）。',
          },
          reason: { type: 'string', description: '可选：为什么中止，会记进任务状态方便回溯' },
        },
        required: ['task_id'],
      },
    })
  }

  validateInput(input = {}) {
    if (!String(input.task_id || '').trim()) {
      return { valid: false, errors: ['task_id 不能为空（可填 task_id 或 agent 名字）'] }
    }
    return { valid: true }
  }

  async execute(input = {}) {
    const raw = String(input.task_id).trim()
    // 先按 id 找，找不到再按名字找 —— 对齐官方 2.1.303：
    // 「Agent-team teammates and named background agents are also accepted by agent ID or name」。
    // 顺序不能反：id 是精确且唯一的，名字可能重名（同名重派过几次）。
    let task = getBackgroundTaskStatus(raw)
    let id = raw
    let matchedBy = 'id'
    if (!task) {
      const named = findTaskByName(raw)
      if (named) { id = named.taskId; task = getBackgroundTaskStatus(id); matchedBy = 'name' }
    }
    if (!task) {
      return `未找到后台任务: ${raw}\n（已按 task_id 和 agent 名字两种方式查找）\n用 AgentStatus 查看当前有哪些子 Agent 在跑。`
    }
    if (task.type !== 'local_agent') {
      return `${id} 不是子 Agent（type=${task.type}）。Bash 后台任务请用 KillShell。`
    }
    // 已是终态就别再 kill，直接告诉调用方实情，避免它以为自己救了一命
    if (task.status !== 'running' && task.status !== 'pending') {
      return `${id} 已经是终态（${task.status}），无需中止。\n最终结果:\n${task.result_preview || '(无)'}`
    }
    const ok = killBackgroundTask(id, input.reason || 'AgentStop by model')
    if (!ok) return `中止 ${id} 失败：它可能刚好已经结束。用 AgentStatus 复查。`
    const label = task.agentName ? `${id}（${task.agentName}）` : id
    return `已中止子 Agent ${label}（${task.description || '无描述'}），并发名额已释放。`
      + (matchedBy === 'name' ? `\n（按名字 "${raw}" 匹配到 ${id}）` : '')
      + (input.reason ? `\n原因: ${input.reason}` : '')
  }
}

/**
 * ListAgents —— 列出「现在能给谁发消息」。
 *
 * 对应官方 Claude Code 2.1.x 的 ListAgents（旧名 ListPeers）。
 *
 * 为什么需要它：SendMessage 的 to 参数能填三种东西 —— 子 Agent 名（wake 唤醒）、
 * 团队成员名（inbox 投递）、"*"（广播）。但调用方往往不知道**有哪些名字可用**：
 * 子 Agent 是运行时才注册的，团队成员也取决于别人 join 过没有。原来只能瞎猜，
 * 猜错就拿到一句「没有这个名字」再重来。
 *
 * 这个工具把三个来源合成一张表：谁、什么类型、还活着吗、有多少上下文。
 * 有它之后，SendMessage 的报错路径基本不会被走到。
 */
export class ListAgentsTool extends Tool {
  constructor() {
    super({
      name: 'ListAgents',
      description: '列出当前可以发消息的对象：已跑过的子 Agent（可 wake 唤醒）、团队成员（inbox 投递）、以及它们的上下文规模。不确定 SendMessage 的 to 该填什么时先用它。',
      input_schema: {
        type: 'object',
        properties: {
          team: { type: 'string', description: '可选：只看某个团队的成员；省略则列全部来源' },
        },
        required: [],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 8000,
      // 官方 ListAgents 的 aliases 是 ["ListPeers"]（claude.js:1058238 的
      // `aliases: [str2207]`）。模型按官方旧名调时不该 Tool not found。
      aliases: ['ListPeers'],
      searchHint: 'list agents you can send messages to',
      backgrounding: 'never',
    })
  }

  async execute(input = {}) {
    const { listKeptAgents } = await import('../agent/plan.mjs')
    const { listTeams, getTeam } = await import('../agent/teams.mjs')

    const sections = []

    // ── 子 Agent（可 wake 唤醒，复用其上下文）──
    const subs = listKeptAgents()
    if (subs.length) {
      const lines = subs.map(a => {
        const age = a.lastRunAt ? Math.round((Date.now() - new Date(a.lastRunAt).getTime()) / 60000) : null
        const when = age === null ? '' : age < 1 ? '（刚刚）' : `（${age} 分钟前）`
        return `  ${a.name}  [${a.type}]  ${a.messages} 条上下文${when}`
      })
      sections.push(`子 Agent（${subs.length}）— SendMessage(to:"名字", wake:true) 可唤醒续跑：\n${lines.join('\n')}`)
    }

    // ── 团队成员（inbox 投递）──
    const wanted = input.team ? [input.team] : listTeams()
    for (const t of wanted) {
      const cfg = getTeam(t)
      if (!cfg) continue
      const members = (cfg.members || []).filter(m => m.status !== 'inactive')
      if (!members.length) continue
      const lines = members.map(m =>
        `  ${m.name}  ${m.role ? `[${m.role}]` : ''}  ${m.status || 'active'}`)
      sections.push(`团队「${t}」成员（${members.length}）— SendMessage(to:"名字", team:"${t}")：\n${lines.join('\n')}`)
    }

    if (!sections.length) {
      return '当前没有可发消息的对象。\n'
        + '· 子 Agent 要用 Agent 工具跑过才会出现在这里（建议 spawn 时显式给 agent_name）\n'
        + '· 团队成员要先 TeamCreate + TeamJoin\n'
        + '· 只想问用户问题 → 用 AskUserQuestion，不是 SendMessage'
    }

    // ── 本机其他会话（跨进程）──
    //
    // 官方 ListAgents 的能力范围比 CCM 大一个量级：它列的是「in-process subagents +
    // team teammates + other local Claude sessions + cloud sessions + Remote Control
    // 会话」（claude.js:393089 的 str3162）。CCM 原来只有前两项。
    //
    // 这里补上「other local sessions」那一半 —— 数据来自会话注册表（sessions.mjs），
    // 也就是同机的另一个 CCM 进程（典型是 Web 端）。cloud / Remote Control 做不了
    // （无 Anthropic 账号体系），见 audit-crosssession 3.4。
    //
    // 为什么放在 ListAgents 里而不是只靠 ListPeers：模型想知道「现在能给谁发消息」时
    // 应该一次看全，否则它得先猜「对方是本进程还是别的进程」再选工具 ——
    // 与 AgentStatus 那次「把一次查询劈成两半」是同一个问题。
    try {
      const { listPeerSessions } = await import('../agent/sessions.mjs')
      const peers = listPeerSessions()
      if (peers.length) {
        const lines = peers.map(p => {
          const who = p.name || p.sessionId || `pid:${p.pid}`
          const seen = p.lastSeen ? String(p.lastSeen).slice(11, 16) : '?'
          return `  ${who}  [${p.kind}]  pid ${p.pid}  最后活跃 ${seen}`
        })
        sections.push(`本机其他会话（${peers.length}）— 用 SendMessagePeer(peer:"名字") 发消息（文件队列，对方下一轮才看到）：\n${lines.join('\n')}`)
      }
    } catch {}

    return sections.join('\n\n')
      + '\n\n提示：to="*" 是广播，代价随人数线性增长，只在人人都需要知道时用。'
  }
}
