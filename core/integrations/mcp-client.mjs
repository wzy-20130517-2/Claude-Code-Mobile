// Claude Code Mobile - MCP 客户端（多服务器，统一监听器）
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { preview as tracePreview } from '../api/trace.mjs'
import { Tool } from '../tools/tools.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerDynamicCommand, clearDynamicCommands } from '../commands/custom-commands.mjs'
import { MCP_PATH } from '../infra/paths.mjs'
// MCP 握手时上报的客户端版本。原来硬编码 '0.4.1'，主版本升到 0.7 都没人改，
// 直接从 package.json 读，一处维护。读不到就给个兜底值，不能让握手挂掉。
const PKG_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 单个 MCP 请求的超时。
 *
 * 【为什么从 30s 改到 10s】MCP 是本机 stdio 子进程，正常毫秒级返回。
 * 原来 30s 的超时在「子进程压根起不来」时会被完整等满 ——
 * 实测 /tools 因此卡 27 秒（buildAgent → await mcpReady → 两次 _request 超时）。
 * 现在子进程 error/close 会立刻 reject（见 failPending），
 * 这个定时器只兜「起来了但不响应」的极端情况。
 */
const MCP_REQUEST_TIMEOUT_MS = 10_000

export class MCPClient {
  constructor() {
    this.servers = new Map()
  }

  async loadConfig(path = MCP_PATH) {
    try {
      if (!existsSync(path)) return
      const cfg = JSON.parse(readFileSync(path, 'utf-8'))
      for (const [name, srv] of Object.entries(cfg.mcpServers || {})) {
        if (srv?.disabled === true) continue
        // 逐个 try：一个失败不影响其他的（CCM 里路径可能不匹配）
        try {
          await this.addServer(name, srv)
        } catch (e) {
          console.warn(`[mcp] 加载 "${name}" 失败（跳过）: ${e.message}`)
        }
      }
    } catch (e) {
      console.warn(`[mcp] 读配置失败: ${e.message}`)
    }
  }

  async addServer(name, config) {
    // 【容错】spawn 失败不能拖垮整个 MCP 加载。
    //
    // 场景：CCM 模式（proot Ubuntu）里，mcp.json 可能还指向 Termux 的绝对路径
    // （/data/data/com.termux/...），那些路径在 proot 里不存在 → spawn ENOENT。
    // 原来这个异常会冒泡到 loadConfig 的 try/catch，导致**后面的服务器全部跳过**。
    // 现在改成：单个失败只记日志，继续加载其他。
    let proc
    try {
      proc = spawn(config.command, config.args || [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      console.warn(`[mcp] 服务器 "${name}" 启动失败（跳过）: ${e.message}`)
      return null
    }

    // 命令不存在时 spawn 不抛异常，而是在 proc 上触发 error 事件
    proc.on('error', (e) => {
      console.warn(`[mcp] 服务器 "${name}" 进程错误: ${e.message}`)
    })

    const serverState = {
      proc,
      tools: [],
      prompts: [],
      config,
      buffer: '',
      requestId: 0,
      pending: new Map(),
    }

    // 统一监听器：所有请求共用一个 data 监听器
    proc.stdout.on('data', (chunk) => {
      serverState.buffer += chunk.toString()
      const lines = serverState.buffer.split('\n')
      serverState.buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && serverState.pending.has(msg.id)) {
            const { resolve, reject } = serverState.pending.get(msg.id)
            serverState.pending.delete(msg.id)
            if (msg.error) reject(new Error(msg.error.message || 'MCP error'))
            else resolve(msg.result)
          }
        } catch {}
      }
    })

    proc.stderr.on('data', () => {})

    // 【2026-09-24 修】原来这两行都是空吞：
    //   proc.on('error', () => {})
    //   proc.on('close', () => {})
    // 后果：command 不存在（如 CCM 里 mcp.json 写的 /usr/bin/node 在 proot 中
    // 路径不对）时 spawn 立刻 ENOENT、进程立刻 close，但**没有任何人 reject**，
    // 于是 _request 傻等 30 秒超时 —— 表现为「/tools 卡 27 秒」。
    // 实测：loadConfig 30216ms，而实际失败是**瞬间**发生的。
    const failPending = (reason) => {
      serverState.dead = reason
      for (const [id, { reject }] of serverState.pending) {
        try { reject(new Error(reason)) } catch {}
      }
      serverState.pending.clear()
    }
    proc.on('error', (e) => failPending(`MCP 进程启动失败: ${e?.message || e}`))
    proc.on('close', (code) => {
      if (!serverState.dead) failPending(`MCP 进程已退出（code ${code}）`)
    })

