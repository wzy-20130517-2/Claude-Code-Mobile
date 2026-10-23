// Claude Code Mobile - Hook 系统
//
// 支持事件：
//   SessionStart, SessionEnd, UserPromptSubmit,
//   PreToolUse, PostToolUse, PostToolUseFailure,   ← 后两个互斥（成功/失败）
//   PermissionDenied,                             ← 权限拒绝 / PreToolUse deny（观察类）
//   PreCompact, PostCompact, Stop,
//   SubagentStart, SubagentStop,
//   FileChanged                                 ← 尚无触发源，见下方说明
//
// 【FileChanged 为什么列在这里但没有触发点】
// 官方（Claude Code）有这个事件，用于「文件被编辑器等外部程序改动」时通知 hook。
// CCM 侧的手机场景（MT 管理器改文件）也确实存在，但**当前没有任何文件监听
// 机制**：全仓库搜不到 fs.watch / fs.watchFile / chokidar。
//
// 不补触发源的两个原因：
//   1) fs.watch 在 Android/sdcard（FAT32/exfat）上不可靠 —— 同一文件会重复
//      事件、改 mtime 不触发、目录级监听直接失效；
//   2) 轮询 mtime 要常驻定时器，白烧 CPU 和电量，而收益只是「知道文件被改了」。
//
// 所以：事件表里有它（用户可以配置，trigger() 按事件名查表即可生效），
// 但**配置了也不会触发**。这里如实写明，不假装它能跑。
// 真要启用时的前提：先有一个可靠的文件监听源（或用户明确接受轮询代价）。
//
// 【2026-10-20 补 SubagentStart/SubagentStop】这两个事件从 2026-09 起就在
// `core/agent/plan.mjs` 有真实触发点（子 Agent 启动/收尾），但文件头没列、
// `/hooks` 命令也不显示 —— 用户看文档以为不支持，实际上配了就能用。
// 声明落后于实现同样是缺陷：它让可用能力变成"没人知道的隐藏功能"。
//
// 【为什么 PostToolUseFailure 单独一个事件（对齐官方 2.1.303）】
// 官方 hooks 事件表里 PostToolUse 与 PostToolUseFailure 是独立两项。
// 合并成一个事件的坏处：hook 脚本只能自己嗅输出里有没有 error 字样，
// 而那个启发式会误判（grep 无匹配 exit 1、文件名里带 error 都会被误杀）。
// 拆开后由 agent 层用工具声明的 __ok（Bash 走真实 exitCode）判定，
// 失败 hook 可以单独配「通知/回滚/打日志」，不必在每条 hook 里写 if。
//
// 【为什么 trigger() 本身是事件无关的】它按事件名去 hooks.json / skillHooks
// 里查表，新事件**不需要**在这里加分支。这份清单是给人和 /hooks 命令看的
// 文档性约定，新增事件时同步更新这里即可。
//
// 【PermissionDenied（2026-10-23 补）】对齐官方独立事件，schema 为
// {tool_name, tool_input, tool_use_id, reason, mcp_server?}。
// 两条触发路径都在 core/agent/agent.mjs：权限判定拒绝、PreToolUse hook deny。
// 观察类事件（无 deny/block 语义）—— 工具拒绝本身由 agent 决定，hook 只知情。
// 为什么 reason 值得单独给：官方把「为什么被拒」显式传出来，hook 脚本
// 才能区分「权限规则拒的」和「PreToolUse hook 拒的」，否则只能嗅字符串。
import { exec } from 'node:child_process'
import { HOOKS_PATH } from './paths.mjs'
import { existsSync, readFileSync } from 'node:fs'

// shell 路径自适应（Termux / proot Ubuntu）
// 逻辑统一在 core/shell-path.mjs，这里包一层保持调用点不变
import { getShellPath } from './shell-path.mjs'
function detectShell() {
  return getShellPath()
}

const SHELL_PATH = detectShell()

export class HookManager {
  // 【2026-10-03】默认值从相对路径改为数据目录（配置属用户数据）
  constructor(configPath = HOOKS_PATH, logger) {
    this.configPath = configPath
    this.logger = logger || console
    this.hooks = this._loadConfig()
    this.shell = SHELL_PATH
    // skill 声明的 hooks。跟 hooks.json 分开存，因为生命周期不同：
    // hooks.json 是常驻配置，skill hooks 只在该 skill 激活期间有效，
    // skill 卸载/会话结束就要摘掉，混在一起会导致摘不干净。
    // 对齐官方 SkillHookMatcher —— 它也是 session 级、带 skillRoot 的独立层。
    this.skillHooks = new Map()  // skillName → { event: [entry...] }
  }

