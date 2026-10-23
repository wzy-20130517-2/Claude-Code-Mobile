// 诊断 / 统计命令批（对齐官方 Claude Code 2.1.303）
//
//   /skill-doctor   哪些 skill 从未被用过、白占上下文（官方：Show which loaded skills
//                   are unused and costing context）
//   /reload-skills  重新扫描磁盘上的 skill（官方：Pick up skills added or changed on disk）
//   /insights       用量与协作洞察（官方：本地统计 / 分析面板）
//   /import         从别的 AI coding agent 导入配置（官方：[codex|gemini|cursor] [--dry-run]）
//
// 【为什么这四条放一起】共同点：都是**只读分析 + 显式副作用为零或极小**，
// 且都依赖「扫描本地文件系统」。与 cmd-queries（读运行时状态）不同 ——
// 那批读的是 agent/config 的内存对象，这批读的是磁盘。
//
// 【官方实现里的关键细节（读源码得到的，不是猜的）】
//   · /skill-doctor 在 2.1.303 有双实现：local-jsx（弹窗）+ local（非交互），
//     描述都是「Show which loaded skills are unused and costing context」。
//     核心价值是**算账**：每个 skill 的 description 每轮都进上下文，
//     几百个 skill 就是几万 token，但用户看不见这笔开销。
//   · /reload-skills 的描述是「Pick up skills added or changed on disk during this
//     session」—— 关键词是 **during this session**：不重启也要能看见新建的 skill。
//     CCM 的 SkillLoader 有 invalidate()，正好对应。
//   · /import 的 argumentHint 是 `[codex|gemini|cursor] [--dry-run]`，
//     **--dry-run 是一等公民**：导入别人的配置前必须先能预览。
//     这个设计要照抄 —— 直接写别人家的配置是破坏性操作。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * @param {object} ctx
 *   C, config, saveConfig
 *   skillLoader                   SkillLoader 实例（list / listNames / invalidate）
 *   usedSkills                    () => Set<string>  本会话被展开过的 skill 名
 *   getMaxContext / agent
 *   listMemories                  core/agent/agent-memory.mjs
 *   listKeptAgents / getRunningSubagents
 *   cliVersion                    () => string
 */
