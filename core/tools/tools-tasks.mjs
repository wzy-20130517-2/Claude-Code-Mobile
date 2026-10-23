// Task 工具集：把 core/tasks.mjs 的持久任务暴露给 Agent。
//
// 为什么不合并进 TodoWrite：
//   TodoWrite 是「给用户看当轮进度」，写完即弃，不需要 id、依赖、归属。
//   Task 是「多 Agent 之间的共享待办」，必须能被另一个 agent 查到、领走、改状态。
//   两者语义不同，合并会让简单场景也被迫填 id 和依赖，反而更难用。

import { Tool } from './tools.mjs'
import {
  createTask, listTasks, getTask, updateTask, claimTask,
  deleteTask, addDependency, addComment, formatTasks, TASK_DEFAULT_LIST,
} from '../agent/tasks.mjs'

const listProp = {
  type: 'string',
  description: `任务列表名，默认 ${TASK_DEFAULT_LIST}。不同项目/不同协作组用不同列表隔离`,
}

const idProp = { type: 'string', description: '任务 id（编号，如 "3"）' }
const taskIdProp = {
  type: 'string',
  description: '（官方 2.1.303 同名字段，等价于 id）任务 id。与 id 二选一，同时给时以 taskId 为准。',
}

/**
 * `taskId` → `id` 归一（官方 2.1.303 用 `taskId`，CCM 用 `id`）。
 *
 * 为什么两个都收：官方 TaskGet/TaskUpdate 的首参是 `taskId`（claude.js:1064923 附近），
 * 模型按官方文档写 `taskId` 在 CCM 上会报「缺少 id」—— 用户完全看不出是自己
 * 用对了字段名、而实现没跟上。
 *
 * 返回 null = 无需改动（基类约定）；否则返回新对象，不污染调用方。
 */
function coerceTaskId(input) {
  if (!input || typeof input !== 'object') return null
  if (input.taskId === undefined || input.taskId === null || input.taskId === '') return null
  const taskId = String(input.taskId)
  if (input.id === taskId) return null
  return { ...input, id: taskId }
}

export class TaskCreateTool extends Tool {
  constructor() {
    super({
      name: 'TaskCreate',
      description: '创建持久化任务（跨轮、跨重启存活，可被子 Agent 领取）。多 Agent 协作或需要跟踪依赖关系时用；单轮临时清单用 TodoWrite。',
      input_schema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '任务标题，一句话说清要做什么' },
          description: { type: 'string', description: '详细说明、验收标准、相关文件。必填——接手的人只看这个就知道做到哪、要做什么' },
          activeForm: { type: 'string', description: '可选：进行时描述（如「修复 parser 崩溃」），用于状态栏显示' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '可选：前置任务 id 列表，这些没完成前本任务无法被领取' },
          metadata: {
            type: 'object',
            description: '可选：挂在这条任务上的任意结构化信息（官方 2.1.303 同名字段），如 {"files":["core/x.mjs"],"pr":12}。给接手的人看的机器可读线索，不参与状态判定。',
          },
          list: listProp,
        },
        required: ['subject', 'description'],
      },
      maxResultSizeChars: 2000,
      validateInput(input) {
        const errors = []
        if (!input.subject || !String(input.subject).trim()) errors.push('subject is required')
        // 官方 claude.js:1064470 的 description 没写 .optional()，是必填。
        // 缺了它任务只剩一句标题，接手的人（尤其跨会话/跨 Agent）无从知道
        // 做到哪、验收标准是什么 —— 而这正是 Task 相对 TodoWrite 的唯一价值。
        if (!input.description || !String(input.description).trim()) {
          errors.push('description is required（写清详细说明/验收标准/相关文件；只有标题的任务无法交接）')
        }
        if (input.blockedBy && !Array.isArray(input.blockedBy)) errors.push('blockedBy must be an array')
        return { valid: errors.length === 0, errors }
      },
      searchHint: 'create a task for multi-agent coordination',
      backgrounding: 'never',
      // 官方 TaskCreate 的 isConcurrencySafe 是 false —— 并发创建会争同一个任务文件
      isConcurrencySafe: () => false,
    })
  }

  async execute(input) {
    const list = input.list || TASK_DEFAULT_LIST
    const t = createTask(list, input)
    const dep = t.blockedBy.length ? `，被 #${t.blockedBy.join(' #')} 阻塞` : ''
    const meta = t.metadata ? `，metadata ${Object.keys(t.metadata).length} 个键` : ''
    return `已创建任务 #${t.id}: ${t.subject}${dep}${meta}`
  }
}

