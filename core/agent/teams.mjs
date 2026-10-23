// Team + Mailbox：多 Agent 协作的组织与通信层
//
// 设计抄自官方 claude-code（utils/teammateMailbox.ts + TeamCreateTool）：
//   1) Team 与 TaskList 1:1 对应 —— teamName 直接当 tasks.mjs 的 listId 用，
//      不再单独维护「团队有哪些任务」，天然同步。
//   2) 每个成员一个独立 inbox 文件，不是共享队列 —— 避免并发写同一文件，
//      也让「谁还没读消息」可查。
//   3) 消息带 read 标记而不是读完删除 —— 保留会话痕迹，便于事后复盘。
//
// 与官方的差异（移动端简化）：
//   官方有 Unix socket / remote bridge 做跨进程实时投递，我们只做文件队列。
//   Termux 单机场景下子 Agent 是同进程调度的，文件队列足够，不引入额外依赖。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite } from '../infra/atomic.mjs'
import { listTasks, resetTaskList } from './tasks.mjs'

const ROOT = join(homedir(), '.claude-code-mobile', 'teams')
// 单个 inbox 保留的消息上限。超过就丢最旧的：inbox 是通信缓冲不是归档，
// 无上限会让长任务的 JSON 涨到几 MB，每次读写都变慢。
const MAX_INBOX_MESSAGES = 200

function safeName(s) {
  return String(s || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
}

function teamDir(team) { return join(ROOT, safeName(team)) }
function configPath(team) { return join(teamDir(team), 'config.json') }
function inboxDir(team) { return join(teamDir(team), 'inboxes') }
function inboxPath(team, agent) { return join(inboxDir(team), `${safeName(agent)}.json`) }

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return fallback }
}

export function teamExists(team) {
  return existsSync(configPath(team))
}

