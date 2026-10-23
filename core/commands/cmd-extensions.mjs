// Claude Code Mobile - 扩展命令
// 新增命令：/context, /diff, /doctor, /stats, /memory, /branch, /rewind, /permissions
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { atomicWrite } from '../infra/atomic.mjs'
import { DATA_DIR, resolveConfigPath, MCP_PATH } from '../infra/paths.mjs'
import { globalSkillsDir } from './skills.mjs'
import { listPlugins, enablePlugin, disablePlugin } from '../integrations/plugins.mjs'
import { probePort } from '../api/status-probe.mjs'
import { renderWordDiff } from '../ui/word-diff.mjs'
import { normalizeProviderUrl } from '../api/provider-url.mjs'
// /config key=value 的 markdownTheme 分支要真的换色（只写配置字段不生效）
import { setMarkdownTheme, markdownThemeNames } from '../ui/markdown.mjs'

// ── 配置事件缓冲 ──────────────────────────────
// /config 切换、/model /url /key 等改配置的操作会把结果写进这里，
// index.mjs 在下一轮用户消息时作为 hidden user 注入对话，
// 让 AI 知道"配置发生了什么变化"（否则向导/快捷命令对 AI 是黑盒，
// AI 只看到用户敲了 /config，不知道切到了哪——2026-09-11 用户指出的盲区）。
const configEvents = []
const MAX_CONFIG_EVENTS = 10

/** 记录一条配置变更事件（模块级，跨命令共享） */
export function recordConfigEvent(line) {
  if (!line) return
  configEvents.push(`[${new Date().toLocaleTimeString()}] ${line}`)
  while (configEvents.length > MAX_CONFIG_EVENTS) configEvents.shift()
}

/** 拉取并清空事件（index.mjs 注入点调用） */
export function drainConfigEvents() {
  if (!configEvents.length) return null
  const out = configEvents.slice()
  configEvents.length = 0
  return out.join('\n')
}

// 终端显示宽度：CJK / 全角字符占 2 列，其余占 1 列。
// 表格对齐必须按这个算，不能用 .length —— 原来的 /context 框线就是因为
// 用字符数当宽度，「上下文使用量」5 个中文少算 5 列，右边框永远内缩。
function dispWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)
    if (
      (c >= 0x1100 && c <= 0x115f) ||   // 韩文字母
      (c >= 0x2e80 && c <= 0xa4cf) ||   // CJK 部首 · 汉字 · 假名
      (c >= 0xac00 && c <= 0xd7a3) ||   // 韩文音节
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容汉字
      (c >= 0xfe30 && c <= 0xfe6f) ||   // CJK 兼容形式
      (c >= 0xff00 && c <= 0xff60) ||   // 全角字符
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) || // emoji
      (c >= 0x1f900 && c <= 0x1f9ff)
    ) w += 2
    else if (c >= 0x0300 && c <= 0x036f) w += 0   // 组合音标不占位
    else w += 1
  }
  return w
}

// /context — 上下文使用量可视化
export function cmdContext(agent, maxContextTokens = null) {
  const history = agent.getHistory()
  const usage = agent.getTokenUsage()
  const lastPrompt = agent.getLastPromptTokens()
  const msgCount = history.length
  // 当前上下文 = 最近一次 API 返回的 prompt_tokens。
  // 每次请求都带全量历史，所以这个值就是「本次对话总上下文占了多少」。
  //
  // 兜底估算：重启恢复会话后 lastPromptTokens 还是 0（要等下一次请求才有值），
  // 此时直接显示 0 会让人以为上下文空了。按历史内容长度粗估一个值，标注 ~ 表示估算。
  let curTokens = lastPrompt || 0
  // 【2026-10-06】估算值的两个来源要区分开：
  //   · agent.isApproxPromptTokens() = true → setHistory 后按 4 字符/token 重估的
  //     （压缩/清空/回退后），这个值**已经算过**，直接用
  //   · lastPromptTokens == 0 → 重启恢复后还没发过请求，这里现算一个
  let estimated = agent.isApproxPromptTokens?.() === true
  if (!curTokens && msgCount > 0) {
    let chars = 0
    for (const m of history) {
      const c = m?.content
      if (typeof c === 'string') chars += c.length
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (typeof b === 'string') chars += b.length
          else if (b?.text) chars += String(b.text).length
          else if (b?.content) chars += String(b.content).length
          else if (b?.type === 'image' || b?.type === 'image_url') chars += 3000  // 图片粗算
        }
      }
    }
    // 中英混合大致 2 字符/token（纯中文约 1.5，纯英文约 4）
    curTokens = Math.round(chars / 2)
    estimated = curTokens > 0
  }
  const configuredMax = Number(maxContextTokens)
  const maxTokens = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 1000000
  const pct = maxTokens > 0 ? Math.min(100, Math.round(curTokens / maxTokens * 100)) : 0
  const filled = Math.min(20, Math.floor(pct / 5))
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled)

  const fmt = (n) => Number(n).toLocaleString('en-US')   // 千分位，14 万比 140950 好读
  const INNER = 40                                       // 框内可用宽度（不含两侧竖线）

  // 每行只给内容，边框由 line() 按显示宽度补空格 —— 不再硬编码空格数
  const line = (content = '') => {
    const pad = Math.max(0, INNER - dispWidth(content))
    return `│ ${content}${' '.repeat(pad)} │`
  }
  const sep = (l, m, r) => `${l}${'─'.repeat(INNER + 2)}${r}`

  // 数值右对齐到同一列：先算最长的那个，其余左边补空格
  const nums = [fmt(msgCount), (estimated ? '~' : '') + fmt(curTokens)]
  const numW = Math.max(...nums.map((s) => s.length))
  // 标签列宽按实际最长标签算，不写死数字 —— 否则改个标签文案就又错位了
  const LABELS = ['消息条数', '当前上下文']
  const labelW = Math.max(...LABELS.map(dispWidth)) + 2
  const row = (label, val, unit = '') =>
    line(`${label}${' '.repeat(Math.max(1, labelW - dispWidth(label)))}${String(val).padStart(numW)}${unit ? ' ' + unit : ''}`)

  const status = curTokens > maxTokens * 0.8
    ? '⚠ 接近上限，建议 /compact'
    : curTokens > maxTokens * 0.5
      ? '· 使用过半，注意长度'
      : '✓ 上下文充裕'

  return [
    sep('┌', '', '┐'),
    line('上下文使用量'),
    sep('├', '', '┤'),
    row('消息条数', fmt(msgCount)),
    row('当前上下文', (estimated ? '~' : '') + fmt(curTokens), 'tokens'),
    line(),
    line(`${bar} ${String(pct).padStart(3)}%`),
    line(`0 ${'─'.repeat(12)} ${fmt(maxTokens)}`),
    line(),
    line(status),
    sep('└', '', '┘'),
  ].join('\n')
}

/**
 * /context all —— 上下文明细（对齐官方 2.1.303 的 `[all]`）
 *
 * 【与 cmdContext 的分工】cmdContext 回答「占了多少」，这里回答「被谁占了」。
 * 用户遇到「明明没几条消息，上下文却快满了」时，总量条完全帮不上忙 ——
 * 真正的大户往往是系统提示词、工具定义、MCP 工具、skill frontmatter，
 * 它们在消息计数里一个都不出现。
 *
 * 【为什么分类要靠注入而不是自己算】
 *   · 系统提示词  —— 只有调用方知道当前拼出来的是哪一份（会随 provider/权限变）
 *   · 工具定义    —— 同上，registry 在 index.mjs 里
 *   · 上下文文件  —— contextFiles 也在外层
 * 所以这些都从 opts 里拿，拿不到就标「未统计」，**不编造数字**。
 * 这条是本项目一贯的规矩：宁可少给一栏，也不给一个看起来精确的假值。
 *
 * @param {object} agent
 * @param {number} maxContextTokens
 * @param {object} opts
 *   systemPrompt   () => string          当前系统提示词全文
 *   toolSchemas    () => object[]        注册中的工具定义（用于估 token）
 *   contextFiles   () => string[]        已加载的上下文文件路径
 *   skills         () => object[]        skill 列表（含 description）
 */
export function cmdContextDetail(agent, maxContextTokens = null, opts = {}) {
  const history = agent.getHistory()
  // 与 cmdContext 同一套粗估规则（中英混合约 2 字符/token），
  // 两个命令的估算必须一致 —— 否则 /context 与 /context all 给出互相矛盾的数字。
  const estimate = (text) => Math.round(String(text || '').length / 2)

  const msgChars = (m) => {
    const c = m?.content
    if (typeof c === 'string') return c.length
    if (!Array.isArray(c)) return 0
    let n = 0
    for (const b of c) {
      if (typeof b === 'string') n += b.length
      else if (b?.text) n += String(b.text).length
      else if (b?.content) n += String(b.content).length
      else if (b?.type === 'image' || b?.type === 'image_url') n += 6000  // 图片粗算（按 3000 token）
    }
    return n
  }

  // 按角色拆历史：用户 / 助手 / 工具结果 三类的占比是排查「谁把上下文撑满」的关键
  let userChars = 0, assistantChars = 0, toolChars = 0
  for (const m of history) {
    const n = msgChars(m)
    if (m?.role === 'user') userChars += n
    else if (m?.role === 'assistant') assistantChars += n
    else if (m?.role === 'tool' || m?.role === 'function') toolChars += n
    else userChars += n
  }

  const fmt = (n) => Number(n).toLocaleString('en-US')
  const rows = []
  const row = (label, tokens, note = '') => {
    rows.push(`  ${label.padEnd(16)}${fmt(tokens).padStart(10)} tokens${note ? `  ${note}` : ''}`)
  }

  row('用户消息', Math.round(userChars / 2), `(${history.filter(m => m?.role === 'user').length} 条)`)
  row('助手消息', Math.round(assistantChars / 2), `(${history.filter(m => m?.role === 'assistant').length} 条)`)
  if (toolChars > 0) row('工具结果', Math.round(toolChars / 2), '(可 /compact micro 回收)')

  let sysTokens = null
  try {
    const sp = typeof opts.systemPrompt === 'function' ? opts.systemPrompt() : ''
    if (sp) { sysTokens = estimate(sp); row('系统提示词', sysTokens, '(每轮都发)') }
  } catch {}

  let toolTokens = null
  try {
    const schemas = typeof opts.toolSchemas === 'function' ? opts.toolSchemas() : null
    if (Array.isArray(schemas)) {
      toolTokens = estimate(JSON.stringify(schemas))
      row('工具定义', toolTokens, `(${schemas.length} 个)`)
    }
  } catch {}

  let skillTokens = null
  try {
    const list = typeof opts.skills === 'function' ? opts.skills() : null
    if (Array.isArray(list) && list.length) {
      // skill 在上下文里只贡献 name + description（正文是按需展开的），
      // 所以这里只估这两段，不把 body 算进去 —— 算了会严重高估。
      skillTokens = estimate(list.map(s => `${s.name} ${s.description || ''}`).join('\n'))
      row('skill 索引', skillTokens, `(${list.length} 个，仅名字+描述)`)
    }
  } catch {}

  const files = (() => {
    try { return typeof opts.contextFiles === 'function' ? (opts.contextFiles() || []) : [] } catch { return [] }
  })()
  if (files.length) {
    rows.push(`  上下文文件${' '.repeat(6)}${String(files.length).padStart(10)} 个`)
    for (const f of files.slice(0, 10)) rows.push(`    ${f}`)
    if (files.length > 10) rows.push(`    … 另有 ${files.length - 10} 个`)
  }

  const total = Math.round((userChars + assistantChars + toolChars) / 2)
    + (sysTokens || 0) + (toolTokens || 0) + (skillTokens || 0)
  const max = Number(maxContextTokens) > 0 ? Number(maxContextTokens) : 1000000
  const pct = max > 0 ? Math.min(100, Math.round(total / max * 100)) : 0

  return [
    '上下文明细（/context all）',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...rows,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `  ${'合计'.padEnd(14)}${fmt(total).padStart(10)} tokens  ≈ ${pct}% / ${fmt(max)}`,
    '',
    '注：以上为按字符数粗估（中英混合约 2 字符/token），与 API 回报的 prompt_tokens',
    '会有偏差；要看**精确值**用 /context（取的是最近一次请求的 prompt_tokens）。',
  ].join('\n')
}

