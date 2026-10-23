// 跨会话工具：把 core/agent/sessions.mjs 的注册表/投递能力暴露给 Agent。
//
// 与 SendMessage 的分工：
//   SendMessage    = 本进程内的队友与子 Agent（团队 inbox / wake 唤醒）
//   SendMessagePeer = 另一台进程里的会话（CLI ↔ Web，文件队列投递）
//
// 为什么不合并成一个 SendMessage：两者的失败模式完全不同。团队消息的
// "对方不存在" 是名字写错；跨会话的 "对方不存在" 可能是那个进程退出了。
// 合成一个工具，模型拿到一句「没有这个名字」时不知道该改名字还是该
// 换个会话 —— 分开之后错误信息能直接指向原因。

import { Tool } from './tools.mjs'
import {
  listPeerSessions, resolvePeer, sendToPeer, resolveInbound,
  listHeld, releaseHeld, clearHeld, getSelf, holdMessage,
} from '../agent/sessions.mjs'

const peerProp = {
  type: 'string',
  description: '目标会话：sessionId 全串、会话名，或名字前缀（唯一时才算命中）。用 ListSessions 查看有哪些',
}

/**
 * 本机其他会话列表。
 *
 * 对应官方 ListAgents 的「other local Claude sessions on this machine」那一节
 *（claude.js:393089 的 str3162）。CCM 的 ListAgents 只列本进程的子 Agent 和
 * 团队成员 —— 官方能力范围差一个量级，这个工具补上跨进程那一半。
 */
export class ListSessionsTool extends Tool {
  constructor() {
    super({
      name: 'ListSessions',
      description: '列出本机**其他 CCM 进程**里的会话（CLI ↔ Web 互见），以及它们的名字、工作目录、存活状态。'
        + '这些会话可以用 SendMessagePeer 发消息。本进程内的子 Agent 和团队成员不在这里，用 ListAgents 看。',
      input_schema: {
        type: 'object',
        properties: {
          include_dead: {
            type: 'boolean',
            description: '可选：连已退出（但注册表条目还在）的会话也列出来，用于排查「为什么发不过去」',
          },
        },
        required: [],
      },
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      searchHint: 'list other ccm sessions on this machine',
      backgrounding: 'never',
      maxResultSizeChars: 6000,
    })
  }

  async execute(input = {}) {
    const self = getSelf()
    const peers = listPeerSessions({ includeDead: !!input.include_dead })

    const lines = []
    if (self) {
      lines.push(`本会话：pid ${self.pid} · ${self.kind} · ${self.sessionId || '(无 id)'} · ${self.cwd}`)
    }

    if (!peers.length) {
      lines.push('', '没有其他存活会话。')
      lines.push('（CLI 和 Web 是两个独立进程；两边都跑着的时候才互相可见。）')
      return lines.join('\n')
    }

    lines.push('', `其他会话（${peers.length}）— 用 SendMessagePeer(peer:"名字") 发消息：`)
    for (const p of peers) {
      const badge = p.alive ? '●' : '○'
      const who = p.name || p.sessionId || `pid:${p.pid}`
      const seen = p.lastSeen ? String(p.lastSeen).slice(11, 19) : '?'
      const mode = p.permissionMode ? ` · ${p.permissionMode}` : ''
      lines.push(`  ${badge} ${who}  [${p.kind}]  pid ${p.pid}${mode}  ${p.cwd || ''}`)
      lines.push(`      sessionId: ${p.sessionId || '(无)'} · 最后活跃 ${seen}${p.alive ? '' : ' · 已退出'}`)
    }

    const held = listHeld()
    if (held.length) {
      lines.push('', `⚠ 有 ${held.length} 条被 hold 的跨会话消息（未进上下文，需放行）：用 ReleaseHeldMessages 查看/放行。`)
    }

    return lines.join('\n')
  }
}

/**
 * 给另一个 CCM 进程里的会话发消息。
 *
 * 投递是文件队列 + 1 秒轮询（index.mjs 的 startPeerPolling，对齐官方 InboxPoller）：
 *   · 对方空闲 → 最多 1 秒内被唤醒，这一轮开头就读到
 *   · 对方正在跑 → 跑完当前轮、下一轮开头读到
 * 所以不是"必须等对方自己再开口"—— 空闲会话会被主动叫醒。
 */