export function createTeam(team, { description = '' } = {}) {
  if (!team || !String(team).trim()) throw new Error('team 名称必填')
  const name = safeName(team)
  if (teamExists(name)) return { ok: false, reason: 'exists', team: getTeam(name) }
  mkdirSync(inboxDir(name), { recursive: true })
  const cfg = {
    name,
    description: String(description || ''),
    members: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  atomicWrite(configPath(name), JSON.stringify(cfg, null, 2))
  return { ok: true, team: cfg }
}

export function getTeam(team) {
  return readJson(configPath(team), null)
}

export function listTeams() {
  if (!existsSync(ROOT)) return []
  return readdirSync(ROOT)
    .filter(d => existsSync(configPath(d)))
    .map(d => getTeam(d))
    .filter(Boolean)
}

/** 加入团队。重复加入不报错，幂等——子 Agent 可能被重启后重新 join。 */
export function joinTeam(team, agent, { role = '' } = {}) {
  const cfg = getTeam(team)
  if (!cfg) return { ok: false, reason: 'no_team' }
  const name = safeName(agent)
  const existing = cfg.members.find(m => m.name === name)
  if (existing) {
    if (role) existing.role = role
    existing.status = 'active'
  } else {
    cfg.members.push({ name, role: String(role || ''), status: 'active', joinedAt: new Date().toISOString() })
  }
  cfg.updatedAt = new Date().toISOString()
  atomicWrite(configPath(team), JSON.stringify(cfg, null, 2))
  // 建空 inbox，让 sendMessage 不必先判目录是否存在
  if (!existsSync(inboxPath(team, name))) {
    mkdirSync(inboxDir(team), { recursive: true })
    atomicWrite(inboxPath(team, name), JSON.stringify([], null, 2))
  }
  return { ok: true, team: cfg }
}

export function setMemberStatus(team, agent, status) {
  const cfg = getTeam(team)
  if (!cfg) return false
  const m = cfg.members.find(x => x.name === safeName(agent))
  if (!m) return false
  m.status = status
  cfg.updatedAt = new Date().toISOString()
  atomicWrite(configPath(team), JSON.stringify(cfg, null, 2))
  return true
}

/**
 * 投递消息到对方 inbox。
 * summary 是给人看的一行预览（官方用于 UI 折叠显示），text 是完整内容。
 */
export function sendMessage(team, { from, to, text, summary = '', type = 'text', notifyWhenIdle = false }) {
  const cfg = getTeam(team)
  if (!cfg) return { ok: false, reason: 'no_team' }

  // 【to:"*" = 广播给所有队友】对齐官方 SendMessageTool。
  // 没有广播时，想让全场都听见只能对每个人发一遍 —— 图灵测试那局里
  // 4 个 Agent 各自把同一段话发 3 遍，纯浪费轮次。
  // 官方原文标注 "expensive (linear in team size)"，所以只在真的人人都需要时用。
  if (String(to).trim() === '*') {
    const me = safeName(from)
    const targets = cfg.members.filter(m => m.name !== me && m.status !== 'inactive')
    if (!targets.length) return { ok: false, reason: 'no_peers' }
    let n = 0
    for (const m of targets) {
      const r = sendMessage(team, { from, to: m.name, text, summary, type, notifyWhenIdle })
      if (r.ok) n++
    }
    return { ok: true, broadcast: true, delivered: n, targets: targets.map(m => m.name) }
  }

  const target = safeName(to)
  if (!cfg.members.find(m => m.name === target)) {
    return { ok: false, reason: 'no_member', members: cfg.members.map(m => m.name) }
  }
  mkdirSync(inboxDir(team), { recursive: true })
  const box = readJson(inboxPath(team, target), [])
  const msgId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  box.push({
    id: msgId,
    from: safeName(from),
    to: target,
    type,
    text: String(text || ''),
    summary: String(summary || '').slice(0, 80),
    timestamp: new Date().toISOString(),
    read: false,
    // 消息体上这个标记只用于 CheckMessages 显示「这条带了空闲通知请求」。
    // 真正的订阅在下面的订阅表里 —— 原来只写这个标记、全仓库没人读，
    // 等于参数完全没生效（见 subscribeIdle 的注释）。
    notifyWhenIdle: !!notifyWhenIdle,
  })
  // 超限丢最旧
  const trimmed = box.length > MAX_INBOX_MESSAGES ? box.slice(-MAX_INBOX_MESSAGES) : box
  atomicWrite(inboxPath(team, target), JSON.stringify(trimmed, null, 2))

  // 【真正的订阅登记】notify_when_idle 的实现。
  //
  // 订阅和消息是两条独立通道（官方也是分开的：Class1363.outstanding 是订阅表，
  // inbox 是消息）。因为订阅可以「不带消息」—— 单纯想知道某人什么时候空下来。
  // 所以单独登记，读消息时不会把它消耗掉。
  if (notifyWhenIdle) {
    subscribeIdle({ team, watcher: safeName(from), target, msgId })
  }

  return { ok: true, queued: trimmed.length, msgId }
}

// ── notify_when_idle 订阅表 ─────────────────────────────────────────
//
// 上限抄官方（claude.js:1019579 的 num2439 / num3327 / num1708）：
//   · 总订阅数 32
//   · 同一目标最多 3 条（再多说明在刷订阅，没有意义）
//   · 12 小时过期（等待方如果一直 sleep 会永远等不到，必须有过期兜底）
const MAX_SUBSCRIPTIONS = 32
const MAX_PER_TARGET = 3
const SUBSCRIPTION_TTL_MS = 12 * 60 * 60 * 1000

/** watcher → Map<targetKey, [{msgId, team, target, at, expiresAt}]> */
const idleSubscriptions = new Map()

function subKey(team, target) { return `${team}::${target}` }

/**
 * 登记一条「等 target 空闲」的订阅。幂等去重按 msgId（重试场景）。
 */
export function subscribeIdle({ team, watcher, target, msgId = null }) {
  const key = subKey(team, target)
  const list = idleSubscriptions.get(watcher) || new Map()
  const arr = list.get(key) || []

  if (msgId && arr.some(s => s.msgId === msgId)) {
    return { ok: true, deduped: true, count: arr.length }
  }
  // 每目标上限：挤掉最旧的一条（官方：「a newer subscription displaced this one」）
  while (arr.length >= MAX_PER_TARGET) arr.shift()

  // 总量上限：挤掉全局最旧的一条
  let total = 0
  for (const a of idleSubscriptions.values()) for (const v of a.values()) total += v.length
  if (total >= MAX_SUBSCRIPTIONS) {
    let oldest = null
    for (const [w, m] of idleSubscriptions) {
      for (const [k, v] of m) {
        for (const s of v) {
          if (!oldest || s.at < oldest.at) oldest = { w, k, s }
        }
      }
    }
    if (oldest) {
      const l = idleSubscriptions.get(oldest.w)?.get(oldest.k)
      if (l) {
        const i = l.indexOf(oldest.s)
        if (i >= 0) l.splice(i, 1)
      }
    }
  }

  arr.push({
    msgId,
    team,
    target,
    watcher,
    at: new Date().toISOString(),
    expiresAt: Date.now() + SUBSCRIPTION_TTL_MS,
  })
  list.set(key, arr)
  idleSubscriptions.set(watcher, list)
  return { ok: true, count: arr.length }
}

/**
 * 某个 agent 空闲了 → 取出所有等它的订阅（一次性，取走即删）。
 *
 * 调用点：agent 一轮跑完后（agent.mjs 的 _notifyIdleSubscribers）。
 * 官方的 notify_when_idle 也是一次性的，不是持续监听。
 */
export function takeIdleSubscriptions(team, agentName) {
  const target = safeName(agentName)
  const key = subKey(team, target)
  const out = []
  const now = Date.now()
  for (const [watcher, list] of idleSubscriptions) {
    const arr = list.get(key)
    if (!arr || !arr.length) continue
    for (const s of arr) {
      if (s.expiresAt <= now) continue   // 过期静默丢弃
      out.push({ watcher, team, target, msgId: s.msgId })
    }
    list.delete(key)
    if (!list.size) idleSubscriptions.delete(watcher)
  }
  return out
}

/** 查看当前订阅表（「谁在等谁」），给 ListAgents / /team 展示。 */
export function listIdleSubscriptions() {
  const out = []
  const now = Date.now()
  for (const [watcher, list] of idleSubscriptions) {
    for (const arr of list.values()) {
      for (const s of arr) {
        if (s.expiresAt <= now) continue
        out.push({ ...s, watcher, expiresIn: Math.round((s.expiresAt - now) / 60000) })
      }
    }
  }
  return out
}

/** 清空订阅表（测试 / 会话重置用）。 */
export function clearIdleSubscriptions() { idleSubscriptions.clear() }

/**
 * 读取 inbox。默认只返回未读并标记已读（drain 语义），
 * peek=true 则不改 read 状态，用于旁观者查看。
 */
export function readInbox(team, agent, { unreadOnly = true, peek = false } = {}) {
  const path = inboxPath(team, agent)
  const box = readJson(path, [])
  const picked = unreadOnly ? box.filter(m => !m.read) : box
  if (!peek && picked.length) {
    for (const m of box) m.read = true
    atomicWrite(path, JSON.stringify(box, null, 2))
  }
  return picked
}

export function inboxCounts(team) {
  const dir = inboxDir(team)
  if (!existsSync(dir)) return {}
  const out = {}
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const agent = f.replace(/\.json$/, '')
    const box = readJson(join(dir, f), [])
    out[agent] = { total: box.length, unread: box.filter(m => !m.read).length }
  }
  return out
}