// /diff — 统一查看 git diff
export function cmdDiff(args) {
  const cwd = process.cwd()
  const staged = args.includes('--staged') || args.includes('--cached')
  const useColor = !args.includes('--no-color')
  try {
    const diffArgs = ['diff']
    if (staged) diffArgs.push('--staged')
    // 统计变更文件数
    const statArgs = ['diff', '--stat']
    if (staged) statArgs.push('--staged')
    const stat = execFileSync('git', statArgs, { cwd, encoding: 'utf-8' }).trim()
    const fullDiff = execFileSync('git', diffArgs, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 }).trim()
    if (!fullDiff) return staged ? '(没有已暂存的变更)' : '(没有未暂存的变更)'
    // 取 stat 的最后一行（统计行）
    const statLines = stat.split('\n')
    const summary = statLines[statLines.length - 1]
    const clipped = fullDiff.slice(0, 20000)
    const tail = fullDiff.length > 20000 ? '\n\n... [diff 超长，已截断]' : ''
    // 词级高亮（官方 StructuredDiff 风格）：diff --git / index / +++ / --- 等元信息行
    // 保持原样，只对 hunk 内容做配对高亮。
    const body = useColor ? colorizeUnifiedDiff(clipped) : clipped
    return `${summary}\n\n${body}${tail}`
  } catch (e) {
    return `git diff 失败: ${e.message}\n(当前目录可能不是 git 仓库)`
  }
}

/**
 * 给完整 unified diff 上词级高亮。
 * 元信息行（diff --git / index / --- / +++ / @@）不参与配对，
 * 否则 `--- a/x` 会被当成删除行、`+++ b/x` 当成新增行。
 */
function colorizeUnifiedDiff(text) {
  const dim = '\x1b[2m', reset = '\x1b[0m'
  const meta = '\x1b[1m', hunk = '\x1b[38;2;108;174;196m'
  const out = []
  let buf = []
  const flush = () => {
    if (!buf.length) return
    out.push(...renderWordDiff(buf, { dim, reset }))
    buf = []
  }
  for (const line of String(text || '').split('\n')) {
    if (/^(diff --git|index |similarity |rename |new file|deleted file|old mode|new mode)/.test(line)) {
      flush(); out.push(`${meta}${line}${reset}`)
    } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      flush(); out.push(`${dim}${line}${reset}`)
    } else if (line.startsWith('@@')) {
      flush(); out.push(`${hunk}${line}${reset}`)
    } else {
      buf.push(line)
    }
  }
  flush()
  return out.join('\n')
}

// ── /doctor 上下文警告阈值（对齐官方 claude-code）────────────────
// 官方真值：utils/claudemd.ts MAX_MEMORY_CHARACTER_COUNT = 40000
//          utils/statusNoticeHelpers.ts AGENT_DESCRIPTIONS_THRESHOLD = 15000
//          utils/doctorContextWarnings.ts MCP_TOOLS_THRESHOLD = 25000
// 超阈值说明这些内容每轮都在吃上下文，属于"没坏但该瘦身"的警告（非错误）。
const MAX_MEMORY_CHARS = 40000
const AGENT_DESC_TOKENS = 15000
const MCP_TOOLS_TOKENS = 25000

// 粗估 token：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token（官方 roughTokenCountEstimation 同思路）
function roughTokens(s) {
  if (!s) return 0
  let cjk = 0, other = 0
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x2E80) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