export function makeDiagCommands(ctx) {
  const C = ctx.C || new Proxy({}, { get: () => '' })

  /** 粗估 token：中英混合约 2 字符/token（与 /context 的估算同一套规则） */
  const est = (text) => Math.round(String(text || '').length / 2)

  return {
    /**
     * /skill-doctor —— skill 上下文开销体检
     *
     * 【为什么这条命令值得存在】skill 的 name + description 是**每轮都发**的，
     * 而 skill 正文只在被展开时进上下文。CCM 装了 800+ 个全局 skill，
     * 光索引就可能吃掉几万 token —— 这笔开销在任何现有命令里都看不到
     * （/skills 只列名字，/context 只给总量）。
     *
     * 【「未使用」怎么判定】靠 usedSkills（本会话展开过的集合）。注意这是
     * **本会话**口径，不是历史口径 —— 跨会话统计要落盘，而"哪个 skill 上次
     * 用过"的信息价值远低于实现成本。所以输出里要写清口径，别让用户以为
     * 那是长期统计。
     *
     * 参数: /skill-doctor [all]（默认只列前 20 个最贵的）
     */
    'skill-doctor'(args) {
      const showAll = String(args[0] || '').toLowerCase() === 'all'
      let list = []
      try { list = ctx.skillLoader?.list() || [] } catch (e) {
        return `读 skill 列表失败: ${e?.message || e}`
      }
      if (list.length === 0) return '没有加载任何 skill。'

      const used = (() => { try { return ctx.usedSkills?.() || new Set() } catch { return new Set() } })()

      // 每个 skill 的上下文成本 = name + description 的 token（正文按需展开，不算）
      const rows = list.map((s) => {
        const desc = String(s.description || '')
        return {
          name: s.name,
          scope: s.scope || 'project',
          passive: !!s.passive,
          tokens: est(`${s.name} ${desc}`),
          used: used.has(s.name),
          descLen: desc.length,
        }
      }).sort((a, b) => b.tokens - a.tokens)

      const totalTokens = rows.reduce((n, r) => n + r.tokens, 0)
      const unused = rows.filter(r => !r.used)
      const unusedTokens = unused.reduce((n, r) => n + r.tokens, 0)
      const maxCtx = (() => { try { return ctx.getMaxContext?.() || 1000000 } catch { return 1000000 } })()
      const pct = maxCtx > 0 ? (totalTokens / maxCtx * 100).toFixed(2) : '?'

      const shown = showAll ? rows : rows.slice(0, 20)
      const lines = [
        `${C.bold}Skill 上下文体检${C.reset}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `  共 ${rows.length} 个 · 索引合计 ≈ ${totalTokens.toLocaleString('en-US')} tokens（占上限 ${pct}%）`,
        `  本会话用过 ${rows.length - unused.length} 个 · 未用过 ${unused.length} 个（≈ ${unusedTokens.toLocaleString('en-US')} tokens）`,
        '',
        `${C.bold}最贵的 ${shown.length} 个${C.reset}（按索引 token 降序）`,
      ]
      for (const r of shown) {
        const mark = r.used ? `${C.green}用${C.reset}` : `${C.dim}未${C.reset}`
        const scope = r.scope === 'global' ? '全局' : '项目'
        const passive = r.passive ? ' [被动]' : ''
        lines.push(`  ${mark} ${r.name}${passive}  ${r.tokens} tok · ${scope} · desc ${r.descLen} 字`)
      }
      if (!showAll && rows.length > shown.length) {
        lines.push(`  ${C.dim}… 另有 ${rows.length - shown.length} 个（/skill-doctor all 看全部）${C.reset}`)
      }
      lines.push('')
      lines.push(`${C.dim}口径：只统计**本会话**展开过的 skill，不是历史累计。`)
      lines.push(`索引 token 按 2 字符/token 粗估；skill 正文只在展开时才进上下文，不计入。`)
      lines.push(`降本手段：把不常用的 skill 从 skills/ 或 ~/.claude/skills/ 移走，或缩短它的 description。${C.reset}`)
      return lines.join('\n')
    },

    /**
     * /reload-skills —— 重新扫描磁盘上的 skill
     *
     * 【为什么必须有】SkillLoader 的 list() 有缓存（823 个文件全读一次要 3s，
     * 所以按目录 mtime 做了缓存）。用户新建一个 skill 后，缓存不失效 →
     * 敲 /新skill 提示「未知命令」，看起来像功能坏了。原来唯一的解法是重启。
     *
     * 【为什么还要重建 slashCommands】`skillCommandNames()` 在启动时拼进了
     * slashCommands 数组（补全 + /help 对账都用它）。只 invalidate 缓存不够：
     * 补全面板读的是那个数组快照，新 skill 仍然不会出现在补全里。
     * 所以这里必须让调用方重建 —— 用 ctx.rebuildCommandList()。
     *
     * 参数: /reload-skills [--force]
     *   --force 连**已存在的 skill** 的正文缓存也一起丢（改了 SKILL.md 但
     *   文件名/大小没变时，mtime 校验可能漏；--force 是无条件重读）
     */
    'reload-skills'(args) {
      const force = args.map(a => String(a).toLowerCase()).includes('--force')
      const loader = ctx.skillLoader
      if (!loader) return '当前环境没有 skill loader。'
      const before = (() => { try { return loader.listNames().length } catch { return 0 } })()
      try {
        // invalidate() 清名单缓存；--force 时再清正文缓存（loader 若有的话）
        loader.invalidate?.()
        if (force) {
          // SkillLoader 的正文是每次 _entryFromFile 现读的（无正文缓存），
          // 所以 --force 在这里等价于「再 invalidate 一次 + 强制重扫」。
          // 保留这个参数是为了与官方 argumentHint 一致，且将来真加了正文缓存
          // 时语义不变（不会因为参数被静默忽略而让用户以为强制生效了）。
          loader.invalidate?.()
        }
        const after = loader.listNames().length
        const rebuilt = (() => {
          try { return ctx.rebuildCommandList?.() || '' } catch (e) { return `（补全列表重建失败：${e?.message || e}）` }
        })()
        const delta = after - before
        const lines = [
          `Skill 已重扫: ${after} 个${delta !== 0 ? `（${delta > 0 ? '+' : ''}${delta}）` : '（无变化）'}`,
        ]
        if (force) lines.push(`${C.dim}--force：已强制丢弃缓存重读${C.reset}`)
        if (rebuilt) lines.push(rebuilt)
        lines.push('')
        lines.push(`${C.dim}新建的 skill 现在可以直接敲 /<名字> 了。${C.reset}`)
        return lines.join('\n')
      } catch (e) {
        return `重扫失败: ${e?.message || e}`
      }
    },

    /**
     * /insights —— 用量与协作洞察
     *
     * 【官方语义】2.1.303：/insights 是本地分析面板（INSIGHT_SECTIONS 里第一段
     * 叫 project_areas），核心是「按项目/工具/时间统计你的使用模式」。
     * 注意：**project_areas 不是命令**，是它的一个分析段落名（报告 §4 已澄清）。
     *
     * 【CCM 落地范围】只做**本地能算准**的：
     *   · 会话/消息/token 概况
     *   · 工具调用分布（从历史里的 tool_use 块统计）
     *   · skill 索引开销（复用 skill-doctor 的口径）
     *   · 子 agent / 记忆数量
     * 不做「时间趋势」（要跨会话历史落盘，CCM 的 sessions/ 有但字段不全，
     * 硬算出来会是不准的数 —— 不准的统计比没有统计更糟）。
     */
    insights(args) {
      const agent = ctx.agent
      const history = (() => { try { return agent?.getHistory?.() || [] } catch { return [] } })()

      // 工具调用分布：遍历历史里的 tool_use 块
      const toolCount = new Map()
      let userMsgs = 0, assistantMsgs = 0
      for (const m of history) {
        if (m?.role === 'user') userMsgs++
        else if (m?.role === 'assistant') assistantMsgs++
        const c = m?.content
        if (!Array.isArray(c)) continue
        for (const b of c) {
          if (b?.type === 'tool_use' && b.name) {
            toolCount.set(b.name, (toolCount.get(b.name) || 0) + 1)
          }
        }
      }
      const totalCalls = [...toolCount.values()].reduce((a, b) => a + b, 0)
      const topTools = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

      const usage = (() => { try { return agent.getTokenUsage() } catch { return {} } })()
      const lastPrompt = (() => { try { return agent.getLastPromptTokens() } catch { return 0 } })()

      let skillTokens = 0, skillCount = 0
      try {
        const list = ctx.skillLoader?.list() || []
        skillCount = list.length
        skillTokens = est(list.map(s => `${s.name} ${s.description || ''}`).join('\n'))
      } catch {}

      let memCount = 0
      try { memCount = (ctx.listMemories?.({}) || []).length } catch {}

      let kept = 0, running = 0
      try { kept = (ctx.listKeptAgents?.() || []).length } catch {}
      try { running = ctx.getRunningSubagents?.() || 0 } catch {}

      const lines = [
        `${C.bold}会话洞察${C.reset}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `  消息      ${history.length} 条（用户 ${userMsgs} · 助手 ${assistantMsgs}）`,
        `  上下文    ${lastPrompt.toLocaleString('en-US')} tokens（最近一次请求的 prompt_tokens）`,
        `  累计输出  ${(usage.output || 0).toLocaleString('en-US')} tokens`,
        `  工具调用  ${totalCalls} 次 · ${toolCount.size} 种`,
      ]

      if (topTools.length) {
        lines.push('')
        lines.push(`${C.bold}工具分布${C.reset}（前 ${topTools.length}）`)
        const max = topTools[0][1] || 1
        for (const [name, n] of topTools) {
          // 条形图比纯数字更容易看出「谁是大头」，宽度 20 列
          const bar = '█'.repeat(Math.max(1, Math.round(n / max * 20)))
          const pctStr = totalCalls ? `${Math.round(n / totalCalls * 100)}%` : ''
          lines.push(`  ${name.padEnd(16)}${String(n).padStart(4)}  ${bar} ${pctStr}`)
        }
      }

      lines.push('')
      lines.push(`${C.bold}其它${C.reset}`)
      if (skillCount) lines.push(`  skill      ${skillCount} 个 · 索引 ≈ ${skillTokens.toLocaleString('en-US')} tokens（/skill-doctor 看明细）`)
      lines.push(`  子 agent   运行中 ${running} · 可唤醒 ${kept}`)
      if (memCount) lines.push(`  agent 记忆 ${memCount} 份（/mem 管理）`)
      lines.push('')
      lines.push(`${C.dim}注：不做跨会话时间趋势 —— 那要完整的会话历史字段，`)
      lines.push(`CCM 的 sessions/ 里字段不全，硬算出来的数不准，不如不算。${C.reset}`)
      return lines.join('\n')
    },

    /**
     * /import —— 从别的 AI coding agent 导入配置
     *
     * 【官方语义】2.1.303：`Import config from another AI coding agent`，
     * argumentHint `[codex|gemini|cursor] [--dry-run]`。
     *
     * 【--dry-run 为什么必须是一等公民】导入是**写别人的配置进我们的配置**，
     * 是破坏性操作。用户必须先能看清「会导入什么、会覆盖哪些现有项」，
     * 再决定执行。所以默认行为是**预览**，真写要显式加 --apply。
     *
     * 【与官方的差异（有意）】官方的默认行为是执行，--dry-run 才预览。
     * 这里反过来（默认预览）—— 因为 CCM 的配置里存着 API key 池，
     * 误覆盖的代价比官方高得多（要重新找 key）。宁可多敲一个 --apply。
     *
     * 【导入什么】只导入**格式通用、无歧义**的部分：
     *   · MCP 服务器定义（codex 的 ~/.codex/config.toml / cursor 的 .cursor/mcp.json）
     *   · 系统提示词 / 规则文件（GEMINI.md、.cursorrules、AGENTS.md）
     * **不导入** API key / provider（格式差异大、误配会静默失败，必须人工确认）。
     */
    'import'(args) {
      const sub = String(args[0] || '').toLowerCase()
      const apply = args.map(a => String(a).toLowerCase()).includes('--apply')
      const SOURCES = ['codex', 'gemini', 'cursor']

      if (!sub || sub === 'list') {
        return [
          `${C.bold}从其它 AI coding agent 导入配置${C.reset}`,
          '',
          '用法: /import <codex|gemini|cursor> [--apply]',
          '',
          '默认**只预览**（不写任何东西）。确认无误后加 --apply 才真写。',
          '',
          '会看这些位置:',
          `  ${C.dim}codex   ~/.codex/config.toml（MCP 服务器）${C.reset}`,
          `  ${C.dim}gemini  ~/GEMINI.md、~/.gemini/settings.json${C.reset}`,
          `  ${C.dim}cursor  .cursor/mcp.json、.cursorrules${C.reset}`,
          '',
          '只导入 MCP 服务器定义与规则文件；**不导入 API key / provider**',
          '（格式差异大，误配会静默失败，必须人工确认）。',
        ].join('\n')
      }
      if (!SOURCES.includes(sub)) {
        return `未知来源: ${sub}\n可用: ${SOURCES.join(' / ')}`
      }

      // 每个来源探测哪些文件
      const home = homedir()
      const probes = {
        codex: [join(home, '.codex', 'config.toml'), join(home, '.codex', 'config.json')],
        gemini: [join(home, 'GEMINI.md'), join(home, '.gemini', 'settings.json'), join(home, '.gemini', 'GEMINI.md')],
        cursor: [join(process.cwd(), '.cursor', 'mcp.json'), join(process.cwd(), '.cursorrules')],
      }[sub] || []

      const found = []
      for (const p of probes) {
        if (!existsSync(p)) continue
        let size = 0
        try { size = statSync(p).size } catch {}
        found.push({ path: p, size })
      }
      if (found.length === 0) {
        return `没有找到 ${sub} 的配置文件。\n查过:\n${probes.map(p => `  ${p}`).join('\n')}\n`
          + `（${sub} 可能没装，或配置在别的位置）`
      }

      // 解析出「能导入什么」。只做保守提取，解析不出来就如实说。
      const importable = []
      const skipped = []
      for (const f of found) {
        let raw = ''
        try { raw = readFileSync(f.path, 'utf-8') } catch { continue }
        if (/mcp\.json$/.test(f.path) || /settings\.json$/.test(f.path) || /config\.json$/.test(f.path)) {
          try {
            const j = JSON.parse(raw)
            const servers = j.mcpServers || j.mcp?.servers || null
            if (servers && typeof servers === 'object') {
              importable.push({ from: f.path, kind: 'mcpServers', value: servers })
            } else {
              skipped.push(`${f.path}: JSON 里没有 mcpServers`)
            }
          } catch (e) {
            skipped.push(`${f.path}: JSON 解析失败（${e.message}）`)
          }
        } else if (/config\.toml$/.test(f.path)) {
          // TOML 不做完整解析（项目里没有 toml 依赖，加一个只为这条命令不值）。
          // 只提取 [mcp_servers.xxx] 段落名，让用户知道有什么，不假装能导入。
          const names = [...raw.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map(m => m[1])
          if (names.length) {
            skipped.push(`${f.path}: TOML 里有 ${names.length} 个 MCP 服务器（${names.join(', ')}）—— TOML 不做自动转换，请手动搬`)
          } else {
            skipped.push(`${f.path}: 没找到 [mcp_servers.*] 段`)
          }
        } else {
          // 规则文件（GEMINI.md / .cursorrules）—— 可以作为项目记忆追加
          const text = raw.trim()
          if (text) importable.push({ from: f.path, kind: 'rules', value: text })
        }
      }

      const lines = [`${C.bold}从 ${sub} 导入${C.reset}  ${apply ? '(执行)' : '(预览 — 加 --apply 才真写)'}`, '']
      lines.push(`找到 ${found.length} 个文件:`)
      for (const f of found) lines.push(`  ${f.path}  (${f.size} 字节)`)
      lines.push('')

      if (importable.length === 0) {
        lines.push('没有可自动导入的内容。')
        if (skipped.length) {
          lines.push('')
          lines.push('跳过原因:')
          for (const s of skipped) lines.push(`  ${s}`)
        }
        return lines.join('\n')
      }

      lines.push('可导入:')
      for (const it of importable) {
        if (it.kind === 'mcpServers') {
          const names = Object.keys(it.value)
          lines.push(`  MCP 服务器 ${names.length} 个 ← ${it.from}`)
          for (const n of names) lines.push(`    ${n}`)
        } else {
          lines.push(`  规则文本 ${it.value.length} 字符 ← ${it.from}`)
        }
      }
      if (skipped.length) {
        lines.push('')
        lines.push('跳过:')
        for (const s of skipped) lines.push(`  ${s}`)
      }

      if (!apply) {
        lines.push('')
        lines.push(`${C.dim}以上是预览，没有写任何文件。确认无误后执行: /import ${sub} --apply${C.reset}`)
        return lines.join('\n')
      }

      // ── 真写 ──
      const results = []
      for (const it of importable) {
        if (it.kind === 'mcpServers') {
          try {
            const r = ctx.mergeMcpServers?.(it.value)
            results.push(r || `MCP: 已合并 ${Object.keys(it.value).length} 个服务器（同名的不覆盖）`)
          } catch (e) {
            results.push(`MCP 合并失败: ${e?.message || e}`)
          }
        } else {
          try {
            ctx.appendProjectMemory?.(`\n## 从 ${sub} 导入的规则\n\n${it.value}\n`)
            results.push(`规则: 已追加到项目记忆（CLAUDE.md）`)
          } catch (e) {
            results.push(`规则追加失败: ${e?.message || e}`)
          }
        }
      }
      lines.push('')
      lines.push(`${C.bold}结果${C.reset}`)
      for (const r of results) lines.push(`  ${r}`)
      lines.push('')
      lines.push(`${C.dim}MCP 服务器改动要 Ctrl+X 重启才生效。${C.reset}`)
      return lines.join('\n')
    },
  }
}