export class SendMessagePeerTool extends Tool {
  constructor() {
    super({
      name: 'SendMessagePeer',
      description: '给本机另一个 CCM 进程里的会话发消息（CLI ↔ Web）。'
        + '【送达时机】对方空闲时最多 1 秒内被唤醒读到；对方正在跑则等它当前轮结束。'
        + '不是"要等对方自己再说话"——空闲会话会被主动叫醒。'
        + '【与 SendMessage 的区别】SendMessage 发给本进程的队友/子 Agent；这个发给另一个进程的会话。'
        + '不确定对方叫什么 → 先 ListSessions。',
      input_schema: {
        type: 'object',
        properties: {
          peer: peerProp,
          // 官方字段名是 recipient，这里同时收
          recipient: { type: 'string', description: '（等价于 peer）目标会话。与 peer 二选一，同时给时以 peer 为准。' },
          text: { type: 'string', description: '完整消息内容。对方看不到你的对话历史，写清上下文。' },
          content: { type: 'string', description: '（等价于 text）完整消息内容。' },
          summary: { type: 'string', description: '可选：一行摘要（给人看预览，10 字内）' },
          notify_when_idle: {
            type: 'boolean',
            description: '可选：对方当前忙时，等它这一轮结束再提醒你。跨进程场景下这个标记目前只写进消息体（跨进程订阅表尚未实现），传了不会报错但没有通知效果。',
          },
        },
        required: [],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      searchHint: 'send a message to another ccm session on this machine',
      backgrounding: 'never',
      maxResultSizeChars: 3000,
      coerceInput(input) {
        if (!input || typeof input !== 'object') return null
        const peer = input.peer ?? input.recipient
        const text = input.text ?? input.content
        const needPeer = peer !== undefined && peer !== input.peer
        const needText = text !== undefined && text !== input.text
        if (!needPeer && !needText) return null
        const out = { ...input }
        if (needPeer) out.peer = peer
        if (needText) out.text = text
        return out
      },
      validateInput(input) {
        const errors = []
        if (!input.peer) errors.push('需要目标会话：peer（或 recipient）')
        if (!input.text || !String(input.text).trim()) errors.push('需要消息内容：text（或 content）')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input) {
    const r = resolvePeer(input.peer)
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return `「${input.peer}」匹配到多个会话，请写全名或 sessionId：\n`
          + r.candidates.map(p => `  · ${p.name || '(无名)'}  sessionId=${p.sessionId}  pid=${p.pid}`).join('\n')
      }
      if (r.reason === 'not_found') {
        return `没有找到会话「${input.peer}」。\n`
          + (r.available?.length ? `当前存活会话：${r.available.join(', ')}\n` : '当前没有其他存活会话。\n')
          + '提示：CLI 和 Web 是两个独立进程，两边都跑着才互相可见。用 ListSessions 确认。'
      }
      return `发送失败：${r.reason}`
    }

    const peer = r.peer
    const self = getSelf()
    // 投递权限判定（crossSessionInbound）。用发送端自己的权限模式与对方比对。
    const policy = resolveInbound({
      configured: process.env.CCM_CROSS_SESSION_INBOUND || null,
      senderMode: self?.permissionMode || null,
      receiverMode: peer.permissionMode || null,
    })
    if (policy.action === 'refuse') {
      return `已被投递策略拒绝（refuse）：本会话配置为不接受跨会话消息。`
        + `\n如需放开，设环境变量 CCM_CROSS_SESSION_INBOUND=accept 或 hold。`
    }
    if (policy.action === 'hold') {
      // 【hold 不是丢弃】官方 crossSessionInbound 的 hold 语义是
      //「收下但停在这儿等你审」（claude.js:56128 原文：`'hold' parks them for
      // your review without letting Claude act`）。
      // 所以这里必须真的存下来，只是**不进模型上下文** ——
      // 存进独立数组而不是 agent.messages，这正是安全边界所在
      //（audit-crosssession 四.3：「hold 的价值在于结构上不进模型上下文，
      //  不是靠提示词」）。
      holdMessage({
        from: self?.name || self?.sessionId || `pid:${process.pid}`,
        fromPid: process.pid,
        toPid: peer.pid,
        text: input.text,
        summary: input.summary || '',
        reason: policy.reason,
        peerName: peer.name || peer.sessionId,
      })
      return `消息未投递，已 hold 住（原因：${policy.reason}）。`
        + `\n对方权限模式（${peer.permissionMode || '未声明'}）与本会话不匹配，按 mode parity 规则需要人工放行。`
        + `\n这条消息**没有进任何人的上下文**，等你自己用 ReleaseHeldMessages 决定怎么处理。`
    }

    const sent = sendToPeer(peer, {
      from: self?.name || self?.sessionId || `pid:${process.pid}`,
      fromPid: process.pid,
      text: input.text,
      summary: input.summary || '',
      notifyWhenIdle: !!input.notify_when_idle,
    })
    if (!sent.ok) {
      const why = {
        peer_gone: '对方进程已经退出了（注册表条目还在，但探活失败）',
        self_target: '不能给自己发消息',
        write_failed: `写 inbox 失败：${sent.error || '未知错误'}`,
        no_peer: '没有可投递的目标',
      }
      return `发送失败：${why[sent.reason] || sent.reason}`
    }
    return `已投递给会话「${peer.name || peer.sessionId}」（pid ${peer.pid}，inbox 现有 ${sent.queued} 条）。`
      + `\n（对方空闲时最多 1 秒内被唤醒读到；正在跑则等它当前轮结束）`
  }
}

/**
 * 查看 / 放行被 hold 的跨会话消息。
 *
 * hold 的意义在于「结构上不进模型上下文」—— 这些消息存在独立数组里，
 * 绝不 push 进 agent.messages。所以必须有一个显式的放行动作，
 * 否则它们等于永久丢弃。
 */
export class ReleaseHeldMessagesTool extends Tool {
  constructor() {
    super({
      name: 'ReleaseHeldMessages',
      description: '查看或放行被投递策略 hold 住的跨会话消息。'
        + 'hold 的消息**没有进你的上下文**（这是安全边界，不是遗漏），要读它们必须显式放行。'
        + '不带参数 = 列出所有 held 消息；带 index = 放行那一条（内容返回给你）；release_all=true = 全部放行。',
      input_schema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '要放行的消息序号（从 0 开始，见列表输出）' },
          release_all: { type: 'boolean', description: 'true = 放行全部 held 消息' },
        },
        required: [],
      },
      isReadOnly: () => false,
      isDestructive: () => false,
      isConcurrencySafe: () => false,
      searchHint: 'review or release held cross-session messages',
      backgrounding: 'never',
      maxResultSizeChars: 8000,
    })
  }

  /**
   * 放行 = 把内容交给调用方（模型）读。
   *
   * 这里**故意不 push 进 agent.messages**：工具返回值本来就会作为 tool_result
   * 进入下一轮上下文，那已经够了。再额外 push 一条 user 消息会让同一段内容
   * 在历史里出现两次 —— 而且模型会以为是「用户刚发来的新指令」，
   * 而它实际是「我之前 hold 的一条跨会话消息」。语义错位比重复更糟。
   */
  async execute(input = {}) {
    if (input.release_all) {
      const all = releaseHeld()
      if (!all.length) return '没有 held 消息可放行。'
      return `已放行 ${all.length} 条：\n\n` + all.map(formatHeld).join('\n\n')
    }
    if (input.index !== undefined && input.index !== null) {
      const got = releaseHeld(input.index)
      if (!got.length) return `没有序号为 ${input.index} 的 held 消息（用不带参数的调用看列表）。`
      return `已放行：\n\n${formatHeld(got[0])}`
    }
    const held = listHeld()
    if (!held.length) return '当前没有被 hold 的跨会话消息。'
    return `被 hold 的跨会话消息（${held.length} 条，均未进上下文）：\n\n`
      + held.map((m, i) => `[${i}] ` + formatHeld(m)).join('\n\n')
      + '\n\n用 ReleaseHeldMessages(index:N) 放行单条，或 release_all:true 全部放行。'
  }
}

function formatHeld(m) {
  const who = m.from || `pid:${m.fromPid || '?'}`
  const when = String(m.heldAt || m.timestamp || '').slice(5, 16).replace('T', ' ')
  return `【${who} · ${when}】${m.summary ? m.summary + '\n' : ''}${String(m.text || '')}`
}

export const SESSION_TOOLS = [
  new ListSessionsTool(),
  new SendMessagePeerTool(),
  new ReleaseHeldMessagesTool(),
]