    this.servers.set(name, serverState)

    // 握手
    try {
      await this._request(serverState, 'initialize', {
        protocolVersion: '2024-11-05',
        // 声明 prompts 能力：MCP 规范里「客户端不声明，服务端可以不主动推送」。
        // 原来是空对象 `{}`，等于告诉服务端「我什么都不要」，某些 server 据此连
        // prompts/list 都懒得实现。对齐官方才能拿到可转成 slash 命令的 prompt。
        //
        // 【为什么不声明 resources】resources/list / resources/read CCM 没有实现，
        // 也没有对应工具。声明一个做不到的能力等于撒谎——服务端可能据此推资源，
        // 而客户端读不了。等真做了再加回来。
        capabilities: { prompts: {} },
        clientInfo: { name: 'claude-code-mobile', version: PKG_VERSION },
      })
      const result = await this._request(serverState, 'tools/list', {})
      serverState.tools = result.tools || []
    } catch {
      serverState.tools = []
    }

    // prompts/list —— 与 tools/list 分开 try：不支持 prompts 的 server
    // （实测 playwright / mail-qq / termux-notify 全部返回 "Method not found"）
    // 必须静默跳过，绝不能阻塞启动或让 tools 的加载也失败。
    try {
      const result = await this._request(serverState, 'prompts/list', {})
      serverState.prompts = Array.isArray(result.prompts) ? result.prompts : []
    } catch {
      serverState.prompts = []
    }
    this._syncPromptCommands()
    return serverState.tools
  }

  /**
   * 把当前所有 server 的 prompts 同步成 slash 命令。
   *
   * 【为什么放这里而不是 index.mjs】MCP 就绪的时机是异步的（后台加载），
   * 而命令清单在启动时就建好了。放这里可以让「加载 / 重连」两条路径
   * 自动走同一段逻辑。
   *
   * 【为什么动态 import】custom-commands 属于命令层；mcp-client 被 CLI 和
   * Web 共用。动态 import + 失败静默，保证注册失败不影响 MCP 工具本身可用。
   */
  _syncPromptCommands() {
    try {
      const prompts = this.getAllPrompts()
      if (!prompts.length) return
      // 清掉旧的 mcp_* 再重建：重连后 server 可能删了某个 prompt，
      // 不清就会留下一个点了报错的幽灵命令。
      clearDynamicCommands('mcp_')
      for (const p of prompts) {
        const argHint = p.arguments.length
          ? p.arguments.map(a => a.required ? `<${a.name}>` : `[${a.name}]`).join(' ')
          : ''
        registerDynamicCommand(p.name, {
          description: p.description,
          argumentHint: argHint,
          source: `mcp:${p.server}`,
          body: this._buildPromptBody(p, argHint),
        })
      }
    } catch {
      // 注册失败不影响 MCP 工具本身可用。
    }
  }

  /**
   * 生成命令的 body（展开后直接喂给模型的那段文本）。
   *
   * 末尾那行 `__CCM_MCP_PROMPT__ <server> <prompt> <参数行>` 是给执行分支
   * 识别的标记：认出它就先去 prompts/get 取真正的 messages，用返回值替换
   * 掉本段再交给 agent。没认出来也不致命 —— body 本身是人话说明，
   * 模型照字面也能理解这是个 MCP prompt，只是拿不到 server 端渲染后的正文。
   */
  _buildPromptBody(p, argHint) {
    const lines = [
      `（这是 MCP prompt "${p.rawName}"，来自 server "${p.server}"）`,
      p.description || p.rawName,
    ]
    if (p.arguments.length) {
      lines.push('')
      lines.push('参数：' + p.arguments.map(a =>
        `${a.name}${a.required ? '（必填）' : '（可选）'}${a.description ? `：${a.description}` : ''}`
      ).join('；'))
    }
    lines.push('')
    lines.push(`__CCM_MCP_PROMPT__ ${p.server} ${p.rawName} ${argHint}`)
    return lines.join('\n')
  }

  _request(serverState, method, params = {}) {
    // 进程已经死了就别发请求 —— 立刻失败，不要等超时。
    // 配合上面的 failPending，把「命令不存在」的失败从 30 秒压到毫秒级。
    if (serverState.dead) return Promise.reject(new Error(serverState.dead))

    const id = ++serverState.requestId
    return new Promise((resolve, reject) => {
      serverState.pending.set(id, { resolve, reject })
      try {
        serverState.proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id, method, params,
        }) + '\n')
      } catch (e) {
        serverState.pending.delete(id)
        return reject(new Error(`MCP 写入失败: ${e?.message || e}`))
      }
      setTimeout(() => {
        if (serverState.pending.has(id)) {
          serverState.pending.delete(id)
          reject(new Error(`MCP 请求超时（${MCP_REQUEST_TIMEOUT_MS}ms）: ${method}`))
        }
      }, MCP_REQUEST_TIMEOUT_MS).unref?.()
    })
  }

  getAllTools() {
    const all = []
    for (const [name, srv] of this.servers) {
      for (const tool of srv.tools) {
        all.push({
          name: `mcp_${name}_${tool.name}`,
          description: `[MCP:${name}] ${tool.description || ''}`,
          // 兜底必须是「合法的 object schema」而非 `{}`：Gemini 系后端要求
          // type:'object' 必带 properties，否则整个请求 400（见 api.mjs normalizeToolSchema）。
          // api 层还有一道统一规整，这里先保证 registry 里的定义本身是干净的。
          input_schema: tool.inputSchema || { type: 'object', properties: {} },
          mcpServer: name,
          mcpTool: tool.name,
        })
      }
    }
    return all
  }

  createToolAdapters() {
    return this.getAllTools().map((definition) => {
      const client = this
      const adapter = new Tool({
        name: definition.name,
        description: definition.description,
        input_schema: definition.input_schema,
        isReadOnly: () => true,
        isConcurrencySafe: () => false,
      })
      adapter.mcpServer = definition.mcpServer
      adapter.mcpTool = definition.mcpTool
      adapter.execute = async (input, ctx = {}) => {
        if (ctx.signal?.aborted) throw new Error('Interrupted')
        const result = await client.callTool(definition.mcpServer, definition.mcpTool, input, adapter._activeTrace || null)
        return JSON.stringify(result)
      }
      return adapter
    })
  }

  /**
   * 所有 server 的 prompts 清单（扁平化，带 CCM 侧命令名）。
   *
   * 命名 `mcp_<server>_<prompt>`：MCP 的 prompt 名只有 server 内唯一，
   * 直接当 slash 命令会撞用户自己的 /xxx，也分不出来自哪个 server。
   * 名字里的非法字符（空格、/）换成 _，避免进补全列表后看起来像个路径。
   */
  getAllPrompts() {
    const all = []
    for (const [name, srv] of this.servers) {
      for (const p of srv.prompts || []) {
        const raw = String(p.name || '').trim()
        if (!raw) continue
        all.push({
          name: `mcp_${name}_${raw}`.replace(/[^A-Za-z0-9_-]/g, '_'),
          rawName: raw,
          server: name,
          description: `[MCP:${name}] ${p.description || p.title || raw}`,
          arguments: Array.isArray(p.arguments) ? p.arguments : [],
        })
      }
    }
    return all
  }

  /**
   * 展开一条 MCP prompt 命令：认出 body 里的标记就去 prompts/get 取正文。
   *
   * 【给谁用】自定义命令的执行分支（index.mjs 的 customCommands.has 那段）。
   * 那边现在是「expand 出什么就 processInput 什么」，对 MCP prompt 而言
   * 拿到的是**说明文字**而不是 server 渲染后的正文。接入方式是一行：
   *
   *   const expanded = customCommands.expand(name, args.join(' '))
   *   const body = await mcpClient.expandMcpPrompt(expanded, args.join(' '))  // ← 新增
   *   return processInput(body)
   *
   * expandMcpPrompt 对非 MCP 命令（返回体里没有标记）原样返回 content，
   * 所以那行是无条件安全的。
   *
   * @param {object} expanded  customCommands.expand() 的返回值
   * @param {string} argsText  用户敲的原始参数（空格分隔）
   * @returns {Promise<string>} 可直接喂给 processInput 的文本
   */
  async expandMcpPrompt(expanded, argsText = '') {
    if (!expanded || typeof expanded.content !== 'string') return expanded?.content ?? ''
    const marker = expanded.content.match(/^__CCM_MCP_PROMPT__\s+(\S+)\s+(\S+)\s*(.*)$/m)
    if (!marker) return expanded.content
    const [, server, promptName, argSpec] = marker
    const args = this._parsePromptArgs(argSpec, argsText)
    try {
      const { text } = await this.getPrompt(server, promptName, args)
      return text
    } catch (e) {
      return `MCP prompt 执行失败（${server}/${promptName}）：${e?.message || e}\n\n`
        + `原始说明：\n${expanded.content.replace(/^__CCM_MCP_PROMPT__.*$/m, '').trim()}`
    }
  }

  /**
   * 从参数行 + 用户输入推出 prompts/get 的 arguments 对象。
   *
   * 用户输入是空格分隔的一串值，按 prompt 定义的参数顺序对位；
   * 值比参数少时只填前面的，其余留空字符串由 server 端兜。
   * 不按 `<name> value` 显式解析：终端里敲 `/mcp_x_y a b c` 更自然，
   * 而 MCP 的 arguments 本来就是按 prompts/list 的顺序约定的。
   */
  _parsePromptArgs(argSpec, argsText) {
    const names = String(argSpec || '').match(/[<[]([A-Za-z0-9_-]+)[>\]]/g)?.map(s => s.slice(1, -1)) || []
    if (!names.length) return {}
    const values = String(argsText || '').trim() ? String(argsText).trim().split(/\s+/) : []
    const args = {}
    names.forEach((n, i) => { args[n] = values[i] ?? '' })
    return args
  }

  /**
   * 执行一个 MCP prompt：调 prompts/get，把返回的 messages 拍平成一段文本。
   *
   * 【为什么拍平成文本而不是原样注入结构化消息】MCP 的 messages 是
   * {role, content:{type,text}} 数组，CCM 的命令展开机制最终走的是一条
   * user message（见 custom-commands.expand → processInput）。
   * 在这里保持「文本」，接入点才只有一处；多模态的 MCP content（image/audio）
   * 本工具不支持，跳过并留下说明，别静默丢。
   */
  async getPrompt(serverName, promptName, args = {}) {
    const srv = this.servers.get(serverName)
    if (!srv) throw new Error(`Server ${serverName} not found`)
    const result = await this._request(srv, 'prompts/get', {
      name: promptName,
      arguments: args && typeof args === 'object' ? args : {},
    })
    const messages = Array.isArray(result.messages) ? result.messages : []
    if (!messages.length) {
      return { text: result.description || `(MCP prompt "${promptName}" 没有返回任何消息)`, description: result.description || '' }
    }
    const parts = []
    let skipped = 0
    for (const m of messages) {
      const c = m?.content
      if (typeof c === 'string') { parts.push(c); continue }
      if (c?.type === 'text' && typeof c.text === 'string') { parts.push(c.text); continue }
      skipped++
    }
    if (!parts.length) {
      return {
        text: `MCP prompt "${promptName}" 返回的 ${messages.length} 条消息全是本客户端不支持的类型（image/audio/resource），无法展开。`,
        description: result.description || '',
      }
    }
    let text = parts.join('\n\n')
    if (skipped > 0) text += `\n\n（另有 ${skipped} 条消息是不支持的类型，已跳过）`
    return { text, description: result.description || '' }
  }

  async callTool(serverName, toolName, args, trace = null) {
    const srv = this.servers.get(serverName)
    if (!srv) throw new Error(`Server ${serverName} not found`)
    const startedAt = Date.now()
    trace?.emit('mcp_call_start', { server: serverName, tool: toolName, arguments: args })
    try {
      const result = await this._request(srv, 'tools/call', { name: toolName, arguments: args })
      trace?.emit('mcp_call_result', { server: serverName, tool: toolName, duration_ms: Date.now() - startedAt, result: tracePreview(result, 500) })
      return result
    } catch (e) {
      trace?.emit('mcp_call_error', { server: serverName, tool: toolName, duration_ms: Date.now() - startedAt, error: e?.message || String(e) })
      throw e
    }
  }

  async stopAll() {
    for (const [, srv] of this.servers) {
      try { srv.proc.kill() } catch {}
    }
    this.servers.clear()
  }
}