export class TaskListTool extends Tool {
  constructor() {
    super({
      name: 'TaskList',
      description: '列出持久化任务，看谁在做什么、哪些被阻塞。图标含义：○待办 →进行中 ✓完成；@名字=归属 agent；⟵id=被该任务阻塞。',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '可选：只看某状态' },
          owner: { type: 'string', description: '可选：只看某个 agent 的任务' },
          list: listProp,
        },
      },
      maxResultSizeChars: 4000,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      searchHint: 'list tasks and who is working on what',
      backgrounding: 'never',
    })
  }

  async execute(input) {
    const list = input.list || TASK_DEFAULT_LIST
    let tasks = listTasks(list)
    if (input.status) tasks = tasks.filter(t => t.status === input.status)
    if (input.owner) tasks = tasks.filter(t => t.owner === input.owner)
    const head = `任务列表 [${list}]（共 ${tasks.length}）`
    return `${head}\n${formatTasks(tasks)}`
  }
}

export class TaskGetTool extends Tool {
  constructor() {
    super({
      name: 'TaskGet',
      description: '读取单个任务的完整内容（含 description、依赖、归属、时间戳）。领取任务前先看清要求。',
      input_schema: {
        type: 'object',
        properties: {
          id: idProp,
          taskId: taskIdProp,
          list: listProp,
        },
        required: ['id'],
      },
      maxResultSizeChars: 4000,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      searchHint: 'read a task in full',
      backgrounding: 'never',
      coerceInput: coerceTaskId,
      // required 里写的是 id，但官方字段名是 taskId —— 校验放行任一即可
      validateInput(input) {
        const has = (input.id !== undefined && input.id !== null && input.id !== '')
          || (input.taskId !== undefined && input.taskId !== null && input.taskId !== '')
        return has ? { valid: true } : { valid: false, errors: ['需要 id（或官方同名字段 taskId）'] }
      },
    })
  }

  async execute(input) {
    const t = getTask(input.list || TASK_DEFAULT_LIST, input.id)
    if (!t) return `任务 #${input.id} 不存在`
    const lines = [
      `#${t.id} ${t.subject}`,
      `状态: ${t.status}${t.owner ? ` · 归属: ${t.owner}` : ''}`,
    ]
    if (t.description) lines.push(`说明: ${t.description}`)
    if (t.blockedBy.length) lines.push(`被阻塞于: #${t.blockedBy.join(' #')}`)
    if (t.blocks.length) lines.push(`阻塞着: #${t.blocks.join(' #')}`)
    // metadata：机器可读线索（相关文件、PR 号等），有就原样给出来
    if (t.metadata && Object.keys(t.metadata).length) {
      lines.push(`metadata: ${JSON.stringify(t.metadata)}`)
    }
    // 进展留痕：交接时最有用的部分，放在最后完整显示
    if (t.comments?.length) {
      lines.push('', `进展记录（${t.comments.length} 条）:`)
      for (const c of t.comments) {
        const when = String(c.at || '').slice(5, 16).replace('T', ' ')
        lines.push(`  · [${when}] ${c.by}: ${c.text}`)
      }
    }
    lines.push(`创建: ${t.createdAt} · 更新: ${t.updatedAt}`)
    return lines.join('\n')
  }
}

export class TaskUpdateTool extends Tool {
  constructor() {
    super({
      name: 'TaskUpdate',
      description: '更新任务：改状态（pending/in_progress/completed）、改标题说明、交还归属（owner 传空字符串）、加依赖。做完一件事就立刻标 completed，别攒着。',
      input_schema: {
        type: 'object',
        properties: {
          id: idProp,
          taskId: taskIdProp,
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
          subject: { type: 'string' },
          description: { type: 'string' },
          activeForm: { type: 'string' },
          owner: { type: 'string', description: '归属 agent；传空字符串表示交还（变回无人认领）' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '可选：追加前置任务 id（双向维护依赖边）' },
          addBlockedBy: {
            type: 'array', items: { type: 'string' },
            description: '（官方 2.1.303 同名字段，等价于 blockedBy）阻塞这条任务的 id 列表。',
          },
          addBlocks: {
            type: 'array', items: { type: 'string' },
            description: '（官方 2.1.303 字段）被这条任务阻塞的 id 列表——与 addBlockedBy 方向相反：本任务完成前，它们领不了。',
          },
          metadata: {
            type: 'object',
            description: '（官方 2.1.303 字段）要合并进任务的元数据键值；某个键传 null = 删除该键。合并语义，不会覆盖没提到的键。',
          },
          comment: { type: 'string', description: '可选：追加一条进展留痕（做到哪、试过什么、卡在哪）。交接给别人时写这个，比只改 status 有用得多' },
          by: { type: 'string', description: '可选：留痕作者，默认用 owner 或 unknown' },
          list: listProp,
        },
        required: ['id'],
      },
      maxResultSizeChars: 2000,
      isConcurrencySafe: () => false,
      searchHint: 'update a task status owner or dependencies',
      backgrounding: 'never',
      coerceInput: coerceTaskId,
      validateInput(input) {
        const has = (input.id !== undefined && input.id !== null && input.id !== '')
          || (input.taskId !== undefined && input.taskId !== null && input.taskId !== '')
        return has ? { valid: true } : { valid: false, errors: ['需要 id（或官方同名字段 taskId）'] }
      },
    })
  }