  /**
   * 注册某个 skill 的 hooks。
   * skillRoot 会作为 hook 命令的 cwd —— skill 的脚本应该在自己目录里跑，
   * 而不是在用户当前工作区（否则 skill 带的辅助脚本引不到相对路径）。
   */
  registerSkillHooks(skillName, hooksSpec, skillRoot = null) {
    if (!skillName || !hooksSpec || typeof hooksSpec !== 'object') return 0
    const byEvent = {}
    let count = 0
    for (const [event, entries] of Object.entries(hooksSpec)) {
      const list = Array.isArray(entries) ? entries : [entries]
      byEvent[event] = list.map(e => ({
        matcher: e.matcher || '',
        hooks: Array.isArray(e.hooks) ? e.hooks : (e.command ? [e] : []),
        // 标记来源，便于日志区分「是哪个 skill 拦了我的工具」
        _skill: skillName,
        _skillRoot: skillRoot,
      })).filter(e => e.hooks.length)
      count += byEvent[event].length
    }
    if (count) this.skillHooks.set(skillName, byEvent)
    return count
  }

  unregisterSkillHooks(skillName) {
    return this.skillHooks.delete(skillName)
  }

  clearSkillHooks() {
    const n = this.skillHooks.size
    this.skillHooks.clear()
    return n
  }

  /** 某事件下的全部 hook 条目 = hooks.json + 所有已激活 skill 的声明。 */
  _entriesFor(event) {
    const out = [...(this.hooks[event] || [])]
    for (const byEvent of this.skillHooks.values()) {
      if (byEvent[event]) out.push(...byEvent[event])
    }
    return out
  }

  _loadConfig() {
    try {
      if (!existsSync(this.configPath)) return {}
      return JSON.parse(readFileSync(this.configPath, 'utf-8'))
    } catch (e) {
      this.logger.warn && this.logger.warn(`[Hooks] ${e.message}`)
      return {}
    }
  }

