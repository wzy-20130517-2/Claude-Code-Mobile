// 跨会话发现与投递：让同一台机器上的多个 CCM 会话互相看见、互相发消息。
//
// ── 为什么需要这一层 ────────────────────────────────────────────────
// CCM 不是单进程：CLI（index.mjs）和 Web（web/server.mjs）是两个独立的
// Node 进程，各有自己的会话目录（`~/.claude-code-mobile/sessions/` 与
// `web-sessions/`）。它们之间完全不通 —— Web 端跑着一个会话，CLI 里的
// Agent 根本不知道它存在，`ListAgents` 也只列本进程的子 Agent。
//
// ── 为什么不做 UDS ─────────────────────────────────────────────────
// 官方用 Unix domain socket 做实时投递（claude.js:1076708 的 run4920）。
// 官方需要实时，是因为它的会话可能是「另一个终端里的交互式会话」，人正在
// 那边等回复。CCM 的场景不同：Agent 是**回合制**的 —— 一轮跑完才读消息，
// 跑的过程中根本没有「接收」这个动作。给一个不会实时消费的对端建 socket，
// 换来的是：socket 生命周期管理 + token 鉴权 + 路径长度限制（108 字节）
// + Android 后台进程被杀的半开连接清理。这些成本换不来任何用户可见的收益。
//
// 所以这里用**文件队列**，与 teams.mjs 的 mailbox 同一套思路：
//   · 投递 = 往对方会话目录写一个 inbox 文件
//   · 接收 = 对方每轮开始时读一次（agent.mjs 的注入点已经存在）
//   · 存活 = 注册表里的 pid + procStart，读的时候探活
// 零新增依赖、进程崩溃不会留半开连接、Termux 上不存在 socket 路径问题。
//
// ── 与 teams.mjs 的分工 ────────────────────────────────────────────
//   teams.mjs   = 同一进程内的团队协作（成员是 Agent 逻辑身份）
//   sessions.mjs = 跨进程的会话通信（成员是操作系统进程里的会话）
// 两者都用文件队列，但目录和语义不同，不要混。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWrite } from '../infra/atomic.mjs'

const DATA_DIR = join(homedir(), '.claude-code-mobile')
const REGISTRY_DIR = join(DATA_DIR, 'peer-sessions')
const PEER_INBOX_DIR = join(DATA_DIR, 'peer-inbox')

/** 单个会话的 inbox 消息上限。跨进程消息比团队消息更难得，留大一点。 */
const MAX_PEER_MESSAGES = 100

/** 注册表条目多久没心跳就认为过期（毫秒）。10 分钟 —— 会话空闲时也会心跳。 */
const STALE_MS = 10 * 60 * 1000

/**
 * 本进程的会话身份。一个 Node 进程只登记一次（CLI 是一个，Web 是一个），
 * 进程内的多个会话（Web 端可以同时开多个）靠 sessionId 区分。
 */
let _self = null

function safeId(s) {
  return String(s || '').replace(/[^\w.\-]/g, '_').slice(0, 64)
}

function registryPath(pid) { return join(REGISTRY_DIR, `${pid}.json`) }
function inboxPath(pid, sessionId) { return join(PEER_INBOX_DIR, `${pid}__${safeId(sessionId)}.json`) }

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return fallback }
}

/**
 * 读进程启动时间（jiffies），用于防 PID 复用。
 *
 * 为什么要它：PID 会被系统回收。一个 10 分钟前退出的进程留下的注册表条目，
 * 如果它的 PID 恰好被一个新进程占用，`process.kill(pid, 0)` 会返回成功 ——
 * 于是我们以为「那个会话还活着」，把消息投进一个没人读的 inbox。
 * 比对启动时间能识别这种情况：同一个 PID 但启动时间不同 = 不是同一个进程。
 *
 * Termux 有 /proc。取不到（权限/平台差异）时返回 null，退化成只靠 kill 探活。
 */
