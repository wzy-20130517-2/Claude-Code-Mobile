// 工具审批 + 权限模式 + permissions.json 规则（真正接到 runtime）
import { readFileSync, existsSync, statSync } from 'node:fs'
import { atomicWrite } from './atomic.mjs'
import { resolveConfigPath } from './paths.mjs'
import { classifyBashCommand } from '../permission/bash-readonly.mjs'

// 【2026-10-03】原为相对路径（相对 cwd）→ 读写源码目录里的配置。
// 用户要求配置属用户数据，统一放 ~/.claude-code-mobile/（见 core/paths.mjs）。
const PERM_FILE = resolveConfigPath('permissions.json')
const CONFIG_FILE = resolveConfigPath('config.json')

// 装饰性工具：default 模式下未点名就默认拒绝（治乱调）
export const DECORATIVE_TOOLS = new Set([
  'Toast', 'TTS', 'Notify', 'Vibrate', 'Battery', 'Location', 'ClipboardGet', 'Screencap',
])

// plan 模式允许的只读工具
const PLAN_ALLOWED = new Set([
  'Read', 'Glob', 'Grep', 'HashlineRead', 'HashlineGrep', 'Bash',
  'WebFetch', 'WebSearch', 'GitStatus', 'GitDiff', 'GitLog',
  'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'EnterWatch', 'ExitWatch', 'Agent', 'Skill',
  'UserInputHistory', 'ViewImage', 'CommandExec', 'AskUserQuestion',
  'Test', 'Diagnostics', 'RepoMap', 'Symbols', 'LSP',
])

// 官方 2.1.303 的六种模式（chunk-0hk4q36w.js:2801-2808 的描述表）：
//   default / acceptEdits / auto / dontAsk / plan / bypassPermissions
// CCM 只实现其中五种，`auto` 缺位的原因见 resolve() 里 dontAsk 分支上方的注释。
const MODES = ['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']

export class PermissionManager {
  constructor() {
    this.mode = this._loadMode() // default | acceptEdits | dontAsk | plan | bypassPermissions
  }

  _loadMode() {
    try {
      if (!existsSync(CONFIG_FILE)) return 'default'
      const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      const m = c.permissionMode || c.permission_mode || 'default'
      return MODES.includes(m) ? m : 'default'
    } catch { return 'default' }
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`未知模式: ${mode}，可选: ${MODES.join('|')}`)
    this.mode = mode
    try {
      let config = {}
      if (existsSync(CONFIG_FILE)) config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
      config.permissionMode = mode
      atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch {}
    return `权限模式 → ${mode}`
  }

  getMode() { return this.mode }

  loadRules() {
    // 带 mtime 缓存：resolve 每次工具调用都会跑，不能每次读盘
    try {
      if (!existsSync(PERM_FILE)) {
        this._rulesCache = { allow: [], deny: [], ask: [] }
        this._rulesMtime = 0
        return this._rulesCache
      }
      const m = statSync(PERM_FILE).mtimeMs
      if (this._rulesCache && this._rulesMtime === m) return this._rulesCache
      const r = JSON.parse(readFileSync(PERM_FILE, 'utf-8'))
      this._rulesCache = {
        allow: Array.isArray(r.allow) ? r.allow : [],
        deny: Array.isArray(r.deny) ? r.deny : [],
        ask: Array.isArray(r.ask) ? r.ask : [],
      }
      this._rulesMtime = m
      return this._rulesCache
    } catch {
      return this._rulesCache || { allow: [], deny: [], ask: [] }
    }
  }