// /doctor — 诊断安装和配置问题
// 输出结构对齐官方 screens/Doctor.tsx：分组标题 + 组内 ✓/✗/○ 检查项，
// 末尾追加官方特有的「Context Usage Warnings」（CLAUDE.md / agent 描述 / MCP 工具 过大）。
export function cmdDoctor(config, extras = {}) {
  const checks = []
  const ok = (name) => checks.push(`  ✓ ${name}`)
  const fail = (name, hint) => checks.push(`  ✗ ${name} — ${hint}`)
  const info = (name) => checks.push(`  ○ ${name}`)
  // 分组标题（官方风格：空行 + 加粗标题）
  const section = (title) => { checks.push(''); checks.push(title) }

  section('Diagnostics')

  // 1. Node.js 版本
  const nodeV = process.version
  const major = parseInt(nodeV.slice(1))
  if (major >= 18) ok(`Node.js ${nodeV}`)
  else fail(`Node.js ${nodeV}`, '需要 Node 18+')

  // 2. config.json
  const cfgPath = resolveConfigPath('config.json')
  if (existsSync(cfgPath)) ok(`config.json 存在 (${cfgPath})`)
  else fail('config.json', '文件不存在')

  // 3. 必需字段（修 #5：支持 providers 结构）
  const currentProvider = config.providers?.[config.current]
  if (currentProvider && currentProvider.url && currentProvider.apiKey && currentProvider.model) {
    ok(`配置完整 (Provider ${config.current}: ${currentProvider.name})`)
  } else {
    fail(`Provider ${config.current || '?'}`, '缺 url/apiKey/model')
  }

  // 4. git 可用
  try {
    execFileSync('git', ['--version'], { encoding: 'utf-8' })
    ok('git 可用')
  } catch { fail('git', '未安装或不在 PATH') }

  // 5. 工作区可写
  try {
    const testFile = './.doctor-test'
    writeFileSync(testFile, 'test', 'utf-8')
    unlinkSync(testFile)
    ok('工作区可写')
  } catch { fail('工作区可写', '无法写入当前目录') }

  // 6. 工具输出目录可写（新增）
  try {
    const toolOutDir = join(homedir(), '.claude-code-mobile', 'tool-output')
    if (!existsSync(toolOutDir)) mkdirSync(toolOutDir, { recursive: true })
    const tf = join(toolOutDir, '.doctor-test')
    writeFileSync(tf, 'test', 'utf-8')
    unlinkSync(tf)
    ok('工具输出目录可写 (~/.claude-code-mobile/tool-output/)')
  } catch (e) { fail('工具输出目录', e.message) }

  // 7. 输入历史持久化（新增）
  try {
    const histFile = join(homedir(), '.claude-code-mobile', 'input-history.json')
    if (existsSync(histFile)) ok(`输入历史文件存在 (${statSync(histFile).size} 字节)`)
    else info('输入历史文件不存在（首次使用时自动创建）')
  } catch {}

  // 8. sessions 目录 + 最近 session（新增）
  try {
    const sessDir = extras.sessionsDir || join(homedir(), '.claude-code-mobile', 'sessions')
    if (existsSync(sessDir)) {
      const files = readdirSync(sessDir).filter(f => f.endsWith('.json'))
      ok(`sessions/ 目录 (${files.length} 个会话)`)
    } else info('sessions/ 目录不存在')
  } catch {}

  // 9. skills 目录（项目 + 全局）
  // 项目 skills 实际在 .claude/skills（不是 ./skills），两处都看
  {
    const projSkills = [
      join(process.cwd(), '.claude', 'skills'),
      join(process.cwd(), 'skills'),
    ]
    const foundProj = projSkills.filter(p => existsSync(p))
    if (foundProj.length) ok(`项目 skills/ 存在 (${foundProj[0]})`)
    else info('项目 skills/ 不存在（可选）')
  }
  try {
    const g = globalSkillsDir()
    if (existsSync(g)) ok(`全局 skills 存在 (${g})`)
    else info(`全局 skills 可选: ${g}`)
  } catch {
    info('全局 skills 检查跳过')
  }

  // 10. CLAUDE.md（项目记忆）
  // 【2026-10-04 修】原来看 './CLAUDE.md'（cwd 相对），但 /memory 写的是
  // DATA_DIR/CLAUDE.md，两者不是同一个文件 —— 表现为「这里说不存在、
  // Context Usage Warnings 又说 141k 字符」的自相矛盾。统一列全部真实路径。
  {
    const memPaths = [
      join(DATA_DIR, 'CLAUDE.md'),                       // 用户级（/memory 写入处）
      join(process.cwd(), 'CLAUDE.md'),                  // 项目级
      join(homedir(), '.claude', 'CLAUDE.md'),           // 官方兼容路径
    ]
    const found = memPaths.filter(p => existsSync(p))
    if (found.length) {
      ok(`CLAUDE.md 存在 (${found.length} 处)`)
      for (const p of found) {
        try {
          const chars = readFileSync(p, 'utf-8').length
          checks.push(`      ${p} (${chars.toLocaleString()} 字符 / ${statSync(p).size.toLocaleString()} 字节)`)
        } catch {}
      }
    } else {
      info('CLAUDE.md 不存在（可选，用 /memory 创建）')
    }
  }

  section('Providers')

  // 11. Provider 连通性探测（status-probe 复用：测各 Provider URL 的 host:port）
  try {
    const providers = config.providers || {}
    const entries = Object.entries(providers)
    if (entries.length > 0) {
      const lines = []
      for (const [id, p] of entries) {
        try {
          const u = new URL(p.url || '')
          const host = u.hostname
          const port = u.port || (u.protocol === 'https:' ? 443 : 80)
          const r = probePort(host, parseInt(port), 3000)
          const mark = r.status === 'available' ? '✓' : r.status === 'unavailable' ? '✗' : '?'
          const cur = id === config.current ? ' ←当前' : ''
          lines.push(`  ${mark} Provider ${id} ${p.name || ''} (${host}:${port})${cur}`)
        } catch { lines.push(`  ? Provider ${id} URL 解析失败`) }
      }
      checks.push(...lines)
    } else info('无 Provider 配置')
  } catch { info('Provider 探测跳过') }

  section('Environment')

  // 11. hooks.json（配置在用户数据目录，2026-10-03 起）
  const hooksPath = resolveConfigPath('hooks.json')
  if (existsSync(hooksPath)) {
    try {
      JSON.parse(readFileSync(hooksPath, 'utf-8'))
      ok(`hooks.json 存在且 JSON 合法 (${hooksPath})`)
    } catch { fail('hooks.json', 'JSON 解析失败') }
  } else info('hooks.json 不存在（可选）')

  // 12. permissions.json（配置在用户数据目录）
  const permPath = resolveConfigPath('permissions.json')
  if (existsSync(permPath)) {
    try {
      JSON.parse(readFileSync(permPath, 'utf-8'))
      ok(`permissions.json 存在且 JSON 合法 (${permPath})`)
    } catch { fail('permissions.json', 'JSON 解析失败') }
  } else info('permissions.json 不存在（可选）')

  // 13. LSP 服务器可用性（新增）
  try {
    const tsLsp = join(homedir(), '.claude-code-mobile/../usr/lib/node_modules/typescript-language-server/lib/cli.mjs')
    if (existsSync('/data/data/com.termux/files/usr/lib/node_modules/typescript-language-server/lib/cli.mjs')) {
      ok('typescript-language-server 已安装')
    } else fail('typescript-language-server', '未安装 (npm i -g typescript-language-server)')
    if (existsSync('/data/data/com.termux/files/usr/lib/node_modules/pyright/langserver.index.js')) {
      ok('pyright 已安装')
    } else fail('pyright', '未安装 (npm i -g pyright)')
  } catch {}

  // 14. Termux 基础能力（新增）
  try {
    execFileSync('termux-battery-status', [], { encoding: 'utf-8', shell: '/system/bin/sh', timeout: 3000 })
    ok('termux-battery-status 可用')
  } catch { fail('termux-battery-status', '未安装 (pkg install termux-api)') }
  try {
    execFileSync('termux-wake-lock', [], { encoding: 'utf-8', shell: '/system/bin/sh', timeout: 3000 })
    // 立刻 unlock 避免持续唤醒
    try { execFileSync('termux-wake-unlock', [], { encoding: 'utf-8', shell: '/system/bin/sh', timeout: 3000 }) } catch {}
    ok('termux-wake-lock 可用')
  } catch { fail('termux-wake-lock', '未安装') }

  // 15. MCP 服务器（用真实路径 resolveConfigPath('mcp.json')，原来写死
  //     './mcp-servers.json' 是错的——那个文件根本不存在，所以这项一直静默跳过）
  try {
    const mcpConfigFile = resolveConfigPath('mcp.json')
    if (existsSync(mcpConfigFile)) {
      const cfg = JSON.parse(readFileSync(mcpConfigFile, 'utf-8'))
      const servers = cfg.mcpServers || cfg.servers || {}
      const names = Object.keys(servers)
      const disabled = names.filter(n => servers[n]?.disabled)
      ok(`MCP 配置: ${names.length} 个服务器${disabled.length ? `（${disabled.length} 个已禁用）` : ''}${names.length ? ' — ' + names.slice(0, 6).join(', ') : ''}`)
    } else info('无 MCP 配置（可选）')
  } catch (e) { fail('MCP 配置解析', e.message) }

  // 16. 自动任务（新增）
  try {
    const autoDir = join(homedir(), '.claude-code-mobile', 'auto-tasks')
    if (existsSync(autoDir)) {
      const tasks = readdirSync(autoDir).filter(f => f.endsWith('.json'))
      if (tasks.length > 0) {
        const running = tasks.filter(f => {
          try { return JSON.parse(readFileSync(join(autoDir, f), 'utf-8')).status === 'running' } catch { return false }
        }).length
        ok(`自主任务目录: ${tasks.length} 个任务文件${running > 0 ? ` (${running} 个 running)` : ''}`)
      } else info('无自主任务')
    } else info('自主任务目录未创建')
  } catch {}

  // ── 17. 上下文占用警告（对齐官方 Context Usage Warnings）──────
  // 官方逻辑（utils/doctorContextWarnings.ts）：这三项都不算"错误"，
  // 而是"每轮都在吃上下文、该瘦身了"的提醒。超阈值只警告、不判失败。
  const warnings = []

  // 17a. CLAUDE.md 过大（官方阈值 40000 字符）
  try {
    const memFiles = [
      join(DATA_DIR, 'CLAUDE.md'),                      // 用户级（本项目记忆主文件）
      join(process.cwd(), 'CLAUDE.md'),                 // 项目级
      join(homedir(), '.claude', 'CLAUDE.md'),          // 官方兼容路径
    ]
    const large = []
    let totalChars = 0
    for (const f of memFiles) {
      if (!existsSync(f)) continue
      try {
        const len = readFileSync(f, 'utf-8').length
        totalChars += len
        if (len > MAX_MEMORY_CHARS) large.push({ path: f, len })
      } catch {}
    }
    if (large.length) {
      warnings.push(`Large CLAUDE.md file detected (${large[0].len.toLocaleString()} chars > ${MAX_MEMORY_CHARS.toLocaleString()})`)
      for (const f of large.slice(0, 3)) {
        warnings.push(`  ${f.path}: ${f.len.toLocaleString()} chars`)
      }
    } else if (totalChars > 0) {
      checks.push(`  ○ CLAUDE.md 共 ${totalChars.toLocaleString()} 字符（阈值 ${MAX_MEMORY_CHARS.toLocaleString()}）`)
    }
  } catch {}

  // 17b. 自定义 agent 描述过大（官方阈值 15000 tokens）
  // 这些描述每轮都进系统提示词，agent 多了会明显吃上下文。
  try {
    const agentDirs = [
      join(process.cwd(), '.claude', 'agents'),
      join(homedir(), '.claude-code-mobile', 'agents'),
      join(homedir(), '.claude', 'agents'),
    ]
    let totalTokens = 0
    const perAgent = []
    for (const dir of agentDirs) {
      if (!existsSync(dir)) continue
      let files = []
      try { files = readdirSync(dir).filter(f => f.endsWith('.md')) } catch { continue }
      for (const f of files) {
        try {
          const raw = readFileSync(join(dir, f), 'utf-8')
          const t = roughTokens(raw)
          totalTokens += t
          perAgent.push({ name: f.replace(/\.md$/, ''), tokens: t })
        } catch {}
      }
    }
    if (totalTokens > AGENT_DESC_TOKENS) {
      warnings.push(`Large agent descriptions (~${totalTokens.toLocaleString()} tokens > ${AGENT_DESC_TOKENS.toLocaleString()})`)
      perAgent.sort((a, b) => b.tokens - a.tokens)
      for (const a of perAgent.slice(0, 5)) {
        warnings.push(`  ${a.name}: ~${a.tokens.toLocaleString()} tokens`)
      }
      if (perAgent.length > 5) warnings.push(`  (${perAgent.length - 5} more custom agents)`)
    } else if (perAgent.length) {
      checks.push(`  ○ 自定义 agent ${perAgent.length} 个，共 ~${totalTokens.toLocaleString()} tokens（阈值 ${AGENT_DESC_TOKENS.toLocaleString()}）`)
    }
  } catch {}

  // 17c. MCP 工具上下文过大（官方阈值 25000 tokens）
  try {
    const mcpConfigFile = resolveConfigPath('mcp.json')
    if (existsSync(mcpConfigFile)) {
      const cfg = JSON.parse(readFileSync(mcpConfigFile, 'utf-8'))
      const servers = cfg.mcpServers || cfg.servers || {}
      const names = Object.keys(servers)
      let mcpToolTokens = 0
      const perServer = []
      for (const n of names) {
        const s = servers[n] || {}
        // 无法在诊断时实际连接 MCP 拉工具表，用配置里已知的提示估算
        const est = roughTokens(JSON.stringify(s))
        perServer.push({ name: n, tokens: est })
        mcpToolTokens += est
      }
      if (mcpToolTokens > MCP_TOOLS_TOKENS) {
        warnings.push(`Large MCP tools context (~${mcpToolTokens.toLocaleString()} tokens estimated > ${MCP_TOOLS_TOKENS.toLocaleString()})`)
        perServer.sort((a, b) => b.tokens - a.tokens)
        for (const s of perServer.slice(0, 5)) {
          warnings.push(`  ${s.name}: ~${s.tokens.toLocaleString()} tokens`)
        }
      } else {
        checks.push(`  ○ MCP 服务器 ${names.length} 个（配置估算 ~${mcpToolTokens.toLocaleString()} tokens，阈值 ${MCP_TOOLS_TOKENS.toLocaleString()}）`)
      }
    }
  } catch {}

  if (warnings.length) {
    section('Context Usage Warnings')
    for (const w of warnings) checks.push(`  ⚠ ${w}`)
  }

  // 【2026-09-24 加】命令降级统计。
  //
  // Web 侧的执行路径是：先查注册表（复用的 CLI 实现），抛错则回退到手写分支。
  // 回退是**有意的容错**（单个模块的 bug 不该让命令完全失效），
  // 但原来只在 console 打一行 —— 用户永远看不到，于是「静默降级」变成「命令没反应」。
  //
  // 这里把降级事件列出来（由 server.mjs 累计到 runtime.slashFallbacks）。
  // 看到这个清单说明有命令在走下坡路，应该去修对应的 ctx 字段。
  const fallbacks = extras.slashFallbacks
  if (Array.isArray(fallbacks) && fallbacks.length > 0) {
    checks.push('')
    checks.push(`⚠️ 命令降级 ${fallbacks.length} 个（注册表实现抛错，走了兜底分支）：`)
    for (const f of fallbacks.slice(-8)) {
      checks.push(`  · /${f.name} ×${f.count} — ${String(f.msg).slice(0, 60)}`)
    }
    checks.push('  （这是 Web/CCM 侧的兼容问题，Termux 侧不受影响）')
  }

  return `诊断结果:\n${checks.join('\n')}`
}

// /stats — 使用统计
export function cmdStats(agent, sessionStartTime) {
  const usage = agent.getTokenUsage()
  const lastPrompt = agent.getLastPromptTokens()
  const elapsed = sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const history = agent.getHistory()
  const userMsgs = history.filter(m => m.role === 'user').length
  const assistantMsgs = history.filter(m => m.role === 'assistant').length
  const apiCalls = Math.max(1, assistantMsgs)
  return `会话统计:
  时长: ${mins}m ${secs}s
  消息: ${history.length} (用户 ${userMsgs}, 助手 ${assistantMsgs})
  当前上下文: ${lastPrompt} tokens
  累计输出: ${usage.output} tokens
  平均每轮输出: ${Math.round(usage.output / apiCalls)} tokens`
}

// /memory — 编辑 CLAUDE.md
export function cmdMemory(args) {
  // 【2026-10-03】CLAUDE.md 是用户数据（项目记忆），移到数据目录。
  // 原来是相对路径 './CLAUDE.md' → 跟着 cwd 走，且被 git 跟踪。
  const path = join(DATA_DIR, 'CLAUDE.md')
  if (args[0] === 'show' || !args[0]) {
    if (!existsSync(path)) return 'CLAUDE.md 不存在。用 /memory init 创建，或 /memory edit 编辑。'
    return readFileSync(path, 'utf-8')
  }
  if (args[0] === 'init') {
    if (existsSync(path)) return 'CLAUDE.md 已存在。用 /memory show 查看，/memory edit 编辑。'
    writeFileSync(path, '# CLAUDE.md\n\n本项目的工作约定和笔记。\n\n## 构建和测试\n- \n\n## 代码风格\n- \n', 'utf-8')
    return '已创建 CLAUDE.md'
  }
  if (args[0] === 'append') {
    const text = args.slice(1).join(' ')
    if (!text) return '用法: /memory append <要追加的文本>'
    const cur = existsSync(path) ? readFileSync(path, 'utf-8') : ''
    writeFileSync(path, cur + '\n' + text + '\n', 'utf-8')
    return '已追加到 CLAUDE.md'
  }
  return '用法:\n  /memory            查看 CLAUDE.md\n  /memory init       创建 CLAUDE.md\n  /memory append <文本>  追加内容'
}