function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // 格式：pid (comm) state ppid ... —— comm 里可能有空格和括号，
    // 所以从最后一个 ')' 之后开始切，第 22 字段（从 1 数）是 starttime。
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // tail[0] = state（原第 3 字段）→ starttime 是原第 22 字段 → tail[19]
    const v = tail[19]
    return v ? Number(v) : null
  } catch {
    return null
  }
}

/**
 * 登记本进程会话。进程退出时自动清理（process.on('exit')）。
 *
 * 幂等：重复调用只更新心跳和会话信息，不重复注册退出钩子。
 *
 * @param {object} opts
 * @param {string} opts.kind         'cli' | 'web' | 'other'
 * @param {string} opts.sessionId    当前会话 id（会随 /new /resume 变化，所以支持更新）
 * @param {string} [opts.cwd]        工作目录
 * @param {string} [opts.name]       给这个会话起的名字（默认用 sessionId 前缀）
 * @param {string} [opts.permissionMode] 当前权限模式（用于投递权限判定）
 */
export function registerSession({ kind = 'other', sessionId = null, cwd = null, name = null, permissionMode = null } = {}) {
  if (!_self) {
    _self = {
      pid: process.pid,
      kind,
      sessionId,
      cwd: cwd || process.cwd(),
      name: name || null,
      permissionMode,
      startedAt: new Date().toISOString(),
      procStart: procStartTime(process.pid),
      peerFeatures: ['notify_idle', 'file_queue'],
      registered: false,
    }
    // 退出时删掉自己的注册表条目。用 'exit' 而不是 SIGINT/SIGTERM：
    // 后者在 Termux 上不一定触发（进程被系统杀掉时收不到信号）。
    process.on('exit', () => {
      try { rmSync(registryPath(process.pid), { force: true }) } catch {}
    })
  } else {
    // 更新可变字段（/new /resume 会换 sessionId，/permissions 会换 mode）
    if (sessionId !== undefined) _self.sessionId = sessionId
    if (name !== undefined) _self.name = name
    if (permissionMode !== undefined) _self.permissionMode = permissionMode
    if (cwd) _self.cwd = cwd
  }
  writeSelf()
  return _self
}

/** 心跳 + 落盘。会话切换 / 每轮开始时调一次。 */
export function heartbeat() {
  if (!_self) return
  writeSelf()
}

function writeSelf() {
  if (!_self) return
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 })
    const rec = {
      pid: _self.pid,
      kind: _self.kind,
      sessionId: _self.sessionId,
      cwd: _self.cwd,
      name: _self.name,
      permissionMode: _self.permissionMode,
      startedAt: _self.startedAt,
      procStart: _self.procStart,
      lastSeen: new Date().toISOString(),
      peerProtocol: 1,
      peerFeatures: _self.peerFeatures,
      version: readVersion(),
    }
    atomicWrite(registryPath(_self.pid), JSON.stringify(rec, null, 2))
  } catch {}
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'))
    return pkg.version || 'unknown'
  } catch { return 'unknown' }
}

export function getSelf() { return _self }

/**
 * 探活：这个注册表条目对应的进程还在吗？
 *
 * 三重判定，缺一不可：
 *   1. `process.kill(pid, 0)` 不抛错 → 进程存在（EPERM 也算存在：是别人的进程）
 *   2. procStart 对得上 → 不是 PID 复用
 *   3. lastSeen 没过期 → 不是卡死的僵尸
 *
 * 第 3 条单独看会误判（长任务期间没心跳），但配合前两条就够了 ——
 * 前两条确认进程真的在，第 3 条只是兜底「进程活着但会话已死」的极端情况。
 */
export function isAlive(rec) {
  if (!rec || !rec.pid) return false
  try {
    process.kill(rec.pid, 0)
  } catch (e) {
    if (e.code !== 'EPERM') return false
  }
  // PID 复用检查：两边都拿得到才比
  if (rec.procStart != null) {
    const now = procStartTime(rec.pid)
    if (now != null && now !== rec.procStart) return false
  }
  if (rec.lastSeen) {
    const age = Date.now() - new Date(rec.lastSeen).getTime()
    if (Number.isFinite(age) && age > STALE_MS) return false
  }
  return true
}