/** 解散团队。同时清掉对应的任务列表（Team = TaskList，不能只删一半）。 */
export function deleteTeam(team, { keepTasks = false } = {}) {
  if (!teamExists(team)) return { ok: false, reason: 'no_team' }
  const taskCount = listTasks(team).length
  try { rmSync(teamDir(team), { recursive: true, force: true }) } catch {}
  if (!keepTasks) resetTaskList(team)
  return { ok: true, removedTasks: keepTasks ? 0 : taskCount }
}

/** 团队全景：成员、状态、任务进度、未读数。给 /team 命令和 TeamStatus 工具共用。 */
export function teamOverview(team) {
  const cfg = getTeam(team)
  if (!cfg) return null
  const tasks = listTasks(team)
  const counts = inboxCounts(team)
  return {
    name: cfg.name,
    description: cfg.description,
    members: cfg.members.map(m => ({
      ...m,
      owned: tasks.filter(t => t.owner === m.name).length,
      unread: counts[m.name]?.unread || 0,
    })),
    tasks: {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
    },
  }
}

export function formatTeamOverview(ov) {
  if (!ov) return '(团队不存在)'
  const lines = [`团队 [${ov.name}]${ov.description ? ' — ' + ov.description : ''}`]
  lines.push(`任务: 共 ${ov.tasks.total} · 待办 ${ov.tasks.pending} · 进行中 ${ov.tasks.inProgress} · 完成 ${ov.tasks.completed}`)
  if (!ov.members.length) {
    lines.push('成员: (还没有成员加入)')
  } else {
    lines.push('成员:')
    for (const m of ov.members) {
      const badge = m.status === 'active' ? '●' : '○'
      const unread = m.unread ? ` ✉${m.unread}` : ''
      lines.push(`  ${badge} ${m.name}${m.role ? `（${m.role}）` : ''} 持有 ${m.owned} 个任务${unread}`)
    }
  }
  return lines.join('\n')
}