// /branch — 对话分支
// 在当前点复制会话为一个新 session，可以继续不同的方向
export function cmdBranch(sessionStore, sessionId, agent, todos, args) {
  const branchName = args[0] || `branch-${Date.now().toString(36)}`
  // 复制当前会话状态
  const newId = randomBytes(8).toString('hex')
  const data = {
    sessionId: newId,
    title: branchName,
    messages: agent.getHistory(),
    todos: todos.slice(),
    tokenUsage: agent.getTokenUsage(),
    branchedFrom: sessionId,
    branchedAt: new Date().toISOString(),
  }
  sessionStore.save(newId, data)
  return `已创建分支: ${branchName}\n  会话ID: ${newId}\n  从当前 ${data.messages.length} 条消息处分叉\n用 /resume ${newId} 切换到此分支`
}

// /rewind — 检查点恢复（增强版 undo）
// 列出最近的可恢复点，或恢复到指定点
export function cmdRewind(multiUndo, agent, sessionStore, sessionId, args) {
  // `/rewind undo` —— 一步撤销最近一次改动（对齐官方 2.1.303 把 undo 列为 rewind 别名）
  //
  // 【为什么做成子命令而不是 COMMAND_ALIASES 里的 undo → rewind 映射】
  // CCM 的 /undo 是独立命令（立即撤销，一步到位），而 /rewind 的默认动作是
  // **列检查点**（两步：先看列表，再挑一个恢复）。把 undo 映射成 rewind
  // 等于把「一步」变成「两步」，是行为退化。
  // 所以这里给 rewind 加一个 undo 子命令：想用官方拼法的人敲 /rewind undo
  // 得到的就是「撤销最近一次」，与 /undo 完全等价。
  if (args[0] === 'undo') {
    const results = multiUndo.undo()
    return results.length > 0 ? results.join('\n') : '没有可撤销的操作'
  }
  if (args[0] === 'list' || !args[0]) {
    const snaps = multiUndo.listSnapshots(50)
    if (snaps.length === 0) return '没有可恢复的检查点。\n修改文件后会自动创建快照。'
    return '可恢复的检查点:\n' + snaps.map((s, i) => `  ${i + 1}. ${s.file} (${s.timestamp})`).join('\n')
  }
  if (args[0] === 'file') {
    // 恢复单个文件
    const idx = parseInt(args[1]) - 1
    const snaps = multiUndo.listSnapshots()
    if (isNaN(idx) || idx < 0 || idx >= snaps.length) return '用法: /rewind file <序号>（用 /rewind list 查看）'
    const snap = snaps[idx]
    if (!existsSync(snap.snapshotPath)) return `快照不存在: ${snap.snapshotPath}`
    copyFileSync(snap.snapshotPath, snap.file)
    return `已恢复 ${snap.file}`
  }
  if (args[0] === 'diff') {
    // 查看某检查点与当前文件的差异（可视化回滚预览）
    const idx = parseInt(args[1]) - 1
    const snaps = multiUndo.listSnapshots()
    if (isNaN(idx) || idx < 0 || idx >= snaps.length) return '用法: /rewind diff <序号>（用 /rewind list 查看序号）'
    const snap = snaps[idx]
    if (!existsSync(snap.snapshotPath)) return `快照不存在: ${snap.snapshotPath}`
    const oldContent = readFileSync(snap.snapshotPath, 'utf-8')
    let curContent = ''
    try { curContent = readFileSync(snap.file, 'utf-8') } catch {}
    const oldLines = oldContent.split('\n')
    const curLines = curContent.split('\n')
    // 简单行级 diff（LCS 太复杂，用前缀/后缀匹配显示差异区域）
    let samePrefix = 0
    while (samePrefix < Math.min(oldLines.length, curLines.length) && oldLines[samePrefix] === curLines[samePrefix]) samePrefix++
    let sameSuffix = 0
    while (sameSuffix < Math.min(oldLines.length - samePrefix, curLines.length - samePrefix) &&
           oldLines[oldLines.length - 1 - sameSuffix] === curLines[curLines.length - 1 - sameSuffix]) sameSuffix++
    const out = []
    out.push(`检查点 ${idx + 1}: ${snap.file} (${snap.timestamp})`)
    out.push(`  快照 ${oldLines.length} 行 / 当前 ${curLines.length} 行`)
    out.push('')
    const start = samePrefix
    const oldEnd = oldLines.length - sameSuffix
    const curEnd = curLines.length - sameSuffix
    for (let i = start; i < Math.max(oldEnd, curEnd); i++) {
      const oldL = i < oldEnd ? oldLines[i] : null
      const curL = i < curEnd ? curLines[i] : null
      if (oldL !== curL) {
        if (oldL !== null) out.push(`- ${oldL}`)
        if (curL !== null) out.push(`+ ${curL}`)
      }
    }
    out.push('')
    out.push('要恢复执行: /rewind file <序号>')
    return out.slice(0, 60).join('\n') + (out.length > 60 ? `\n... (共 ${out.length} 行)` : '')
  }
  if (args[0] === 'msgs' || args[0] === 'messages') {
    // 回退到 N 条消息前
    const n = parseInt(args[1]) || 1
    const history = agent.getHistory()
    if (n >= history.length) return `只有 ${history.length} 条消息，不能回退 ${n} 条`
    const kept = history.slice(0, history.length - n)
    agent.setHistory(kept)
    return `已回退 ${n} 条消息（当前 ${kept.length} 条）`
  }
  return '用法:\n  /rewind             列出文件检查点\n  /rewind undo        撤销最近一次改动（等价 /undo，一步到位）\n  /rewind file <序号>  恢复文件到检查点\n  /rewind diff <序号>  查看检查点与当前文件的差异\n  /rewind msgs <N>    回退 N 条消息'
}

/**
 * /code-review —— 代码审查（官方 2.1.303 的正式名，/review 是它的别名）
 *
 * 【为什么不是新写一套】官方 2.1.303 把 code-review 做成了打包 skill
 * （`subcommands: { ultra: "ultrareview" }`，即 `/code-review ultra` 转发到
 * /ultrareview）。那是生态功能（云端 ultrareview），按本轮范围排除。
 *
 * CCM 已有的 /review 是**本地静态扫描**（git 状态、可疑文件、超大文件、
 * .gitignore 检查），不调 API、零成本。这个能力本身有价值，只是名字
 * 和官方不一致。所以：
 *   · 名字对齐官方 —— /code-review 是正式入口
 *   · /review 保留为别名（历史会话、CLAUDE.md 里到处都是）
 *   · 两者的实现是**同一份** cmdReview，不存在漂移
 *
 * 【为什么不加 ultra 子命令】那是订阅计费 + 云端服务，本轮明确排除。
 * 敲 /code-review ultra 会得到一句「本机没有这个子命令」+ 现有能力提示，
 * 而不是静默当成普通 review 跑一遍（那会让用户以为 ultra 生效了）。
 */
export function cmdCodeReview(args) {
  const sub = String(args[0] || '').toLowerCase()
  if (sub === 'ultra') {
    return [
      '/code-review ultra 是官方的云端深度审查（订阅功能），CCM 没有这条路径。',
      '',
      '本机能做的是本地静态扫描：',
      '  /code-review         扫描工作区（git 状态 / 可疑文件 / 超大文件 / .gitignore）',
      '',
      '需要「模型视角的审查」时，直接说「审查一下 xxx 的改动」即可 ——',
      '那是主对话用 Read/Grep/GitDiff 现看，比云端服务更贴近当前上下文。',
    ].join('\n')
  }
  return cmdReview(args)
}

// /plugins — 查看/启用/禁用内置插件
export function cmdPlugins(args) {
  if (!args[0] || args[0] === 'list') {
    const list = listPlugins()
    if (list.length === 0) return '没有已注册的插件。\n用法: /plugins enable <名> / /plugins disable <名>'
    return '已注册插件:\n' + list.map(p => `  ${p.name}  ${p.enabled ? '[启用]' : '[禁用]'}  ${p.description}`).join('\n') +
      '\n\n用法: /plugins enable <名> | /plugins disable <名>'
  }
  if (args[0] === 'enable' && args[1]) return enablePlugin(args[1]).message || enablePlugin(args[1]).error
  if (args[0] === 'disable' && args[1]) return disablePlugin(args[1]).message || disablePlugin(args[1]).error
  return '用法: /plugins [list|enable <名>|disable <名>]'
}

// /permissions — 权限规则管理
// 简化版：读写 permissions.json
const PERM_FILE = resolveConfigPath('permissions.json')
const PERM_DEFAULTS = {
  allow: [],     // 始终允许的工具
  deny: [],      // 始终拒绝的工具
  ask: [],       // 每次询问的工具
}
function loadPerms() {
  try { return { ...PERM_DEFAULTS, ...JSON.parse(readFileSync(PERM_FILE, 'utf-8')) } }
  catch { return { ...PERM_DEFAULTS } }
}
function savePerms(perms) {
  atomicWrite(PERM_FILE, JSON.stringify(perms, null, 2), 'utf-8')
}
export function cmdPermissions(args) {
  const perms = loadPerms()
  if (!args[0] || args[0] === 'show') {
    return `权限规则 (${PERM_FILE}):
  允许: ${perms.allow.length ? perms.allow.join(', ') : '(空)'}
  拒绝: ${perms.deny.length ? perms.deny.join(', ') : '(空)'}
  询问: ${perms.ask.length ? perms.ask.join(', ') : '(空)'}

用法:
  /permissions allow <工具名>   添加到允许列表
  /permissions deny <工具名>    添加到拒绝列表
  /permissions ask <工具名>     添加到询问列表
  /permissions remove <工具名>  从所有列表移除`
  }
  const action = args[0]
  const tool = args[1]
  if (!tool) return `缺少工具名。用法: /permissions ${action} <工具名>`
  if (action === 'remove') {
    perms.allow = perms.allow.filter(t => t !== tool)
    perms.deny = perms.deny.filter(t => t !== tool)
    perms.ask = perms.ask.filter(t => t !== tool)
    savePerms(perms)
    return `已移除 ${tool} 的权限规则`
  }
  if (action === 'allow' || action === 'deny' || action === 'ask') {
    // 先从其他列表移除
    perms.allow = perms.allow.filter(t => t !== tool)
    perms.deny = perms.deny.filter(t => t !== tool)
    perms.ask = perms.ask.filter(t => t !== tool)
    perms[action].push(tool)
    savePerms(perms)
    return `已设置: ${tool} → ${action}`
  }
  return `未知操作: ${action}。用 allow/deny/ask/remove`
}

// /copy — 复制最后一条助手回复到剪贴板
/**
 * /copy [N] —— 复制助手回复到剪贴板。
 *
 * 官方：`Copy Claude's last response to clipboard (or /copy N for the Nth-latest)`。
 * CCM 原来只取最后一条，N 这个用法敲了会被当成无参（args 根本没往下传）。
 *
 * 【N 的语义】N 是「倒数第 N 条」，从 1 开始：
 *   /copy 或 /copy 1 → 最后一条
 *   /copy 2          → 倒数第二条
 * 与官方一致。越界给出明确提示（并告知总共有几条），不要静默复制错的。
 */