/**
 * 列出所有**存活**的对端会话（不含自己）。
 *
 * 顺手清理过期条目：读到 pid 已死或过期的，直接删文件。
 * 为什么在读路径里清理而不是单独跑 GC：CCM 没有常驻调度器，
 * 单独 GC 要么靠 cron 要么靠定时器，两者都会在空闲时白跑。读时清理
 * 是「谁用谁维护」，成本摊在真正需要的时刻。
 */
export function listPeerSessions({ includeSelf = false, includeDead = false } = {}) {
  if (!existsSync(REGISTRY_DIR)) return []
  const out = []
  let files = []
  try { files = readdirSync(REGISTRY_DIR) } catch { return [] }
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue
    const full = join(REGISTRY_DIR, f)
    const rec = readJson(full, null)
    if (!rec || !rec.pid) continue
    const alive = isAlive(rec)
    if (!alive && !includeDead) {
      try { rmSync(full, { force: true }) } catch {}
      continue
    }
    if (!includeSelf && rec.pid === process.pid) continue
    out.push({ ...rec, alive })
  }
  // 最近的在前
  out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
  return out
}

/**
 * 按名字或 sessionId 找对端会话。
 *
 * 名字解析顺序（对齐官方「in-process 优先」的思路，但这里没有 in-process）：
 *   1. sessionId 精确匹配
 *   2. name 精确匹配（大小写不敏感）
 *   3. name 前缀匹配（唯一时才算命中，多义就报错让调用方消歧）
 */
export function resolvePeer(target) {
  const t = String(target || '').trim()
  if (!t) return { ok: false, reason: 'empty_target' }
  const peers = listPeerSessions()
  const exact = peers.find(p => p.sessionId === t)
  if (exact) return { ok: true, peer: exact }
  const low = t.toLowerCase()
  const byName = peers.filter(p => String(p.name || '').toLowerCase() === low)
  if (byName.length === 1) return { ok: true, peer: byName[0] }
  if (byName.length > 1) return { ok: false, reason: 'ambiguous', candidates: byName }
  const byPrefix = peers.filter(p => String(p.name || '').toLowerCase().startsWith(low)
    || String(p.sessionId || '').toLowerCase().startsWith(low))
  if (byPrefix.length === 1) return { ok: true, peer: byPrefix[0] }
  if (byPrefix.length > 1) return { ok: false, reason: 'ambiguous', candidates: byPrefix }
  return { ok: false, reason: 'not_found', available: peers.map(p => p.name || p.sessionId) }
}

// ── 投递权限（crossSessionInbound 三档） ────────────────────────────

/**
 * 投递策略。对齐官方 `crossSessionInbound`（claude.js:56128）的三档，
 * 但简化为 config.json 里的单值（CCM 没有 settings 分层，见
 * audit-crosssession 3.4「可以砍掉的部分」）。
 *
 *   accept  —— 直接投递（默认）
 *   hold    —— 收下但**不进模型上下文**，等用户放行
 *   refuse  —— 直接拒收
 *
 * 未显式设置时按「权限模式对等」判定（官方 mode parity）：
 * 发送方与接收方同属「放开」或同属「需确认」才自动投递，否则 hold。
 * 这样 bypassPermissions 的会话不会被另一个 default 会话悄悄塞指令。
 */
export const INBOUND_MODES = { accept: 0, hold: 1, refuse: 2 }

function modeClass(mode) {
  const m = String(mode || '').toLowerCase()
  if (m === 'bypasspermissions' || m === 'bypass' || m === 'acceptedits') return 'open'
  return 'prompting'
}

/**
 * 判定一条跨会话消息该不该投递。
 *
 * @returns {{ action: 'accept'|'hold'|'refuse', reason: string }}
 */
