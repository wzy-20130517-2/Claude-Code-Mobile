// 子 Agent 运维命令批（对齐官方 Claude Code 2.1.303）
//
//   /list-agents   列出子 agent / 队友 / 后台会话（官方 aliases: ["peers"]）
//   /stop          中止一个后台子 agent（官方：Stop this background session）
//   /subtask       带完整上下文派一个子 agent，结果回到主对话
//   /fork          派一个继承全对话的后台 agent（与 /subtask 的差别见各命令注释）
//
// 【为什么单独一个文件】这四条的共同点是「都要摸子 agent 运行时状态」，
// 而 cmd-agents.mjs 管的是**角色卡**（定义/增删/重载），语义域不同：
//   cmd-agents   = 「有哪些角色可用」
//   cmd-agent-ops = 「现在谁在跑、我要停谁、我要派谁」
// 混在一起会让 cmd-agents 从 400 行涨到 700 行，且两条维护线互相干扰。
//
// 【与官方取舍不同的地方（都有理由，别当成遗漏）】
//   1. 官方 /fork 与 /subtask 是 local-jsx（Ink UI 弹窗选类型/看进度）。
//      手机窄屏 + 触屏打字，多级弹窗是负担，这里做成一行命令 + 文本回执。
//   2. 官方 /background、/stop 针对的是「云会话」，CCM 没有云会话；
//      CCM 的对应物是**后台子 agent**，语义映射到那上面。
//   3. 官方 /fork 的 `isEnabled: () => !fn11046()` 是排除「云端 session」场景，
//      本地版没有这个限制。

import { getRunningSubagents, MAX_CONCURRENT_SUBAGENTS, listKeptAgents } from '../agent/plan.mjs'
import { listBackgroundTasksGc as listBackgroundTasks, killBackgroundTask, getBackgroundTaskStatus } from '../agent/bg-tasks.mjs'

/** 状态 → 中文标签（与 AgentStatus 工具保持同一套词，免得两边说法打架） */
const STATUS_LABEL = {
  pending: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已中止',
}