export function cmdCopy(agent, args = []) {
  const history = agent.getHistory()
  // 收集所有非空 assistant 文本，从新到旧
  const texts = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== 'assistant') continue
    const content = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : ''
    if (content) texts.push(content)
  }
  if (texts.length === 0) return '没有可复制的助手回复'

  // 解析 N（省略 = 1）
  const raw = Array.isArray(args) ? String(args[0] ?? '').trim() : String(args ?? '').trim()
  let n = 1
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      return `用法: /copy（最后一条）或 /copy N（倒数第 N 条，N 从 1 开始）`
    }
    n = parseInt(raw, 10)
    if (n < 1) return 'N 必须 ≥ 1（1 = 最后一条）'
    if (n > texts.length) {
      return `只有 ${texts.length} 条助手回复，取不到倒数第 ${n} 条`
    }
  }

  const content = texts[n - 1]
  try {
    // 数组传参、不走 shell，避免内容含 $ ` ; 时命令注入
    // 路径探测：Termux 在 $PREFIX/bin，CCM(proot) 里没有（走桥）
    const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr'
    const candidates = [
      `${prefix}/bin/termux-clipboard-set`,
      '/data/data/com.termux/files/usr/bin/termux-clipboard-set',
    ]
    const bin = candidates.find(c => { try { return existsSync(c) } catch { return false } })
    if (!bin) return '剪贴板不可用（Termux 需装 termux-api；CCM 走原生桥）'
    execFileSync(bin, [content], { timeout: 5000 })
    const which = n === 1 ? '最后一条' : `倒数第 ${n} 条`
    return `已复制${which}回复到剪贴板 (${content.length} 字符)`
  } catch (e) {
    return `复制失败: ${e.message}`
  }
}

// /temperature — 设置 API 温度
export function cmdTemperature(args, config, api, saveConfig) {
  if (!args[0]) {
    return `当前温度: ${config.temperature ?? 1}\n用法: /temperature <0.0-2.0>\n  0.0 = 完全确定性\n  1.0 = 默认\n  2.0 = 最随机`
  }
  const v = parseFloat(args[0])
  if (isNaN(v) || v < 0 || v > 2) return '温度必须在 0.0 到 2.0 之间'
  config.temperature = v
  if (config.providers?.[config.current]) config.providers[config.current].temperature = v
  if (typeof saveConfig === 'function') saveConfig(config)
  else {
    try { atomicWrite(resolveConfigPath('config.json'), JSON.stringify(config, null, 2), 'utf-8') } catch {}
  }
  if (api) api.temperature = v
  return `温度已设为: ${v}`
}

// 【2026-10-22 删除 /add-dir】
//
// 它一直是无效命令：cmdAddDir 把路径 push 进模块级数组 extraDirs，
// 而 getExtraDirs() 全文零调用，文件工具也没有任何目录白名单 ——
// core/tools/file-tools.mjs 的 toolPath() 只有一行 `resolve(ctx.cwd || process.cwd(), filePath)`，
// Read/Write/Edit/Glob/Grep 对任何绝对路径都直接放行（实测 grep
// allowedDirs|whitelist|allowlist|allowedPaths|sandboxRoot 在 core/ 下零命中，
// core/permission/ 只有 bash 命令的 AST 解析，不管文件路径）。
//
// 也就是说：CCM 本来就没有「可读目录」这个概念，/add-dir 加进去的目录
// 从来没有被任何工具读过，命令返回的「已添加」纯属误导，而且不落盘、重启即丢。
//
// 为什么不选「把 extraDirs 接进文件工具」：那等于给一个当前完全开放的
// 文件系统凭空加一道白名单，会把「读 /sdcard 任意路径」「读 ~/.claude」这类
// 现有正常用法全部拦掉 —— 为了保住一条命令而制造一个假机制，代价远大于收益。
// 真要限制目录该是独立设计（配合 /permissions 的 deny 规则），不该由 /add-dir 顺手带上。
//
// 替代：/workspace [路径] 设置主工作区（写 config.json，注入系统提示词，真实生效）。