export function resolveInbound({ configured = null, senderMode = null, receiverMode = null } = {}) {
  const explicit = String(configured || '').toLowerCase()
  if (explicit === 'accept' || explicit === 'hold' || explicit === 'refuse') {
    return { action: explicit, reason: 'explicit' }
  }
  // mode parity
  const s = modeClass(senderMode)
  const r = modeClass(receiverMode)
  if (s === r) return { action: 'accept', reason: 'mode_parity' }
  // 发送方没声明权限模式：只在接收方不放开的场景下 hold
  if (!senderMode) {
    return r === 'open'
      ? { action: 'hold', reason: 'sender_unknown_class_receiver_open' }
      : { action: 'accept', reason: 'sender_unknown_class' }
  }
  return { action: 'hold', reason: 'mode_mismatch' }
}

// ── 投递 ────────────────────────────────────────────────────────────

/**
 * 往对端会话的 inbox 投一条消息。
 *
 * 注意这里是**写文件**，对端进程下次读 inbox 时才会看到 ——
 * 这是回合制模型的固有延迟，不是缺陷（见文件头注释）。
 */
export function sendToPeer(peer, { from, fromPid = process.pid, text, summary = '', kind = 'text', notifyWhenIdle = false }) {
  if (!peer || !peer.pid) return { ok: false, reason: 'no_peer' }
  if (peer.pid === process.pid) return { ok: false, reason: 'self_target' }
  if (!isAlive(peer)) return { ok: false, reason: 'peer_gone' }
  try {
    mkdirSync(PEER_INBOX_DIR, { recursive: true, mode: 0o700 })
    const path = inboxPath(peer.pid, peer.sessionId || 'default')
    const box = readJson(path, [])
    box.push({
      from: String(from || 'unknown'),
      fromPid,
      toPid: peer.pid,
      toSession: peer.sessionId || null,
      kind,
      text: String(text || ''),
      summary: String(summary || '').slice(0, 80),
      timestamp: new Date().toISOString(),
      read: false,
      notifyWhenIdle: !!notifyWhenIdle,
    })
    const trimmed = box.length > MAX_PEER_MESSAGES ? box.slice(-MAX_PEER_MESSAGES) : box
    atomicWrite(path, JSON.stringify(trimmed, null, 2))
    return { ok: true, queued: trimmed.length, pid: peer.pid }
  } catch (e) {
    return { ok: false, reason: 'write_failed', error: e?.message || String(e) }
  }
}

/**
 * 读本会话的跨进程 inbox。
 *
 * 语义与 teams.readInbox 一致：默认只返回未读并标记已读。
 */
export function readPeerInbox({ sessionId = null, unreadOnly = true, peek = false } = {}) {
  const sid = sessionId || _self?.sessionId || 'default'
  const path = inboxPath(process.pid, sid)
  const box = readJson(path, [])
  const picked = unreadOnly ? box.filter(m => !m.read) : box
  if (!peek && picked.length) {
    for (const m of box) m.read = true
    try { atomicWrite(path, JSON.stringify(box, null, 2)) } catch {}
  }
  return picked
}

/** 清空本会话的跨进程 inbox（用户 /clear 或显式清理时用）。 */
export function clearPeerInbox({ sessionId = null } = {}) {
  const sid = sessionId || _self?.sessionId || 'default'
  try { rmSync(inboxPath(process.pid, sid), { force: true }) } catch {}
}

/**
 * hold 缓冲：被策略拦下的消息**不进模型上下文**，只进这里等用户放行。
 *
 * 【关键设计】绝不能 push 进 agent.messages —— 那等于「投递了」，
 * 安全边界就没了。官方也是这么做的（audit-crosssession 四.3 原文：
 * 「hold 的价值在于『结构上不进模型上下文』，不是靠提示词」）。
 */
const heldMessages = []
const MAX_HELD = 100

export function holdMessage(msg) {
  heldMessages.push({ ...msg, heldAt: new Date().toISOString() })
  if (heldMessages.length > MAX_HELD) heldMessages.shift()
  return heldMessages.length
}

export function listHeld() { return [...heldMessages] }

export function releaseHeld(index) {
  if (index == null) {
    const all = heldMessages.splice(0, heldMessages.length)
    return all
  }
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= heldMessages.length) return []
  return heldMessages.splice(i, 1)
}

export function clearHeld() { heldMessages.length = 0 }