  /**
   * 统一权限裁决
   * @param {string} toolName
   * @param {object} [input] 工具入参 —— **必须传**：破坏性判定是看参数的
   *   （ExitWorktree 只有 action=remove 才破坏，其它 action 只是切目录）
   * @param {object} [tool] 工具实例（可选）。传了才能读它的 isDestructive
   * @returns {{ allowed: boolean, reason?: string, needAsk?: boolean }}
   */
  resolve(toolName, input = {}, tool = null) {
    // 0) plan 模式的 Bash 只读约束 **先于显式规则** —— 这是硬约束，不是偏好。
    //
    // 【2026-10-11 为什么提到规则前面】原来 plan 的 Bash 检查在规则之后，
    // 而第 1 步的 `rules.allow.includes(toolName)` 会直接 return true。
    // 本机 permissions.json 恰好配了 allow:["Bash"]（很常见 —— 用户不想每次
    // 执行命令都被拦），于是 plan 模式的写保护**完全失效**：
    // 切到 plan 后 rm -rf /tmp 照样跑。这是安全缺口，不是配置问题。
    //
    // plan 的语义是「只看不改」，任何配置都不应该让它放行写操作 ——
    // 想跑写命令就该切出 plan（/permissions mode acceptEdits）。
    if (this.mode === 'plan' && toolName === 'Bash') {
      const cmd = String(input.command || '')
      const r = classifyBashCommand(cmd)
      if (!r.readonly) {
        return { allowed: false, reason: `plan 模式仅允许只读命令（${r.reason || '无法确认'}）` }
      }
    }

    // 1) 显式规则次高优先
    const rules = this.loadRules()
    if (rules.deny.includes(toolName)) {
      return { allowed: false, reason: `permissions.json deny: ${toolName}` }
    }
    if (rules.allow.includes(toolName)) {
      return { allowed: true }
    }
    if (rules.ask.includes(toolName)) {
      return { allowed: false, needAsk: true, reason: `permissions.json ask: ${toolName}` }
    }

    // 2) 模式
    if (this.mode === 'bypassPermissions') {
      return { allowed: true }
    }

    if (this.mode === 'plan') {
      if (PLAN_ALLOWED.has(toolName)) {
        // plan 下 Bash 的只读约束已在第 0 步处理（先于规则，防 allow 绕过）
        //
        // 【2026-10-20 补：工具自己声明的破坏性也要拦】
        // PLAN_ALLOWED 是**按名字**的白名单，但同名工具的行为取决于参数 ——
        // 典型例子 ExitWorktree：action=keep 只是切回原目录（安全），
        // action=remove 会删掉整个 worktree 目录和分支（不可逆）。
        // 只按名字放行等于「plan 模式可以删目录」，与「只看不改」直接冲突。
        //
        // 判定依据用工具自己的 isDestructive(input)（基类已支持传参），
        // 不在权限层硬编码工具清单 —— 否则每加一个参数化破坏性工具都要改这里。
        // tool 没传（老调用方）时跳过这项，保持向后兼容。
        if (tool && typeof tool.isDestructive === 'function') {
          let destructive = false
          try { destructive = tool.isDestructive(input) === true } catch { destructive = false }
          if (destructive) {
            return { allowed: false, reason: `plan 模式禁止破坏性操作: ${toolName}（该调用会不可逆地改动文件）` }
          }
        }
        return { allowed: true }
      }
      return { allowed: false, reason: `plan 模式禁止工具: ${toolName}` }
    }

    if (this.mode === 'acceptEdits') {
      // 自动放行写文件 + 一切只读；装饰工具仍拦
      if (DECORATIVE_TOOLS.has(toolName)) {
        return { allowed: false, reason: `acceptEdits 下装饰工具需 /permissions allow 或用户点名（${toolName}）` }
      }
      return { allowed: true }
    }

    // dontAsk：官方描述是 "don't ask (auto-deny anything that would prompt)"。
    //
    // 【"anything that would prompt" 指什么】官方 default 模式下写文件、跑命令
    // 都会弹确认框，所以这些都在 dontAsk 的拒绝范围内 —— 不是只拒装饰工具。
    // CCM 没有确认框（needAsk 一律直接拒，见 index.mjs 的 canUseTool），
    // 所以按「default 下本会提示」反推：显式 allow 的放行、只读工具放行、
    // 其余一律拒。
    //
    // 【与 default 的真实差异】就在最后一条：default 下没配 allow 的 Write/Edit
    // 会放行，dontAsk 下被拒。这才对得上「无人值守、没预先批准就不做」的语义，
    // 而不是给 default 换个名字。
    //
    // 【为什么没有 auto】官方 auto 是「不弹常规提示，由一个 reviewer 模型逐个
    // 审查动作」（chunk-0hk4q36w.js:2805），实现上依赖 autoModeClassified /
    // canAutoClassifierRun 这套分类器状态机（chunk-cfqs86z3.js:1057-1100）。
    // CCM 没有第二模型审查通道，硬加一个只会是「全放行」的假 auto，故不实现。
    if (this.mode === 'dontAsk') {
      if (PLAN_ALLOWED.has(toolName)) return { allowed: true }
      return {
        allowed: false,
        reason: `dontAsk 模式不提示也不自动批准: ${toolName}（需要 /permissions allow ${toolName}，或切到 /permissions mode acceptEdits）`,
      }
    }

    // 3) default：拦装饰工具（除非 rules.allow）
    if (DECORATIVE_TOOLS.has(toolName)) {
      return { allowed: false, reason: `default 模式拒绝装饰工具 ${toolName}（用户未明确要求时）。需要：/permissions allow ${toolName} 或切换 /permissions mode bypassPermissions` }
    }

    // 危险 Bash 不再在这里 needAsk 等人确认——交给 Bash 工具内部的
    // （2026-09-26：原 confirm_dangerous 二次确认机制已删 —— 见 pty.mjs 顶部说明。）
    // permissions.json 里显式 ask/deny 仍然生效（上面第 1 步已处理）。

    return { allowed: true }
  }
}

export { MODES as PERMISSION_MODES }