  /**
   * 重新从磁盘读 hooks.json（供 /hooks edit 保存后热重载）。
   *
   * 【为什么不直接用 _loadConfig】它解析失败时返回 `{}` 并只打一条 warn ——
   * 那对启动阶段是合理的（没配置就等于没 hook），但对「用户刚编辑完」的场景
   * 是灾难：JSON 写坏了会被静默当成「没有任何 hook」，用户以为保存成功了，
   * 实际所有 hook 全部失效。所以这里把错误**抛出去**，由调用方决定保留旧配置。
   *
   * 【skillHooks 不动】它们是 skill 激活期内的临时层，生命周期与 hooks.json
   * 无关。热重载只该刷新常驻配置那一层。
   *
   * @returns {{ok: true, events: number, entries: number} | {ok: false, error: string}}
   */
  reload() {
    let raw
    try {
      if (!existsSync(this.configPath)) {
        // 文件被删掉了 = 用户就是想清空，这是合法结果
        this.hooks = {}
        return { ok: true, events: 0, entries: 0 }
      }
      raw = readFileSync(this.configPath, 'utf-8')
    } catch (e) {
      return { ok: false, error: `读取失败: ${e.message}` }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return { ok: false, error: `JSON 解析失败: ${e.message}` }
    }
    // 顶层必须是对象。数组/null 都能过 JSON.parse，但后面 _entriesFor
    // 用 this.hooks[event] 取值，null 会抛 TypeError（静默变成"没有 hook"）。
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '顶层必须是对象（形如 {"PreToolUse": [...]}）' }
    }
    this.hooks = parsed
    const events = Object.keys(parsed).filter(k => Array.isArray(parsed[k]) && parsed[k].length > 0)
    const entries = events.reduce((n, k) => n + parsed[k].length, 0)
    return { ok: true, events: events.length, entries }
  }

  // 触发 hook 事件
  // 返回值：
  //   PreToolUse → { deny: true, message } 可阻止工具执行
  //   Stop → { block: true, message } 可阻止 agent 结束（续跑一轮）
  //   其他事件 → {} 无效果（观察类）
  async trigger(event, context = {}) {
    const entries = this._entriesFor(event)
    const result = {}
    for (const entry of entries) {
      // matcher 过滤（PreToolUse 按 tool name 匹配，其他事件按 context.matcher 字段匹配）
      const matchValue = context.tool || context.matcher || ''
      if (entry.matcher && matchValue) {
        let re
        try { re = new RegExp(entry.matcher) } catch (e) {
          this.logger.warn && this.logger.warn(`[Hooks] invalid matcher "${entry.matcher}": ${e.message}`)
          continue
        }
        if (!matchValue.match(re)) continue
      }

      // 展开 entry.hooks 数组，逐个执行
      const innerHooks = entry.hooks || []
      for (const hook of innerHooks) {
        // 带上来源 skill 信息：_runHook 用它决定 cwd 和环境变量
        const hookResult = await this._runHook(hook, {
          ...context, event,
          _skill: entry._skill, _skillRoot: entry._skillRoot,
        })

        // PreToolUse: DENY 短路
        if (event === 'PreToolUse' && hookResult?.deny) {
          return { deny: true, message: hookResult.message || 'Hook denied' }
        }

        // PreToolUse: hook 返回的 input 修改（官方 updatedInput 对应物）
        if (event === 'PreToolUse' && hookResult?.updatedInput && typeof hookResult.updatedInput === 'object') {
          result.updatedInput = { ...(result.updatedInput || {}), ...hookResult.updatedInput }
        }

        // PreToolUse: hook 返回的上下文注入（官方 additionalContext 对应物）
        if (event === 'PreToolUse' && hookResult?.additionalContext) {
          if (!result.additionalContexts) result.additionalContexts = []
          result.additionalContexts.push(hookResult.additionalContext)
        }

        // Stop: BLOCK 累积（所有 hook 都跑，block 累加）
        if (event === 'Stop' && hookResult?.block) {
          if (!result.blocks) result.blocks = []
          result.blocks.push(hookResult.message || 'Hook requested continue')
        }

        // UserPromptSubmit: 注入额外上下文
        if (event === 'UserPromptSubmit' && hookResult?.inject) {
          if (!result.injections) result.injections = []
          result.injections.push(hookResult.inject)
        }
      }
    }

    // Stop: 如果有任何 block，返回 block 结果
    if (event === 'Stop' && result.blocks?.length > 0) {
      return { block: true, messages: result.blocks }
    }

    // UserPromptSubmit: 返回注入内容
    if (event === 'UserPromptSubmit' && result.injections?.length > 0) {
      return { inject: result.injections.join('\n') }
    }

    // PreToolUse: 返回 hook 累积的 updatedInput / additionalContexts
    if (event === 'PreToolUse') {
      const out = {}
      if (result.updatedInput) out.updatedInput = result.updatedInput
      if (result.additionalContexts?.length) out.additionalContexts = result.additionalContexts
      return out
    }
    return {}
  }

  async _runHook(hook, context) {
    const env = {
      ...process.env,
      EVENT: context.event || '',
      TOOL_NAME: context.tool || '',
      TOOL_INPUT: JSON.stringify(context.input || {}),
      TOOL_OUTPUT: String(context.output || '').slice(0, 4000),
      // SessionStart/SessionEnd
      SESSION_ID: context.sessionId || '',
      // UserPromptSubmit
      PROMPT: context.prompt || '',
      // Stop
      STOP_REASON: context.reason || '',
      // PermissionDenied（官方 schema：reason / tool_use_id）
      PERMISSION_DENIED_REASON: context.reason || '',
      TOOL_USE_ID: context.toolUseId || '',
      // PreCompact/PostCompact
      TOKEN_COUNT: String(context.tokenCount || ''),
      TOKEN_LIMIT: String(context.tokenLimit || ''),
      // skill hooks: 让脚本知道自己属于哪个 skill、资源在哪
      SKILL_NAME: context._skill || '',
      SKILL_ROOT: context._skillRoot || '',
    }
    const timeout = hook.timeout || (context.event === 'Stop' ? 60000 : 5000)
    try {
      const output = await new Promise((resolve, reject) => {
        const child = exec(hook.command, {
          env, encoding: 'utf-8', timeout,
          shell: this.shell,
          // skill 的 hook 在 skill 自己目录里跑，否则它带的辅助脚本引不到相对路径；
          // 全局 hooks.json 的 hook 仍在当前工作区跑（cwd 为 undefined = 继承）。
          cwd: context._skillRoot || undefined,
        }, (err, stdout, stderr) => {
          if (stderr) this.logger.warn && this.logger.warn(`[Hook stderr] ${stderr}`.trim())
          if (err && err.signal === 'SIGTERM') reject(new Error('Hook timeout'))
          else if (err) reject(err)
          else resolve(stdout)
        })
      })
      const trimmed = output.trim()

      // PreToolUse: DENY: 前缀
      if (context.event === 'PreToolUse' && trimmed.startsWith('DENY:')) {
        return { deny: true, message: trimmed.slice(5).trim() }
      }

      // Stop: BLOCK: 前缀阻止结束
      if (context.event === 'Stop' && trimmed.startsWith('BLOCK:')) {
        return { block: true, message: trimmed.slice(6).trim() }
      }

      // UserPromptSubmit: INJECT: 前缀注入上下文
      if (context.event === 'UserPromptSubmit' && trimmed.startsWith('INJECT:')) {
        return { inject: trimmed.slice(7).trim() }
      }

      return { deny: false }
    } catch (e) {
      this.logger.warn && this.logger.warn(`[Hook] ${hook.command} failed: ${e.message}`)
      // fail-closed 支持：hook 可声明 failClosed: true（安全类 hook 该这么配）。
      // 崩溃/超时 = 无法证明放行是安全的 → 拒绝执行，宁可误拦不可漏放。
      // 默认仍 fail-open：普通 hook（通知、统计）挂了不该挡住正常工作。
      if (hook.failClosed) {
        return { deny: true, message: `安全 hook 异常(${e.message})，已按 fail-closed 拦截` }
      }
      return { deny: false }
    }
  }

  // 获取所有已注册的事件名（供 /hooks 命令使用）
  getHookedEvents() {
    return Object.keys(this.hooks).filter(k => this.hooks[k].length > 0)
  }

  // 列出所有 hook 配置（供 /hooks 命令使用）
  getAllHooks() {
    const result = {}
    for (const [event, hooks] of Object.entries(this.hooks)) {
      if (hooks.length > 0) result[event] = hooks
    }
    return result
  }
}