function humanMs(ms) {
  const n = Number(ms) || 0
  if (n < 1000) return `${n}ms`
  const s = Math.floor(n / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

/**
 * @param {object} ctx
 *   C                              颜色
 *   get agent()                    主 Agent 实例（/fork 取历史用）
 *   listKeptAgents()               已结束但保留上下文的 agent（wake 能唤醒的那些）
 *   getSubagentTypes()             当前可用的 subagent_type 表
 *   getTeamInfo?()                 () => { team, members } 团队信息（可选）
 *   sendMessage?                   (payload) => result  发消息给队友（可选）
 *   isNonInteractive               () => bool
 */
export function makeAgentOpsCommands(ctx) {
  const C = ctx.C || new Proxy({}, { get: () => '' })

  return {
    /**
     * /list-agents —— 现在有哪些 agent 可以对话/查看
     *
     * 【官方语义】2.1.303：`List subagents, teammates, and other Claude sessions
     * you can message`，aliases: ["peers"]。三类来源合并成一个列表：
     *   1. 正在跑的后台子 agent（能 AgentStatus 看、能 AgentStop 停）
     *   2. 已结束但上下文还留着的（能 SendMessage wake 唤醒继续干）
     *   3. 团队队友（能 SendMessage 发消息）
     * 官方还有第四类「其它 Claude 会话」（云会话），CCM 没有，不列。
     *
     * 【为什么这三类必须放一起】用户的问题是「我能找谁干活」，而这三个答案
     * 原来分散在 /agents（角色卡）、/bg-list（后台任务）、/team（团队）三处，
     * 且 /bg-list 只显示 id 和状态，看不出哪个还能唤醒。合并后一眼看全。
     */
    'list-agents'(args) {
      const showAll = String(args[0] || '').toLowerCase() === 'all'
      const lines = []

      // ── 1 + 2：子 agent（运行中 + 可唤醒）──
      const tasks = (() => { try { return listBackgroundTasks() || [] } catch { return [] } })()
      const subTasks = tasks.filter(t => t.type !== 'local_bash')
      const live = subTasks.filter(t => t.status === 'running' || t.status === 'pending')
      const done = subTasks.filter(t => !['running', 'pending'].includes(t.status))

      lines.push(`${C.bold}子 Agent${C.reset}  运行中 ${live.length} · 并发上限 ${MAX_CONCURRENT_SUBAGENTS}`)
      if (live.length === 0) {
        lines.push(`  ${C.dim}（当前没有在跑的）${C.reset}`)
      } else {
        for (const t of live) {
          const name = t.agentName || t.id
          const turns = t.turns ? ` · ${t.turns} turn` : ''
          const type = t.agentType ? ` [${t.agentType}]` : ''
          const dur = t.duration_ms ? humanMs(t.duration_ms) : humanMs(Date.now() - (t.startTime || Date.now()))
          lines.push(`  ● ${name}${type}  ${STATUS_LABEL[t.status] || t.status} · ${dur}${turns}`)
          lines.push(`    ${C.dim}${t.description || '(无描述)'}${C.reset}`)
        }
      }

      // 可唤醒：已结束但上下文还在
      // listKeptAgents() 的字段是 { name, type, lastRunAt, messages }，
      // 没有 status / turns —— 不要按「有 status 的 task」去想它。
      const kept = (() => { try { return listKeptAgents() || [] } catch { return [] } })()
      if (kept.length) {
        lines.push('')
        lines.push(`${C.bold}可唤醒${C.reset}（上下文还在，SendMessage wake 可继续）`)
        for (const k of kept.slice(0, showAll ? 100 : 8)) {
          const ago = k.lastRunAt ? ` · ${humanMs(Date.now() - k.lastRunAt)}前` : ''
          lines.push(`  ○ ${k.name}${k.type ? ` [${k.type}]` : ''} · ${k.messages} 条上下文${ago}`)
        }
        if (!showAll && kept.length > 8) {
          lines.push(`  ${C.dim}… 另有 ${kept.length - 8} 个（/list-agents all 看全部）${C.reset}`)
        }
      }

      // ── 3：团队队友 ──
      let teamInfo = null
      try { teamInfo = typeof ctx.getTeamInfo === 'function' ? ctx.getTeamInfo() : null } catch {}
      if (teamInfo && teamInfo.team) {
        lines.push('')
        lines.push(`${C.bold}团队${C.reset} ${teamInfo.team}`)
        const members = Array.isArray(teamInfo.members) ? teamInfo.members : []
        if (members.length === 0) {
          lines.push(`  ${C.dim}（没有成员）${C.reset}`)
        } else {
          for (const m of members) {
            const badge = m.status === 'inactive' ? `${C.dim}(已收工)${C.reset}` : ''
            // 团队成员的字段是 { name, role, status, joinedAt, owned, unread }，
            // 不是 agent（那是 inbox 里的字段）—— 这里按 name 取。
            const extra = []
            if (m.owned) extra.push(`${m.owned} 个任务`)
            if (m.unread) extra.push(`${m.unread} 条未读`)
            lines.push(`  @${m.name}${badge}${m.role ? `  ${m.role}` : ''}${extra.length ? `  ${C.dim}${extra.join(' · ')}${C.reset}` : ''}`)
          }
        }
      }

      // ── 收尾：还有已结束的子 agent 任务时提示去哪看 ──
      if (done.length) {
        lines.push('')
        lines.push(`${C.dim}已结束 ${done.length} 个（/tasklist 看持久待办 · /tasks 看含 Bash 的全部后台任务）${C.reset}`)
      }
      lines.push('')
      lines.push(`${C.dim}看详情：AgentStatus({task_id}) · 停掉：/stop <名字|id> · 唤醒：SendMessage(to:名字, wake:true)${C.reset}`)
      return lines.join('\n')
    },

    /**
     * /stop —— 中止一个正在跑的后台子 agent
     *
     * 【官方语义】2.1.303 的 /stop：`Stop this background session; transcript and
     * worktree are kept`。CCM 没有「后台会话」，对应物是后台子 agent，
     * 所以这里停的是子 agent（等价于 AgentStop 工具）。
     *
     * 【为什么不叫 /kill】kill 在 CCM 里已经是 Bash 后台任务的概念
     * （KillShell），两个词混用会让人以为 /stop 能停 Bash 任务。
     * 实际上它**也能**停 local_bash 类型（见下），只是主语义是子 agent。
     *
     * 【为什么不加确认】与 /agents 的删除同理：手机上多一次点击只是负担，
     * 而中止子 agent 是可恢复的（上下文保留，能 wake 重来），不是破坏性操作。
     */
    async stop(args) {
      const target = String(args[0] || '').trim()
      if (!target) {
        const live = (() => {
          try {
            return (listBackgroundTasks() || []).filter(t => t.status === 'running' || t.status === 'pending')
          } catch { return [] }
        })()
        if (live.length === 0) return '当前没有在跑的后台任务。'
        return [
          '用法: /stop <任务ID|agent名字>',
          '',
          '正在跑的:',
          ...live.map(t => `  ${t.agentName || t.id}  ${STATUS_LABEL[t.status] || t.status}  ${t.description || ''}`),
          '',
          '（不带参数只会列出来，不会停任何一个 —— 避免误杀）',
        ].join('\n')
      }

      // 按 id 或 agent 名字找：用户记得住名字记不住 uuid，两种都要支持
      const all = (() => { try { return listBackgroundTasks() || [] } catch { return [] } })()
      const hit = all.find(t => t.id === target)
        || all.find(t => t.agentName === target)
        || all.find(t => String(t.agentName || '').toLowerCase() === target.toLowerCase())

      if (!hit) {
        const names = all.map(t => t.agentName || t.id).filter(Boolean)
        return `没有找到任务或 agent: ${target}\n`
          + (names.length ? `可用的: ${names.join(', ')}` : '（当前没有任何后台任务）')
      }
      if (['completed', 'failed', 'killed'].includes(hit.status)) {
        return `${hit.agentName || hit.id} 已经是终态（${STATUS_LABEL[hit.status] || hit.status}），无需中止。\n`
          + '想让它继续干活：SendMessage(to:' + (hit.agentName || hit.id) + ', wake:true, text:"...")'
      }

      const ok = killBackgroundTask(hit.id, args.slice(1).join(' ') || 'stopped by /stop')
      if (!ok) return `中止失败：${hit.id}（可能刚好已结束，用 /list-agents 再看一次）`
      return [
        `已中止 ${hit.agentName || hit.id}（${STATUS_LABEL[hit.status] || hit.status} → killed）`,
        '',
        '上下文已保留：',
        `  · 想让它接着干 → SendMessage(to:"${hit.agentName || hit.id}", wake:true, text:"...")`,
        '  · 想看它干到哪了 → /bg-status ' + hit.id,
        '  · 并发名额已释放（/list-agents 看当前占用）',
      ].join('\n')
    },

    /**
     * /subtask —— 带完整上下文派一个子 agent，结果回到这里
     *
     * 【官方语义】2.1.303：`Send a subagent off with your full context; its result
     * comes back here`，argumentHint `<task>`。
     *
     * 【与 /fork 的区别（官方也是这么分的）】
     *   /subtask = 派出去干活，**结果回主对话**，主对话继续（等价于 Agent 工具
     *              默认的同步语义 + 把当前对话历史作为上下文一起给）
     *   /fork    = 复制整个对话到**新会话**并行跑，主对话不受影响
     * 官方两个都是 local-jsx 弹窗；CCM 这里 /subtask 走同步 Agent，
     * /fork 走后台 Agent（后台等价于「另一条线」，因为 CCM 没有多会话 UI）。
     *
     * 【为什么必须把历史一起给】普通 Agent 工具只给 prompt，子 agent 是白纸，
     * 用户得在 prompt 里重述背景。这正是 /subtask 存在的理由：**省掉重述**。
     * 这里把最近 N 条消息压成一段文本塞进 prompt 前缀，并明确告诉子 agent
     * 「这是主对话的上下文，不要复述、不要回应它，直接干活」。
     *
     * 【为什么限制 40 条】历史可能几千条，全塞会直接把子 agent 的上下文撑爆，
     * 反而让它干不了活。40 条覆盖绝大多数「刚才我们讨论的」场景。
     */
    async subtask(args) {
      const task = args.join(' ').trim()
      if (!task) {
        return [
          '用法: /subtask <任务描述>',
          '',
          '派一个子 agent 干活，**带着当前对话的上下文**，结果回到主对话。',
          '例：',
          '  /subtask 把刚才讨论的三个 bug 都修掉，改完跑 ci-preflight',
          '  /subtask 用 Explore 类型调研一下 core/api 里所有超时相关的常量',
          '',
          '与 /fork 的区别：/subtask 同步等结果、主对话继续；',
          '/fork 是后台并行跑，不阻塞你继续说话。',
        ].join('\n')
      }
      if (typeof ctx.spawnSubAgent !== 'function') {
        return '/subtask 需要子 agent 运行时支持（当前环境没注入 spawnSubAgent）。\n用 Agent 工具代替即可。'
      }

      // 取最近 40 条历史，压成一段「前情提要」
      const history = (() => { try { return ctx.agent?.getHistory?.() || [] } catch { return [] } })()
      const recent = history.slice(-40)
      const digest = recent.map((m) => {
        const role = m?.role === 'assistant' ? '助手' : m?.role === 'user' ? '用户' : '工具'
        let text = ''
        const c = m?.content
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) {
          text = c.map(b => (typeof b === 'string' ? b : (b?.text || ''))).filter(Boolean).join('\n')
        }
        // 单条截断：一条 5 万字符的工具结果会把整个上下文吃掉
        text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 800)
        return text ? `[${role}] ${text}` : ''
      }).filter(Boolean).join('\n')

      const prompt = [
        '## 主对话前情（供你理解背景，不要在回复里复述它）',
        digest || '(无历史)',
        '',
        '## 你的任务',
        task,
        '',
        '## 交付要求',
        '做完直接给结论和改动清单，不要重复背景。',
      ].join('\n')

      const r = await ctx.spawnSubAgent({
        prompt,
        description: task.slice(0, 40),
        subagent_type: 'general-purpose',
        run_in_background: false,
      })
      return typeof r === 'string' ? r : (r?.text || JSON.stringify(r, null, 2))
    },

    /**
     * /fork —— 派一个继承全对话的后台 agent
     *
     * 【官方语义】2.1.303 有两个同名实现（按环境二选一）：
     *   · `Spawn a background agent that inherits the full conversation`
     *   · `Copy this conversation into a new background session and keep working here`
     * 共同点：**继承全对话 + 后台跑 + 主对话不受影响**。
     *
     * 【CCM 怎么映射】CCM 没有「多会话并排」的 UI，但有后台子 agent
     * （run_in_background: true，主对话照常继续，结果用 AgentStatus 取）。
     * 所以 /fork = 后台子 agent + 全量对话摘要作上下文。
     *
     * 【为什么与 /subtask 不做成同一个】两者只差 run_in_background，
     * 但**用户的心智模型不同**：subtask 是「你帮我干这个，干完告诉我」，
     * fork 是「你按这条线自己跑，我这边继续」。合并成一个带 flag 的命令
     * 会让默认行为变得需要解释（默认同步还是后台？），不如两条命令各自明确。
     *
     * 【为什么默认不加类型参数】官方 fork 也不让选类型（继承当前配置）。
     * 需要指定类型用 /subtask 或在正文里说，别在这里加第二个位置参数 ——
     * 位置参数一多，用户就会写错顺序。
     */
    async fork(args) {
      const directive = args.join(' ').trim()
      if (!directive) {
        return [
          '用法: /fork <指令>',
          '',
          '派一个**继承当前全对话**的后台 agent，你这边照常继续说话。',
          '例：',
          '  /fork 把剩下 12 个文件的注释补齐，补完跑一遍 ci-preflight',
          '  /fork 盯着 CI，绿了就把版本号 +1 并提交',
          '',
          '取结果：/list-agents 看它在不在跑 → AgentOutput({task_id, block:true}) 等它',
          '中止：/stop <名字>',
          '',
          '与 /subtask 的区别：/fork 不阻塞，主对话可以继续；/subtask 会等结果回来。',
        ].join('\n')
      }
      if (typeof ctx.spawnSubAgent !== 'function') {
        return '/fork 需要子 agent 运行时支持（当前环境没注入 spawnSubAgent）。\n用 Agent 工具（run_in_background:true）代替即可。'
      }

      const history = (() => { try { return ctx.agent?.getHistory?.() || [] } catch { return [] } })()
      // fork 是「继承全对话」，但全量塞不下 —— 取最近 60 条 + 明确告知被截断，
      // 而不是假装继承了一切（假装会让它基于缺失的上下文做出错误决定）。
      const LIMIT = 60
      const recent = history.slice(-LIMIT)
      const truncated = history.length > LIMIT
      const digest = recent.map((m) => {
        const role = m?.role === 'assistant' ? '助手' : m?.role === 'user' ? '用户' : '工具'
        const c = m?.content
        let text = ''
        if (typeof c === 'string') text = c
        else if (Array.isArray(c)) text = c.map(b => (typeof b === 'string' ? b : (b?.text || ''))).filter(Boolean).join('\n')
        text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 700)
        return text ? `[${role}] ${text}` : ''
      }).filter(Boolean).join('\n')

      const prompt = [
        `## 主对话上下文（${truncated ? `最近 ${LIMIT} 条，共 ${history.length} 条，更早的已省略` : '全部'}）`,
        '这是为了让你接手时不丢背景。不要在回复里复述它。',
        digest || '(无历史)',
        '',
        '## 你的指令',
        directive,
        '',
        '## 工作方式',
        '你在后台独立跑，主对话不会等你。做完把结论写进 TaskUpdate 的 comment',
        '（用 Task 工具记一条），主对话会去取。',
      ].join('\n')

      const r = await ctx.spawnSubAgent({
        prompt,
        description: directive.slice(0, 40),
        subagent_type: 'general-purpose',
        run_in_background: true,
        agent_name: args.agentName || undefined,
      })
      const text = typeof r === 'string' ? r : (r?.text || JSON.stringify(r, null, 2))
      return [
        text,
        '',
        `${C.dim}主对话不受影响，可以继续说话。取结果：AgentOutput({task_id, block:true})${C.reset}`,
      ].join('\n')
    },
  }
}