  async execute(input) {
    const list = input.list || TASK_DEFAULT_LIST
    // 【官方用 status:"deleted" 表示删除】claude.js:1064923 的
    // `status: fn45122().or(fn2494("deleted"))` —— 官方没有独立 TaskDelete 工具。
    // CCM 保留了独立 TaskDelete（更直观），但也要认这个官方写法，
    // 否则模型按官方文档传 status:"deleted" 会走到 updateTask 被
    // VALID_STATUS 拒绝，报「status 只能是 pending / in_progress / completed」。
    if (input.status === 'deleted') {
      const ok = deleteTask(list, input.id)
      return ok ? `已删除任务 #${input.id}` : `任务 #${input.id} 不存在`
    }
    const patch = {}
    for (const k of ['status', 'subject', 'description', 'activeForm']) {
      if (k in input) patch[k] = input[k]
    }
    // metadata 走 updateTask 的合并语义（null = 删键）
    if (input.metadata && typeof input.metadata === 'object') patch.metadata = input.metadata
    // owner 传空串 = 交还任务，转成 null 落盘
    if ('owner' in input) patch.owner = input.owner === '' ? null : input.owner
    const t = updateTask(list, input.id, patch)
    if (!t) return `任务 #${input.id} 不存在`
    // 依赖边两个方向都要收：
    //   blockedBy / addBlockedBy → 这些任务阻塞我（addDependency(前置, 我)）
    //   addBlocks              → 我阻塞这些任务（addDependency(我, 后置)）
    // 官方 2.1.303 把「我阻塞谁」单独拆成 addBlocks，因为原来只能从
    // 被阻塞方去写，反向建边得绕一圈。两个别名都收，避免按官方写法传了不生效。
    const upstream = [...(input.blockedBy || []), ...(input.addBlockedBy || [])]
    for (const dep of upstream) addDependency(list, String(dep), String(input.id))
    for (const dep of (input.addBlocks || [])) addDependency(list, String(input.id), String(dep))
    // 进展留痕：作者优先用显式 by，其次用任务当前 owner
    let noted = ''
    if (input.comment) {
      addComment(list, input.id, { by: input.by || t.owner || 'unknown', text: input.comment })
      noted = ' · 已记进展'
    }
    const fresh = getTask(list, input.id)
    return `已更新 #${fresh.id}: ${fresh.subject}（${fresh.status}${fresh.owner ? ` @${fresh.owner}` : ''}）${noted}`
  }
}

export class TaskClaimTool extends Tool {
  constructor() {
    super({
      name: 'TaskClaim',
      description: '领取任务并置为 in_progress。会检查是否已被他人占用、是否已完成、前置任务是否都完成——被拒绝时会说明原因，不要硬改 owner 绕过。',
      input_schema: {
        type: 'object',
        properties: {
          id: idProp,
          taskId: taskIdProp,
          agent: { type: 'string', description: '领取者标识，如 main / worker-1 / reviewer' },
          list: listProp,
        },
        required: ['id', 'agent'],
      },
      maxResultSizeChars: 2000,
      isConcurrencySafe: () => false,
      searchHint: 'claim a task so others know you are on it',
      backgrounding: 'never',
      coerceInput: coerceTaskId,
    })
  }

  async execute(input) {
    const r = claimTask(input.list || TASK_DEFAULT_LIST, input.id, input.agent)
    if (r.ok) return `${input.agent} 已领取 #${r.task.id}: ${r.task.subject}`
    const why = {
      not_found: `任务 #${input.id} 不存在`,
      already_claimed: `#${input.id} 已被 ${r.owner} 领取`,
      already_completed: `#${input.id} 已完成`,
      blocked: `#${input.id} 被未完成的 #${(r.blockedBy || []).join(' #')} 阻塞`,
    }
    return `领取失败：${why[r.reason] || r.reason}`
  }
}

export class TaskDeleteTool extends Tool {
  constructor() {
    super({
      name: 'TaskDelete',
      description: '删除任务，同时清理其他任务里指向它的依赖边。误建或作废时用；已完成的任务建议留着做记录，不必删。',
      input_schema: {
        type: 'object',
        properties: {
          id: idProp,
          taskId: taskIdProp,
          list: listProp,
        },
        required: ['id'],
      },
      maxResultSizeChars: 500,
      isConcurrencySafe: () => false,
      searchHint: 'delete a task and its dependency edges',
      backgrounding: 'never',
      coerceInput: coerceTaskId,
    })
  }

  async execute(input) {
    const ok = deleteTask(input.list || TASK_DEFAULT_LIST, input.id)
    return ok ? `已删除任务 #${input.id}` : `任务 #${input.id} 不存在`
  }
}

export const TASK_TOOLS = [
  new TaskCreateTool(),
  new TaskListTool(),
  new TaskGetTool(),
  new TaskUpdateTool(),
  new TaskClaimTool(),
  new TaskDeleteTool(),
]