function normalizeProviderMaxOutputTokens(provider) {
  const value = Number(provider?.maxOutputTokens)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

// Provider 切换时，配置文件和存活的 ApiClient 都必须同步。
// 不能只换 URL/key/model：例如从 systemTopLevel provider 切走时，旧的顶层 system 会被带到新端点。
export function syncActiveProvider(config, api, provider) {
  const apiKeys = Array.isArray(provider.apiKeys)
    ? provider.apiKeys.filter(key => typeof key === 'string' && key.trim())
    : []
  const apiKey = provider.apiKey || apiKeys[0] || ''
  // 配置可能来自旧版本、手工编辑、或用户把完整 /chat/completions 粘进了 /url。
  // 每次同步活跃 Provider 都正规化一次，确保运行中的 api 和落盘 config 不漂移。
  provider.url = normalizeProviderUrl(provider.url, provider.protocol || 'openai')

  config.url = provider.url
  config.apiKey = apiKey
  config.apiKeys = apiKeys.length ? apiKeys : null
  config.model = provider.model
  config.protocol = provider.protocol || 'openai'
  config.systemTopLevel = provider.systemTopLevel === true
  config.maxOutputTokens = normalizeProviderMaxOutputTokens(provider)
  config.temperature = Number.isFinite(Number(provider.temperature)) ? Number(provider.temperature) : (config.temperature ?? 1)
  config.noTools = !!provider.noTools
  config.vision = provider.vision === true

  if (!api) return
  api.baseUrl = provider.url.replace(/\/$/, '')
  if (api.setKeys) api.setKeys(apiKeys, apiKey)
  else api.apiKey = apiKey
  api.model = provider.model
  api.protocol = config.protocol
  api.systemTopLevel = config.systemTopLevel
  api.maxOutputTokens = config.maxOutputTokens
  api.promptCacheRetention = provider.promptCacheRetention === '24h' ? '24h' : null
  api.promptCacheEnabled = provider.promptCacheEnabled === true
  // 不再清能力降级标志：它们现在按「协议|端点|模型」存（api.mjs 的 _endpointKey），
  // 换 provider 后自动读到新端点的结论，不会连坐。
  // 切走再切回同一端点时结论还在 —— 这是正确的（能力是端点的固有属性，不必重探）。
  // 想强制重探的话走 /effort 那类显式用户动作（那里会 clearThinkingCompatibilityFallback）。
  api.temperature = config.temperature
  // thinking 配置：provider.thinking 优先（每配置独立），没有则 fallback 全局 config.thinking
  const t = provider.thinking || config.thinking || {}
  // effort 缺失 = auto 档，必须原样传 undefined 而不是补成 'high' ——
  // 补 high 会让 /effort auto 在切 Provider 后悄悄变回 high（见 api.mjs getThinkingPolicy）
  api.thinkingConfig = t.enabled ? { enabled: true, ...(t.effort ? { effort: t.effort } : {}) } : null
  // 思考回传开关（/effort replay on|off）：跟 thinkingConfig 同一份配置树。
  // 默认关：只有显式 replay: true 才回传（新建 Provider / 未配置都省上下文）
  api.replayReasoning = t.replay === true
  // noTools：随 provider 切换（部分网关/模型收到 tools 参数会挂起）
  api.noTools = config.noTools
}

/** 获取当前 provider 生效的 thinking 配置（provider.thinking 优先，fallback 全局） */
export function effectiveThinkingFor(provider, config) {
  const p = provider?.thinking
  if (p && typeof p === 'object' && (p.enabled !== undefined || p.effort !== undefined)) return p
  return config?.thinking || {}
}

/**
 * 持久化 key 池自动换号后的当前 key。
 * 冷却状态写入 key-pool-state.json 还不够：config.json 的 provider.apiKey
 * 也要跟着更新，否则重启后仍优先从第一个 key 开始。
 * 只通过池索引取 key，不把明文 key 放进切换日志；apiKeys 列表保持不变。
 */
export function persistActivePoolKey(config, api, toIndex, saveConfig) {
  const provider = config?.providers?.[config.current]
  const poolKeys = api?.keyPool?.keys
  const index = Number(toIndex)
  if (!provider || !Array.isArray(provider.apiKeys) || !Array.isArray(poolKeys) || !Number.isInteger(index)) return false
  const selected = poolKeys[index]
  if (!selected || !provider.apiKeys.some(key => typeof key === 'string' && key.trim() === selected)) return false
  if (provider.apiKey === selected && config.apiKey === selected) return false
  provider.apiKey = selected
  config.apiKey = selected
  if (typeof saveConfig === 'function') saveConfig(config)
  return true
}

// /x11 — 控制 Playwright MCP 是否**主动把 Termux:X11 APP 拉到前台**
//
// 【语义修正 2026-09-13】原来 off 表示「压根不启动 X11」，导致用户手动打开
// Termux:X11 APP 也是空白（没有 X server 可画）。现在：
//   on   浏览器可见 + 自动把 X11 APP 拉到前台
//   off  浏览器仍在后台 X server 上渲染，但不抢前台 —— 用户想盯就自己开 APP
// 两种模式后台都有 X server，区别只在「谁决定 APP 何时到前台」。
export function cmdX11(args, mcpPath = MCP_PATH) {
  const sub = String(args[0] || 'status').toLowerCase()
  if (!['on', 'off', 'status'].includes(sub)) {
    return '用法: /x11 on|off|status\n'
      + '  on      浏览器可见，并自动把 Termux:X11 APP 拉到前台\n'
      + '  off     不抢前台，但后台仍起 X server —— 你可以自己打开 X11 APP 盯浏览器\n'
      + '  status  查看当前设置'
  }

  let cfg
  try {
    cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'))
  } catch (e) {
    return `读取 MCP 配置失败: ${e.message}`
  }
  const server = cfg?.mcpServers?.playwright
  if (!server || !Array.isArray(server.args)) {
    return '未找到 playwright MCP 配置，无法切换 X11'
  }

  const env = { ...(server.env || {}) }
  const isHeadless = server.args.includes('--headless')
  const autoStart = env.TBP_X11_AUTOSTART !== '0'
  const wrapper = server.args.some(arg => String(arg).includes('playwright-x11-wrapper.mjs'))

  if (sub === 'status') {
    return `Playwright X11:
  自动拉起 X11 APP: ${autoStart ? '开启（调用浏览器时把 APP 切到前台）' : '关闭（只后台起 X server，不抢前台）'}
  浏览器模式: ${isHeadless ? 'headless' : 'headed（可见）'}
  启动包装器: ${wrapper ? '已配置' : '未配置'}
  配置文件: ${mcpPath}

两种模式后台都有 X server —— off 时你手动打开 Termux:X11 APP 也能看到浏览器。
用法: /x11 on|off`
  }

  if (sub === 'on') {
    server.args = server.args.filter(arg => arg !== '--headless')
    env.DISPLAY = ':0'
    env.TBP_X11_AUTOSTART = '1'
    env.TBP_XDOTOOL_PATH ||= '/data/data/com.termux/files/usr/bin/xdotool'
    server.env = env
  } else {
    if (!server.args.includes('--headless')) server.args.push('--headless')
    env.TBP_X11_AUTOSTART = '0'
    server.env = env
  }

  try {
    atomicWrite(mcpPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch (e) {
    return `保存 MCP 配置失败: ${e.message}`
  }

  if (sub === 'on') {
    return '已开启 Playwright X11 自动启动。下次重启/加载 MCP 时会自动启动 Termux:X11 Activity、X server 和可见 Chromium。'
  }
  return '已关闭 Playwright X11 自动启动。下次重启/加载 MCP 时使用 headless Chromium，不启动 Termux:X11。'
}

// /config — 集中查看/切换配置
export function cmdConfig(args, config, api, saveConfig, onVisionConfig = null, opts = {}) {
  // /config [ID] test —— 测连通性（发真实请求，消耗少量额度）
  //   /config test      → 当前 Provider（原行为）
  //   /config 6 test    → 指定 Provider（一次性探测器，不切换配置、不动会话）
  // 注意判断要放在「切 Provider」分支（下一段）**之前** —— 否则 /config 6 test
  // 会被 args[0]='6' 先命中，直接切走，test 被忽略。
  const testTarget = args[0] === 'test'
    ? null
    : (args[1] === 'test' && (config.providers[args[0]] || /^\d+$/.test(String(args[0] ?? ''))) ? String(args[0]) : undefined)
  if (args[0] === 'test' || testTarget !== undefined) {
    const id = testTarget === null || testTarget === undefined ? config.current : testTarget
    const provider = config.providers[id]
    if (!provider) return `Provider ${id} 不存在（/config list 看可用列表）`
    if (id === config.current) {
      return api?.testConnection?.(10000).then(result => result.ok
        ? `Provider ${config.current} 连接正常 (${provider.model})`
        : `Provider ${config.current} 连接失败: ${result.error}`)
    }
    if (!api?.testProviderConnection) return '当前 api 实例不支持指定 Provider 测试（需重启到新版本）'
    return api.testProviderConnection(provider, 10000).then(result => result.ok
      ? `Provider ${id} (${provider.name}) 连接正常 (${provider.model})`
      : `Provider ${id} (${provider.name}) 连接失败: ${result.error}`)
  }
  // /config 1 2 3 4  ...  切换到 provider
  if (args[0] && config.providers[args[0]]) {
    const oldId = config.current
    const oldProvider = config.providers[oldId]
    config.current = args[0]
    const newProvider = config.providers[args[0]]
    syncActiveProvider(config, api, newProvider)
    onVisionConfig?.(newProvider, api)
    saveConfig(config)
    recordConfigEvent(`/config ${args[0]} → 已切换 Provider: ${oldProvider.name} (${oldId}) → ${newProvider.name} (${args[0]}), model=${newProvider.model}`)
    return `已切换 Provider: ${oldProvider.name} (${oldId}) → ${newProvider.name} (${args[0]})
  URL: ${newProvider.url}
  Model: ${newProvider.model}`
  }

  if (!args[0] || args[0] === 'show') {
    const currentProvider = config.providers[config.current]
    const thinking = config.thinking
    const thinkingState = thinking?.enabled ? `开启 (effort=${thinking.effort || 'max'}, show=${thinking.show === false ? '否' : '是'})` : '关闭'
    const streamState = config.stream === false ? '关闭' : '开启'
    let providerList = Object.entries(config.providers).map(([id, p]) => {
      const n = Array.isArray(p.apiKeys) ? p.apiKeys.length : (p.apiKey ? 1 : 0)
      const poolTag = n > 1 ? `  [${n} keys 轮换]` : ''
      // 协议标注：openai 是默认值不显示（绝大多数就是它，标出来是噪音）；
      // anthropic / responses 必须显示 —— 它们决定端点路径，排查 404 时先看这个。
      const protoTag = p.protocol && p.protocol !== 'openai' ? `  [${p.protocol}]` : ''
      return `  ${id}: ${p.name} - ${p.model}${poolTag}${protoTag}`
    }).join('\n')
    // key 池明细：哪个在用、哪个在冷却（额度耗尽后自动切换的可观测性）
    let keyLines = ''
    const kd = api?.describeKeys?.() || []
    if (kd.length > 1) {
      keyLines = '\n  Keys:\n' + kd.map(k => {
        const state = k.cooling ? `冷却中 ${k.cooldownMinutes}min（${k.reason || '额度/鉴权失败'}）` : (k.active ? '使用中' : '待用')
        return `    ${k.index}. ${k.key}  ${state}  ok=${k.ok} fail=${k.fail}`
      }).join('\n')
    }
    return `当前 Provider (${config.current}):
  Name: ${currentProvider.name}
  URL: ${currentProvider.url}
  Model: ${currentProvider.model}
  Vision: ${currentProvider.vision === true ? '当前模型' : (config.providers?.[config.visionProviderId || '8'] ? `配置${config.visionProviderId || '8'}（兜底）` : '未配置兜底')}
  Thinking: ${thinkingState}
  Effective: ${api?.describeThinkingPolicy?.() || '(unknown)'}
  Stream: ${streamState}${keyLines}

可用 Providers:
${providerList}

Commands:
  /config               留空进选择列表；/config list 看本详情
  /config 1 2 3 4  ...  切换 Provider（输入 ID）
  /model [id] <名称>    改模型（id 省略=当前 Provider）
  /url [id] <地址>      改 URL
  /name [id] <显示名>    改显示名（只改名字，不动编号）
  /key [id] <sk|pool k1 k2|setenv ENV|clear>  设 key / 多 key 轮换 / 引用环境变量 / 清空
  /config provider add                 交互式向导新增 Provider
  /config provider add [ID] name=<名> url=<地址> model=<模型> key=<sk-...>
                                       一行式（顺序无关；key 可给多个 = 轮换池）
  /config provider rm|rename|list      删除/重命名/列出 Provider
  /config provider rename <旧ID> <新ID>  改 Provider 编号（不是显示名，显示名用 /name）
  /config vision on|off|set <id>  当前 Provider 是否本模型识图；set 指定兜底识图 Provider
  /effort <档位|off|show|hide>  思考强度（none~max 从低到高）/ 关闭 / 显示开关
  /config stream on|off  流式输出开关
  /config [ID] test      测连通性（ID 省略 = 当前 Provider；带 ID 不切换配置）

按 key 直接设值（顺序无关，可一次给多个；值里有空格时只写一对）:
  /config stream=off                       等价于 /config stream off
  /config greeting=off replayHistory=on     一次设两项
  /config temperature=0.7
  /config maxContextTokens=200000
  /config markdownTheme=official
  /config permissionMode=acceptEdits
  /config compactThresholdTokens=270000 compactKeepLast=100
  可用 key: greeting / stream / replayHistory / temperature / maxContextTokens /
            compactThresholdTokens / compactThresholdMessages / compactKeepLast /
            markdownTheme / permissionMode
 `
  }
  if (args[0] === 'profile') {
    // Provider profile：可命名保存当前 Provider 配置，快速切换复用
    if (!config.profiles) config.profiles = {}
    const sub = args[1]
    if (!sub || sub === 'list') {
      const names = Object.keys(config.profiles)
      if (names.length === 0) return '没有保存的 profile。\n用法:\n  /config profile save <名>    保存当前 Provider 为 profile\n  /config profile load <名>    加载 profile\n  /config profile delete <名>  删除 profile'
      return '已保存的 profiles:\n' + names.map(n => {
        const p = config.profiles[n]
        return `  ${n}: ${p.name} (${p.model})`
      }).join('\n') + '\n\n用法:\n  /config profile save <名>    保存当前 Provider 为 profile\n  /config profile load <名>    加载 profile\n  /config profile delete <名>  删除 profile'
    }
    if (sub === 'save') {
      if (!args[2]) return '用法: /config profile save <名>'
      const cp = config.providers[config.current]
      if (!cp) return '当前没有可保存的 Provider'
      config.profiles[args[2]] = { ...cp }
      saveConfig(config)
      return `已保存 profile "${args[2]}"（${cp.name} / ${cp.model}）`
    }
    if (sub === 'load') {
      if (!args[2]) return '用法: /config profile load <名>'
      const p = config.profiles[args[2]]
      if (!p) return `profile 不存在: ${args[2]}（/config profile list 查看）`
      // 找到下一个空 id 或复用第一个可覆盖的
      let id = null
      for (let i = 1; i <= 20; i++) {
        if (!config.providers[String(i)]) { id = String(i); break }
      }
      if (!id) {
        // 全满：覆盖当前
        id = config.current
      }
      config.providers[id] = { ...p }
      config.current = id
      syncActiveProvider(config, api, p)
      saveConfig(config)
      return `已加载 profile "${args[2]}" → Provider ${id}（${p.name} / ${p.model}）`
    }
    if (sub === 'delete') {
      if (!args[2]) return '用法: /config profile delete <名>'
      if (!config.profiles[args[2]]) return `profile 不存在: ${args[2]}`
      delete config.profiles[args[2]]
      saveConfig(config)
      return `已删除 profile "${args[2]}"`
    }
    return '用法: /config profile save|load|delete|list'
  }
  // 旧入口清理（2026-09-18 用户要求）：/config url、/config key 移除，
  // /config protocol 一并删（它对补全里写着「转发到 /protocol」，但从未实现，
  // 一直是「未知配置项」的幽灵条目）。留一句指路，别让人以为命令坏了。
  if (args[0] === 'url') return '「/config url」已移除，直接用 /url [id] <地址>'
  if (args[0] === 'key') return '「/config key」已移除，直接用 /key（不带参数看状态；子命令 set/setenv/pool/clear）'
  if (args[0] === 'protocol') return '「/config protocol」已移除，直接用 /protocol [id] <协议>'
  if (args[0] === 'model') {
    // /config model → /model（统一入口，避免两份实现漂移；这个入口保留）
    const rest = args.slice(1)
    return { __forward: `/model${rest.length ? ' ' + rest.join(' ') : ''}` }
  }
  if (args[0] === 'provider') {
    const sub = args[1]
    if (sub === 'add') {
      // 无参 → 交互式向导（分步问 URL/key/model，手机上最省事）。
      // 向导需要 rl 和 fsSession，cmdConfig 拿不到也不该拿，所以只返回描述，
      // 真正执行在 index.mjs 侧（跟 __forward 同一套机制）。
      if (args.length <= 2) return { __wizard: 'provider-add' }

      // 带参 → 一行式，供非交互环境（Agent 调用 / 脚本 / QQ 桥）使用。
      //
      // 【为什么不是位置参数】历史上有过 `add <id> <name> <url> <model> <key>`，
      // 被删掉的理由是「五个位置参数记不住，顺序错了还不报错」——那是对的。
      // 所以这次用 **key=value**，顺序无关、缺哪个报哪个：
      //   /config provider add 4 name=kscsnkli url=https://x/v1 model=gpt-5.6-sol key=sk-xxx
      // ID 可以省略（自动取下一个空号）：
      //   /config provider add name=x url=https://x/v1 model=m key=sk-1 key=sk-2
      // key 可以给多个 → 自动存成 apiKeys 轮换池（和向导的 multi 行为一致）。
      //
      // 【字段名必须跟向导对齐】向导写的是 url / apiKey / apiKeys（不是 baseURL）。
      // 当年两套实现字段不一致就是 bug 来源，这里复用同一套字段名。
      const rest = args.slice(2)
      const fields = {}
      const keys = []
      let posId = null
      for (const tok of rest) {
        const m = /^([a-zA-Z]+)=([\s\S]*)$/.exec(tok)
        if (!m) {
          // 不带 = 的裸参数：只接受第一个当 ID，多余的报错而不是静默忽略
          if (posId === null) { posId = tok; continue }
          return `不认识的参数「${tok}」。用 key=value 写法：\n`
            + '  /config provider add [ID] name=<显示名> url=<地址> model=<模型> key=<sk-...>\n'
            + '  key 可重复给多个 → 存成轮换池'
        }
        const k = m[1].toLowerCase()
        const v = m[2].trim()
        if (k === 'key' || k === 'apikey') { if (v) keys.push(v); continue }
        if (k === 'id') { posId = v; continue }
        if (k === 'name' || k === 'url' || k === 'model') { fields[k] = v; continue }
        if (k === 'protocol') { fields.protocol = v; continue }
        return `不认识的字段「${m[1]}」。可用: id / name / url / model / key / protocol`
      }

      const existing = Object.keys(config.providers || {})
      const id = posId || String(Math.max(0, ...existing.map(n => parseInt(n, 10) || 0)) + 1)
      if (config.providers?.[id]) return `Provider ${id} 已存在（改用 /model /url /key 修改，或先 rm）`
      const missing = ['name', 'url', 'model'].filter(k => !fields[k])
      if (missing.length) return `缺少必填字段: ${missing.join(' / ')}\n`
        + '  /config provider add [ID] name=<显示名> url=<地址> model=<模型> key=<sk-...>'
      if (!/^https?:\/\//.test(fields.url)) return `URL 必须以 http:// 或 https:// 开头（收到 ${fields.url}）`

      // URL 规整：用户常把完整 /chat/completions 端点粘进来，统一剥成 canonical base，
      // 否则请求层再追加一次会变成 /chat/completions/chat/completions。
      fields.url = normalizeProviderUrl(fields.url, fields.protocol || 'openai')

      config.providers = config.providers || {}
      // 单 key 时不写 apiKeys，避免「长度 1 的池」这种既不是单 key 也不是池的中间态
      // （和向导同一约定，见 core/api.mjs setKeys(keys, fallback)）
      const prov = { name: fields.name, url: fields.url, model: fields.model, apiKey: keys[0] || '' }
      if (fields.protocol) prov.protocol = fields.protocol
      if (keys.length > 1) prov.apiKeys = keys
      config.providers[id] = prov
      saveConfig(config)
      const keyNote = keys.length > 1 ? `${keys.length} 个（轮换池）`
        : keys.length === 1 ? '已设置 1 个'
        : `未设置（用 /key ${id} <sk-...> 补）`
      return `已添加 Provider ${id} (${fields.name})\n`
        + `  URL:   ${fields.url}\n`
        + `  Model: ${fields.model}\n`
        + `  Key:   ${keyNote}\n`
        + `  切换过去: /config ${id}`
    }
    if (sub === 'rename' || sub === 'mv') {
      // 两种用法：
      //   /config provider rename <新ID>            —— 重命名当前使用中的 Provider
      //   /config provider rename <旧ID> <新ID>     —— 重命名指定 Provider
      let oldId, newId
      if (!args[3]) {
        oldId = config.current
        newId = args[2]
        if (!oldId) return '当前没有使用中的 Provider'
      } else {
        oldId = args[2]
        newId = args[3]
      }
      if (!newId) return '用法: /config provider rename <新ID> 或 rename <旧ID> <新ID>'
      if (!config.providers[oldId]) return `Provider ${oldId} 不存在`
      if (config.providers[newId]) return `Provider ${newId} 已存在`
      // 搬运配置对象（保留 key 顺序位置）
      const entries = Object.entries(config.providers)
      config.providers = {}
      for (const [id, p] of entries) {
        config.providers[id === oldId ? newId : id] = p
      }
      // 同步引用
      if (config.current === oldId) config.current = newId
      if (config.visionProviderId === oldId) config.visionProviderId = newId
      saveConfig(config)
      return `已重命名: ${oldId} → ${newId}${config.current === newId ? '（当前使用中）' : ''}`
    }
    if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
      const id = args[2]
      if (!id) return '用法: /config provider rm <ID>'
      if (!config.providers[id]) return `Provider ${id} 不存在`
      if (id === config.current) return `不能删除当前 Provider（${id}），请先切换到其他配置`
      delete config.providers[id]
      if (config.visionProviderId === id) delete config.visionProviderId
      saveConfig(config)
      return `已删除 Provider ${id}`
    }
    if (sub === 'list') {
      return Object.entries(config.providers).map(([id, p]) =>
        `  ${id}: ${p.name} - ${p.model}${id === config.current ? ' ←当前' : ''}`
      ).join('\n')
    }
    return '用法: /config provider add（向导）| rm <ID> | rename <旧ID> <新ID> | list'
  }
  if (args[0] === 'vision') {
    const provider = config.providers?.[config.current]
    // /config vision set <id> — 切换备用识图 Provider（默认配置 6）
    if (args[1] === 'set' && args[2]) {
      if (!config.providers[args[2]]) return `Provider ${args[2]} 不存在`
      config.visionProviderId = args[2]
      onVisionConfig?.(provider, api)
      saveConfig(config)
      return `备用识图 Provider 已设为: ${args[2]} (${config.providers[args[2]].name || ''})`
    }
    if (!args[1]) {
      const vid = config.visionProviderId || '8'
      const vp = config.providers?.[vid]
      return `当前 Provider 识图: ${provider?.vision === true ? '本模型' : (vp ? `${vid}(${vp.name})` : '未配置')} 兜底\n`
        + `用法: /config vision on|off | set <providerId>\n`
        + `注：兜底默认用 8。若兜底 provider 是「收下图片但 upstream 不转发」的中转站，`
        + `模型会回答「看不到图片」——换一个再试。`
    }
    if (args[1] !== 'on' && args[1] !== 'off') return '用法: /config vision on|off | set <providerId>'
    provider.vision = args[1] === 'on'
    config.vision = provider.vision
    onVisionConfig?.(provider, api)
    saveConfig(config)
    const vid = config.visionProviderId || '8'
    const vp = config.providers?.[vid]
    return `当前 Provider 识图已${provider.vision ? '开启（优先本模型）' : `关闭（使用 ${vid}(${vp?.name || '?'}) 兜底）`}`
  }
  if (args[0] === 'maxctx') {
    const v = parseInt(args[1])
    if (isNaN(v) || v < 10000) return '请提供有效的上下文上限（至少 10000）'
    config.maxContextTokens = v
    saveConfig(config)
    return `上下文上限已设为: ${v}`
  }
  if (args[0] === 'greeting') {
    if (!args[1]) return `开场白: ${config.greeting === false ? '关闭' : '开启'}\n用法: /config greeting on|off`
    if (args[1] === 'off') {
      config.greeting = false
      saveConfig(config)
      return '开场白已关闭（永久生效，写入 config.json）'
    } else if (args[1] === 'on') {
      config.greeting = true
      saveConfig(config)
      return '开场白已开启'
    }
    return '用法: /config greeting on|off'
  }
  // /config stream on|off  — 流式 / 非流式切换
  if (args[0] === 'stream') {
    if (!args[1] || args[1] === 'show' || args[1] === 'status') {
      const on = config.stream !== false
      return `流式输出: ${on ? '开启' : '关闭'}
用法:
  /config stream on    启用流式（默认，边生成边显示）
  /config stream off   非流式（等完整回复再显示）`
    }
    const sub = args[1]
    if (sub === 'on' || sub === 'enable' || sub === 'true' || sub === '1') {
      config.stream = true
      saveConfig(config)
      return '流式输出已开启（立即生效，无需重启）'
    }
    if (sub === 'off' || sub === 'disable' || sub === 'false' || sub === '0') {
      config.stream = false
      saveConfig(config)
      return '流式输出已关闭（立即生效，无需重启）\n非流式模式：完整响应生成完后一次性显示'
    }
    return `未知子命令: ${sub}\n用法: /config stream on|off`
  }

  // ── /config key=value —— 直接按 key 设值（对齐官方 2.1.303 的 config2）──
  //
  // 【为什么加】官方 2.1.303 把 /config 拆成两个实现：交互版开设置面板，
  // 非交互版 `config2` 的 argumentHint 就是 `key=value`，语义是「按 key 设一项设置」。
  // CCM 原来只能走子命令（/config stream off、/config greeting on…），
  // 子命令名各写各的、记不住；而 Agent 调用 / 脚本 / QQ 桥这类**非交互入口**
  // 根本没有面板可点，key=value 是它们唯一顺手的写法。
  //
  // 【解析规则照抄官方 fn22620，不要自己改】：
  //   · 恰好一个 token 含 `=` → 整串当一个 key=value（value 里可以有空格）
  //     例：/config statusLine.command=echo hi
  //   · 否则按空白拆，每个 token 都必须带 `=`；任一不合格**整条失败**
  // 后者是关键：部分成功会让用户以为全设上了，而实际只设了一半。
  //
  // 【key 表是白名单，不是直接写 config 字段】
  // 直接 `config[key] = value` 最省事，但有两类 key 必须额外动作：
  //   · markdownTheme  —— 还要调 setMarkdownTheme() 才真的换色（只写字段不生效）
  //   · permissionMode —— 还要改运行中的 PermissionManager，否则只写盘、当轮不生效
  // 所以走显式表，每个 key 自己负责「写字段 + 触发副作用」。
  // 未知 key 一律报错并列出可用 key —— 静默忽略等于让用户以为设上了。
  if (args.some((a) => String(a).includes('='))) {
    const pairs = parseConfigPairs(args)
    if (!pairs) {
      return `Expected key=value, got "${args.join(' ')}"\n用 /config 看有哪些可用项。`
    }
    return pairs
      .map(({ key, raw }) => applyConfigPair(key, raw, { config, api, saveConfig, hooks: opts.hooks || null }))
      .join('\n')
  }

  return `未知配置项: ${args[0]}\n（也可以直接按 key 设值：/config <key>=<value>，见 /config 帮助）`
}

/**
 * 解析 `/config a=1 b=2` 的参数列表。
 *
 * 规则与官方 fn22620 一致（见上方调用处的注释）。返回 null 表示格式不合法。
 *
 * @param {string[]} args
 * @returns {{key: string, raw: string}[] | null}
 */
function parseConfigPairs(args) {
  const tokens = args.map((a) => String(a))
  const joined = tokens.join(' ').trim()
  const withEq = tokens.filter((t) => t.includes('='))

  // 恰好一个 token 带 `=` → 整串当一个 key=value，value 里允许有空格。
  // 这条是为 `/config statusLine.command=echo hello` 这类带空格的值准备的：
  // 拆 token 的话 `hello` 会被当成第二个非法参数。
  if (withEq.length === 1) {
    const i = joined.indexOf('=')
    const key = joined.slice(0, i)
    // key 里不许有空白：`a b=c` 这种明显是用户写错了，别猜他想设哪个
    if (!key || /\s/.test(key)) return null
    return [{ key, raw: joined.slice(i + 1) }]
  }

  const out = []
  for (const t of tokens) {
    const i = t.indexOf('=')
    if (i <= 0) return null   // i<=0：没有 = ，或者 = 在最前面（空 key）
    out.push({ key: t.slice(0, i), raw: t.slice(i + 1) })
  }
  return out.length ? out : null
}

/** 布尔字面量。中文也收（用户是中文用户，/config stream=关 比 =off 自然） */
const CONFIG_BOOL_WORDS = {
  on: true, true: true, yes: true, '1': true, 开: true, 开启: true, 是: true,
  off: false, false: false, no: false, '0': false, 关: false, 关闭: false, 否: false,
}

function parseConfigBool(raw) {
  const v = String(raw).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(CONFIG_BOOL_WORDS, v) ? CONFIG_BOOL_WORDS[v] : null
}

/**
 * 把一条 key=value 落到配置上。返回给用户看的一行结果。
 *
 * 【为什么不抛异常】多条 key=value 时，一条失败不该让前面的白设 ——
 * 逐条返回结果，用户能一眼看出哪条没成。这和「解析阶段整条失败」不矛盾：
 * 解析失败 = 一个都没设（还没开始）；单条失败 = 其余照常（已经开始）。
 */
function applyConfigPair(key, raw, ctx) {
  const k = String(key).trim()
  const kl = k.toLowerCase()
  const { config, api, saveConfig, hooks } = ctx
  const bad = (expect) => `${k}: 需要${expect}，收到 "${raw}"`

  const setBool = (field, label) => {
    const v = parseConfigBool(raw)
    if (v === null) return bad('布尔值（on/off、true/false、1/0）')
    config[field] = v
    saveConfig(config)
    return `${label} = ${v ? 'on' : 'off'}`
  }
  const setInt = (field, label, min = 0) => {
    const v = parseInt(raw, 10)
    if (!Number.isFinite(v) || v < min) return bad(`不小于 ${min} 的整数`)
    config[field] = v
    saveConfig(config)
    return `${label} = ${v}`
  }

  switch (kl) {
    // ── 布尔 ──
    case 'greeting': return setBool('greeting', 'greeting（开场白）')
    case 'stream': return setBool('stream', 'stream（流式输出）')
    case 'replayhistory':
    case 'replay': return setBool('replayHistory', 'replayHistory（进会话显示历史）')

    // ── 数值 ──
    case 'temperature':
    case 'temp': {
      const v = parseFloat(raw)
      if (!Number.isFinite(v) || v < 0 || v > 2) return bad('0.0 ~ 2.0 之间的数')
      config.temperature = v
      if (config.providers?.[config.current]) config.providers[config.current].temperature = v
      if (api) api.temperature = v
      saveConfig(config)
      return `temperature（生成温度） = ${v}`
    }
    case 'maxcontexttokens':
    case 'maxctx': return setInt('maxContextTokens', 'maxContextTokens（上下文上限）', 10000)
    case 'compactthresholdtokens': return setInt('compactThresholdTokens', 'compactThresholdTokens（自动压缩 token 阈值）')
    case 'compactthresholdmessages': return setInt('compactThresholdMessages', 'compactThresholdMessages（自动压缩条数阈值）')
    case 'compactkeeplast': return setInt('compactKeepLast', 'compactKeepLast（压缩保留条数）')

    // ── 枚举（需要额外副作用）──
    case 'markdowntheme':
    case 'markdown-theme': {
      const v = String(raw).trim()
      if (!markdownThemeNames().includes(v)) {
        return bad(`以下之一：${markdownThemeNames().join(' | ')}`)
      }
      config.markdownTheme = v
      // 只写字段不生效 —— 渲染器读的是模块内的 currentThemeName
      setMarkdownTheme(v)
      saveConfig(config)
      return `markdownTheme（终端 Markdown 配色） = ${v}`
    }
    case 'permissionmode':
    case 'permission-mode': {
      const v = String(raw).trim()
      const MODES = ['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']
      if (!MODES.includes(v)) return bad(`以下之一：${MODES.join(' | ')}`)
      config.permissionMode = v
      saveConfig(config)
      // 运行中的 PermissionManager 有自己的 mode 字段，不通知它的话
      // 写盘成功但**当轮仍然按旧模式裁决** —— 这类"看起来设上了"最难查。
      const live = typeof hooks?.setPermissionMode === 'function'
        ? (() => { try { hooks.setPermissionMode(v); return true } catch { return false } })()
        : false
      return `permissionMode（权限模式） = ${v}${live ? '' : '\n  注：运行中的权限管理器未同步，重启后生效（或用 /permissions mode ' + v + '）'}`
    }

    default:
      return `未知 key: ${k}\n可用: greeting / stream / replayHistory / temperature / maxContextTokens / `
        + `compactThresholdTokens / compactThresholdMessages / compactKeepLast / markdownTheme / permissionMode`
  }
}


// /review — 非交互式扫描当前 workspace，做轻量级代码审查
// 不调 API，纯本地静态检查：git 状态、文件大小、可疑文件、未排入版本控制、超大文件等
export function cmdReview(args) {
  const cwd = process.cwd()
  const lines = []
  lines.push('工作区审查报告')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 1. Git 状态
  let gitOk = false
  try {
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    gitOk = true
    if (!status) {
      lines.push('✓ Git 工作区干净（无未提交改动）')
    } else {
      const mods = status.split('\n').filter(Boolean)
      const staged = mods.filter(l => l[0] !== ' ' && l[0] !== '?').length
      const unstaged = mods.filter(l => l[1] !== ' ' && l[0] !== '?').length
      const untracked = mods.filter(l => l[0] === '?').length
      lines.push(`! Git 有 ${mods.length} 项改动`)
      lines.push(`  已暂存: ${staged}  未暂存: ${unstaged}  未跟踪: ${untracked}`)
      if (untracked > 5) lines.push(`  ⚠ 未跟踪文件较多（${untracked}），考虑加 .gitignore`)
      // 列出可疑的未跟踪文件
      const suspicious = mods.filter(l => l[0] === '?').slice(0, 5).map(l => l.slice(3)).filter(f => /\.(env|key|pem|ssh|token)$/i.test(f) || /secret|password|credential/i.test(f))
      if (suspicious.length > 0) {
        lines.push(`  ⚠ 疑似敏感文件未跟踪:`)
        suspicious.forEach(f => lines.push(`     ${f}`))
      }
    }
  } catch {
    lines.push('• 非 Git 仓库（跳过 Git 检查）')
  }

  // 2. .gitignore 存在性（如果是 git 仓库）
  if (gitOk) {
    if (!existsSync(join(cwd, '.gitignore'))) {
      lines.push('⚠ 缺少 .gitignore — 推荐加一个')
    } else {
      const gi = readFileSync(join(cwd, '.gitignore'), 'utf-8')
      if (!gi.includes('node_modules')) lines.push('⚠ .gitignore 没有 node_modules')
      if (!gi.includes('.env')) lines.push('⚠ .gitignore 没有 .env — 可能泄露环境变量')
    }
  }

  // 3. CLAUDE.md 存在性
  if (!existsSync(join(cwd, 'CLAUDE.md'))) {
    lines.push('• 无 CLAUDE.md — 用 /memory init 创建项目记忆')
  }

  // 4. config.json 健康
  if (existsSync(join(cwd, 'config.json'))) {
    try {
      const cfg = JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf-8'))
      if (cfg.providers && cfg.current) {
        const p = cfg.providers[cfg.current]
        if (!p) lines.push(`⚠ config.json current=${cfg.current} 但 provider 不存在`)
        else {
          if (!p.url) lines.push('⚠ 当前 provider 缺 url')
          if (!p.apiKey) lines.push('⚠ 当前 provider 缺 apiKey')
          if (!p.model) lines.push('⚠ 当前 provider 缺 model')
        }
      } else {
        if (!cfg.url) lines.push('⚠ config.json 缺 url')
        if (!cfg.apiKey) lines.push('⚠ config.json 缺 apiKey')
        if (!cfg.model) lines.push('⚠ config.json 缺 model')
      }
    } catch {
      lines.push('✗ config.json 解析失败')
    }
  } else {
    lines.push('✗ 缺少 config.json')
  }

  // 5. 大文件检测（>1MB 的源码或日志）
  try {
    const big = []
    const scan = (dir, depth = 0) => {
      if (depth > 2) return
      for (const f of readdirSync(dir)) {
        if (f === 'node_modules' || f === '.git') continue
        const fp = join(dir, f)
        try {
          const st = statSync(fp)
          if (st.isDirectory()) scan(fp, depth + 1)
          else if (st.size > 1024 * 1024 && /\.(js|mjs|ts|jsx|tsx|json|log|md)$/.test(f)) {
            big.push(`${fp.replace(cwd + '/', '')} (${(st.size / 1024 / 1024).toFixed(1)} MB)`)
          }
        } catch {}
      }
    }
    scan(cwd)
    if (big.length > 0) {
      lines.push(`! 发现 ${big.length} 个超大文件:`)
      big.slice(0, 5).forEach(f => lines.push(`   ${f}`))
      if (big.length > 5) lines.push(`   ... 等 ${big.length} 个`)
    } else {
      lines.push('✓ 无超大源文件')
    }
  } catch {}

  // 6. TODO/FIXME/XXX 标记统计
  try {
    const markers = { TODO: 0, FIXME: 0, XXX: 0, 'HACK': 0 }
    const scanMarkers = (dir, depth = 0) => {
      if (depth > 2) return
      for (const f of readdirSync(dir)) {
        if (f === 'node_modules' || f === '.git') continue
        const fp = join(dir, f)
        try {
          const st = statSync(fp)
          if (st.isDirectory()) scanMarkers(fp, depth + 1)
          else if (st.size < 500 * 1024 && /\.(js|mjs|ts|jsx|tsx)$/.test(f)) {
            const text = readFileSync(fp, 'utf-8')
            for (const m of Object.keys(markers)) {
              const re = new RegExp(`\\b${m}\\b`, 'g')
              const count = (text.match(re) || []).length
              if (count > 0) markers[m] += count
            }
          }
        } catch {}
      }
    }
    scanMarkers(cwd)
    const total = Object.values(markers).reduce((a, b) => a + b, 0)
    if (total > 0) {
      lines.push(`! TODO/FIXME 标记: ${total} 个`)
      const parts = Object.entries(markers).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`)
      if (parts.length) lines.push(`  ${parts.join('  ')}`)
    } else {
      lines.push('✓ 无 TODO/FIXME 标记')
    }
  } catch {}

  // 7. 依赖健康（package.json 大小、node_modules 是否存在）
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
      const deps = Object.keys(pkg.dependencies || {}).length
      lines.push(`• package.json 有 ${deps} 项依赖`)
    } catch {}
  }

  // 8. sessions 数量（如果太多说明可能需要清理）
  try {
    const sessionsDir = join(DATA_DIR, 'sessions')
    if (existsSync(sessionsDir)) {
      const sess = readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
      if (sess.length > 10) lines.push(`! sessions 目录有 ${sess.length} 个会话文件 — 考虑清理`)
      else lines.push(`✓ sessions 目录干净 (${sess.length})`)
    }
  } catch {}

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  lines.push('说明：本报告为静态检查，不调 API。要深度代码审查请让我读代码。')

  return lines.join('\n')
}
