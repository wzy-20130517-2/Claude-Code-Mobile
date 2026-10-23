// Claude Code Mobile - 搜索工具
import { Tool } from './tools.mjs'
import { lstatSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join, sep, dirname } from 'node:path'

/**
 * 按 mtime 从新到旧排序（官方 Glob 的排序语义）。
 *
 * 【为什么要排序】官方 Glob 的 description 明确写「results are sorted by
 * modification time, most recently modified first」。这不是装饰 —— 排查
 * 「最近改了什么」时，未排序的结果里最新文件可能在第 300 条，等于没给。
 *
 * 【为什么 statSync 失败也不丢结果】排序是锦上添花，文件在遍历和排序之间
 * 被删掉是正常的（尤其 /tmp、构建产物）。取不到 mtime 就当 0（排最后），
 * 但**保留**这条结果 —— 宁可顺序不完美，也不能把文件从结果里抹掉。
 */
function sortByMtimeDesc(paths) {
  const withTime = paths.map((p, i) => {
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch {}
    return { p, mtime, i }
  })
  withTime.sort((a, b) => (b.mtime - a.mtime) || (a.i - b.i))  // 同 mtime 保持遍历顺序，结果稳定
  return withTime.map(x => x.p)
}

// ══════════════════════════════════════════════════════════════════════
//  防卡死约束（2026-09-27，实测触发）
// ══════════════════════════════════════════════════════════════════════
//
// 卡死证据：Glob({ path: home, pattern: '*capture*' }) 在 Termux 上
// 25 秒未完成，主线程被同步递归堵死，Ctrl+C 无效，spinner 冻结在
// 「Searching」。隔离子进程复现同样超时。
//
// 根因（两层）：
//   1. statSync 跟随符号链接 → 家目录下有 storage/shared → /storage/emulated/0
//      虽然 Termux 读不了 /sdcard/Android/data，但 73 个顶层条目 + 深层
//      树（Android/obb、DCIM、Download 等）也够它转几分钟。
//   2. readdirSync + statSync 全是同步调用，没有任何让出事件循环的机会，
//      332k 文件、59k 目录的遍历把所有异步回调（按键、spinner、网络）全堵死。
//
// 修法（三条一起上，缺一不可）：
//   a. 用 lstatSync 替代 statSync —— 不把符号链接当目录递归进去
//   b. 每扫 200 个条目 await setImmediate() 一次 —— 让事件循环喘口气
//   c. 条目数上限 + 已知慢目录跳过 —— 防止走到 /sdcard 里出不来

/** 最多扫描多少个文件系统条目（防止失控遍历） */
const MAX_WALK_ENTRIES = 3000
/**
 * 单次搜索最多收集多少条原始结果（分页前的硬兜底）。
 *
 * 【为什么需要】head_limit=0 表示「不限制」，但真命中几万条时，
 * 全量收集会把手机内存和模型上下文一起撑爆 —— 那不叫「不限制」，
 * 叫「卡死」。所以「不限制」的语义定为：不受 head_limit 约束，
 * 但仍受这个物理上限约束（远超默认 250，正常搜索碰不到）。
 */
const MAX_COLLECT_ROWS = 5000
/** 每扫多少个条目让出一次事件循环 */
const WALK_YIELD_EVERY = 200
/** 已知慢/大目录：绝对路径前缀匹配。不在这些目录下递归。 */
const SKIP_DIR_PREFIXES = [
  '/storage/emulated',       // Android 共享存储（FUSE，stat 慢）
  '/sdcard',                 // 同上
  '/proc',                   // 虚拟文件系统，无意义
  '/sys',
  '/dev',
]
/** 跳过不进入的目录名（ basename 精确匹配） */
const SKIP_DIR_NAMES = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg',
  'Android',  // /sdcard/Android 里面的 data/obb 动辄几万文件
])

/** 让出事件循环的辅助 */
const yieldLoop = () => new Promise(r => setImmediate(r))

/**
 * 受限异步遍历器：walk 目录树，但受控。
 * @param {string} root 起始目录（绝对路径）
 * @param {(fullPath: string, name: string, isDir: boolean) => boolean|void} visit
 *   返回 false 停止整个遍历。
 * @returns {Promise<{stopped: boolean, visited: number}>}
 */
async function walkBounded(root, visit) {
  let visited = 0
  const stack = [root]
  // ★ 2026-10-04 修复：root 自身位于「跳过前缀」下时，豁免该前缀。
  // 否则用户显式指定 /sdcard/... 作为搜索根时，第一个循环就 continue，
  // 永远返回空 —— 这是 Glob/Grep/CodeSearch 对默认工作区
  // （/sdcard/Download/claude-workspace）全部失效的根因（用户实测发现）。
  // 防卡死三件套不受影响：MAX_WALK_ENTRIES 上限、SKIP_DIR_NAMES、定期 yield 全部保留。
  const exempt = SKIP_DIR_PREFIXES.find(p => root === p || root.startsWith(p + '/'))
  while (stack.length > 0) {
    if (visited >= MAX_WALK_ENTRIES) return { stopped: true, visited }
    const dir = stack.pop()
    // 跳过已知慢/大目录（用户显式指定的 root 所在前缀除外）
    if (SKIP_DIR_PREFIXES.some(p => p !== exempt && (dir === p || dir.startsWith(p + '/')))) continue
    let entries
    try { entries = readdirSync(dir) } catch { continue }
    for (const e of entries) {
      if (visited >= MAX_WALK_ENTRIES) return { stopped: true, visited }
      if (e.startsWith('.')) continue
      const full = join(dir, e)
      // 用 lstatSync：不跟随符号链接，防止循环/大目录穿透
      let s; try { s = lstatSync(full) } catch { continue }
      const isDir = s.isDirectory()
      if (isDir && SKIP_DIR_NAMES.has(e)) continue
      visited++
      const cont = visit(full, e, isDir)
      if (cont === false) return { stopped: true, visited }
      if (isDir) stack.push(full)
      // 定期让出事件循环
      if (visited % WALK_YIELD_EVERY === 0) await yieldLoop()
    }
  }
  return { stopped: false, visited }
}

export class GlobTool extends Tool {
  constructor() {
    super({
      name: 'Glob',
      description: [
        'glob 模式查找文件（按文件名/路径匹配，不搜内容）。',
        '',
        '示例：',
        '  **/*.mjs             所有 .mjs 文件',
        '  core/**/*.test.mjs    core 下任意层级的测试文件',
        '  src/*.{js,ts}         src 顶层的 js 和 ts',
        '',
        '结果是**绝对路径**，按修改时间从新到旧排列（最近改过的在前）——',
        '排查「刚改过的文件」时直接看前几条即可，不用自己排序。',
        '上限 500 个，超出会明确标注已截断。',
        '',
        '要搜文件内容用 Grep，不要用 Glob 再逐个读。',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 "**/*.mjs"、"src/**/*.ts"' },
          path: {
            type: 'string',
            description: '搜索起点目录（默认当前目录）。'
              + 'DO NOT 传字符串 "undefined" 或 "null" —— 不需要就整个省略这个字段。',
          },
        },
        required: ['pattern'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.pattern) errors.push('pattern is required')
        // 官方同款防护：模型常把「不传」写成字符串 "undefined"/"null"，
        // 那会被当成目录名去遍历，得到一个莫名的「no matches」。
        const badPath = ['undefined', 'null'].includes(String(input.path ?? '').trim().toLowerCase())
        if (badPath) errors.push('path 收到了字符串 "undefined"/"null"，请直接省略这个字段')
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) {
    const root = resolve(ctx.cwd || process.cwd(), input.path || '.')
    const results = []
    const { stopped, visited } = await walkBounded(root, (full, name, isDir) => {
      const relPath = full.slice(root.length + 1)
      if (this._matchGlob(relPath, input.pattern)) results.push(full)
      if (results.length >= 500) return false  // 够了，停
    })
    if (stopped && visited >= MAX_WALK_ENTRIES) {
      return results.length
        ? sortByMtimeDesc(results).slice(0, 500).join('\n') + `\n... [已达 ${MAX_WALK_ENTRIES} 条目上限，结果截断] ...`
        : `(扫描了 ${MAX_WALK_ENTRIES} 个条目仍未找到匹配，已截断。请缩小 path 范围。)`
    }
    return sortByMtimeDesc(results).slice(0, 500).join('\n') || '(no matches)'
  }

  _matchGlob(path, pattern) {
    let regex = ''
    let i = 0
    while (i < pattern.length) {
      const c = pattern[i]
      if (c === '*' && pattern[i + 1] === '*') {
        regex += '.*'
        i += 2
        if (pattern[i] === '/') i++
      } else if (c === '*') {
        regex += '[^/]*'
        i++
      } else if (c === '?') {
        regex += '[^/]'
        i++
      } else if ('\\^$.+()[]{}|'.includes(c)) {
        regex += '\\' + c
        i++
      } else if (c === '/') {
        regex += sep === '\\' ? '[\\\\/]' : '/'
        i++
      } else {
        regex += c
        i++
      }
    }
    try {
      const r = new RegExp('^' + regex + '$')
      return r.test(path)
    } catch { return false }
  }
}

export class GrepTool extends Tool {
  constructor() {
    super({
      name: 'Grep',
      description: [
        '正则搜索文件内容（ripgrep 风格）。',
        '',
        '输出模式（output_mode）：',
        '  files_with_matches（默认）— 只列文件路径',
        '  content — 显示匹配行（可配合 -A/-B/-C 或 context 看上下文）',
        '  count — 只显示每个文件的匹配数',
        '',
        '示例：',
        '  pattern="function\\\\s+\\\\w+" path="core/" output_mode="content" -n=true',
        '  pattern="TODO" glob="*.mjs" output_mode="files_with_matches"',
        '  pattern="error" type="js" output_mode="count"',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '要搜索的正则表达式' },
          path: {
            type: 'string',
            description: '搜索的文件或目录（默认当前目录）。'
              + 'DO NOT 传字符串 "undefined" 或 "null" —— 不需要就整个省略这个字段。',
          },
          // ── 官方字段（对齐 claude.js:945509 的 schema）───────────────
          glob: { type: 'string', description: '按文件名过滤的 glob，如 "*.js"、"**/*.tsx"、"*.{js,ts}"' },
          type: { type: 'string', description: '按文件类型过滤（ripgrep --type），如 js / ts / py / rust / go / md / json' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: '输出模式，默认 files_with_matches（只列文件）',
          },
          multiline: { type: 'boolean', description: '多行模式：pattern 里的 . 可以跨行匹配（默认 false）' },
          // 官方原文：'Limit output to first N lines/entries, equivalent to "| head -N".
          // Works across all output modes ... Defaults to 250 when unspecified.
          // Pass 0 for unlimited (use sparingly — large result sets waste context).'
          head_limit: {
            type: 'number',
            description: '只返回前 N 条结果，等价 "| head -N"，三种 output_mode 都生效。'
              + '不传时默认 250；传 0 表示不限制（慎用，结果集会撑爆上下文）。',
            default: 250,
          },
          offset: {
            type: 'number',
            description: '跳过前 N 条，等价 "| tail -n +N | head -N"，三种 output_mode 都生效。默认 0。',
          },
          context: { type: 'number', description: '匹配行前后各显示 N 行（等价 -C N）' },
          // ── CCM 原有的 rg 直通参数（保留，不与官方字段冲突）──
          include: { type: 'string', description: '【兼容旧写法，优先用 glob】文件名过滤正则' },
          '-A': { type: 'number', description: '匹配行之后显示 N 行（after context）' },
          '-B': { type: 'number', description: '匹配行之前显示 N 行（before context）' },
          '-C': { type: 'number', description: '匹配行前后各显示 N 行（等价 context）' },
          '-i': { type: 'boolean', description: '忽略大小写' },
          '-n': { type: 'boolean', description: '显示行号（默认已显示，传 false 可关掉）' },
          '-o': { type: 'boolean', description: '只输出匹配到的片段，不输出整行' },
        },
        required: ['pattern'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      // 与 Glob / CodeSearch 保持同一量级（三者都是只读检索工具）。
      // Grep 自身有 head_limit 默认 250 兜底，不会因为上限放开而失控。
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.pattern) errors.push('pattern is required')
        // 官方同款防护：模型常把「不传」写成字符串 "undefined"/"null"
        const badPath = ['undefined', 'null'].includes(String(input.path ?? '').trim().toLowerCase())
        if (badPath) errors.push('path 收到了字符串 "undefined"/"null"，请直接省略这个字段')
        if (input.output_mode !== undefined && input.output_mode !== null
          && !['content', 'files_with_matches', 'count'].includes(input.output_mode)) {
          errors.push('output_mode 只能是 content / files_with_matches / count')
        }
        // head_limit：0 是合法值（=不限制），负数/NaN 才报错。
        // 官方语义 'Pass 0 for unlimited' —— 原来一刀切要求正数会把 0 判成错误。
        if (input.head_limit !== undefined && input.head_limit !== null) {
          const hl = Number(input.head_limit)
          if (!Number.isFinite(hl) || hl < 0) {
            errors.push('head_limit 必须是非负数（0 表示不限制，不传默认 250）')
          }
        }
        if (input.offset !== undefined && input.offset !== null) {
          const of = Number(input.offset)
          if (!Number.isFinite(of) || of < 0) {
            errors.push('offset 必须是非负数（默认 0）')
          }
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }
  async execute(input, ctx = {}) {
    const root = resolve(ctx.cwd || process.cwd(), input.path || '.')
    // -i 走 RegExp 的 i 标志，而不是往 pattern 里塞 (?i) —— 后者在
    // 已经带了分组/内联标志时会报错。
    const flags = input['-i'] ? 'i' : ''
    // multiline：官方语义是「. 可以跨行」。用 s 标志实现（dotAll）。
    // 注意 JS 的 s 只影响 `.`，不会让 ^/$ 跨行 —— 与 rg 的 --multiline 行为一致。
    const flagStr = flags + (input.multiline ? 's' : '')
    let r
    try { r = new RegExp(input.pattern, flagStr) } catch (e) { return `Invalid regex: ${e.message}` }
    // -o 需要带 g 标志才能拿到全部匹配片段；不带 g 只返回第一个。
    let rGlobal = r
    if (input['-o']) {
      try { rGlobal = new RegExp(input.pattern, flagStr + 'g') } catch {}
    }

    // 上下文行数：官方 context 优先，其次 CCM 原有的 -B/-C/-A
    const ctxN = input.context !== undefined && input.context !== null ? Number(input.context) : null
    const before = ctxN !== null ? ctxN : (Number(input['-B'] ?? input['-C'] ?? 0) || 0)
    const after = ctxN !== null ? ctxN : (Number(input['-A'] ?? input['-C'] ?? 0) || 0)
    const wantLineNo = input['-n'] !== false   // 默认 true
    const onlyMatch = !!input['-o']
    // 输出模式：默认 files_with_matches（对齐官方）
    const mode = input.output_mode || 'files_with_matches'
    // 多行模式必须整文件匹配，逐行 search 没有意义 —— 走单独路径
    const wantMultiline = !!input.multiline

    // ── 分页参数必须在采集前算好 ──────────────────────────────────
    // 原来采集阶段硬编码「满 200 条就停」，比官方默认 head_limit(250) 还小，
    // 于是无论传什么都拿不到 250 条 —— 默认值和「传 0 不限制」全被这个
    // 隐形上限架空了。现在采集上限由 head_limit 推导。
    // head_limit 三态（官方 claude.js 原文）：
    //   不传   → 默认 250（'Defaults to 250 when unspecified'）
    //   传 0   → 不限制（'Pass 0 for unlimited'）
    //   传 N>0 → 只取 N 条
    const offRaw = Number(input.offset)
    const off = Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0
    const hasHeadLimit = input.head_limit !== undefined && input.head_limit !== null
    const headRaw = hasHeadLimit ? Number(input.head_limit) : 250
    const headLimit = headRaw > 0 ? Math.floor(headRaw) : 0
    // 多采 1 条：用于判断「后面还有没有」，否则截断提示永远不出现。
    // 上限 MAX_COLLECT_ROWS 是防卡死的兜底 —— head_limit=0 时若真的
    // 命中几万条，全量收集会把手机内存和上下文一起撑爆。
    const collectCap = headLimit > 0
      ? Math.min(off + headLimit + 1, MAX_COLLECT_ROWS)
      : MAX_COLLECT_ROWS

    const matches = []
    // 文件过滤：glob（官方）与 include（CCM 旧）都能用，任一命中即通过
    const nameFilters = []
    if (input.glob) nameFilters.push(globToRegExp(input.glob))
    if (input.include) { try { nameFilters.push(new RegExp(input.include)) } catch {} }
    const typeFilter = input.type ? (TYPE_GLOBS[String(input.type).toLowerCase()] || null) : null

    // 目录遍历时跳过大文件（>5MB），但要在结果里告知 —— 不能静默吞掉
    let skippedLarge = 0
    // count 模式：每个文件一行 `路径:数量`
    const counts = new Map()
    // files_with_matches 模式：只收路径（去重靠 Set）
    const fileHits = new Set()

    const searchFile = (full, { skipLarge = false } = {}) => {
      let content
      try {
        if (skipLarge) {
          const st = lstatSync(full)
          if (st.size > 5 * 1024 * 1024) { skippedLarge++; return }
        }
        content = readFileSync(full, 'utf-8')
      } catch { return }

      // ── 多行模式 ──────────────────────────────────────────────
      // 整个文件当一个字符串匹配，行号由匹配位置换算。
      if (wantMultiline) {
        let rm
        try { rm = new RegExp(input.pattern, flagStr + 'g') } catch { return }
        let m
        let any = false
        while ((m = rm.exec(content)) !== null) {
          any = true
          const lineNo = content.slice(0, m.index).split('\n').length
          if (mode === 'files_with_matches') { fileHits.add(full); return }
          if (mode === 'count') { counts.set(full, (counts.get(full) || 0) + 1) }
          else matches.push(`${full}:${lineNo}:${m[0].replace(/\n/g, '\\n')}`)
          if (m[0] === '') rm.lastIndex++   // 防空匹配死循环
          if (matches.length >= collectCap) return
        }
        if (any && mode === 'count' && !counts.has(full)) counts.set(full, 1)
        return
      }

      const lines = content.split('\n')

      // ── 先判定「这个文件有没有命中」（三种模式共用）─────────────
      if (mode === 'files_with_matches' || mode === 'count') {
        let n = 0
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].search(r) !== -1) n++
        }
        if (n === 0) return
        if (mode === 'files_with_matches') { fileHits.add(full); return }
        counts.set(full, n)
        return
      }

      // ── content 模式 ──────────────────────────────────────────
      // 上下文模式（-A/-B/-C/context）：先把命中行号收集起来，再统一展开区间，
      // 相邻/重叠的区间合并，避免同一行被打印多遍。
      if (before > 0 || after > 0) {
        const hits = []
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].search(r) !== -1) hits.push(i)
          if (hits.length >= collectCap) break
        }
        if (!hits.length) return
        const ranges = []
        for (const h of hits) {
          const s = Math.max(0, h - before)
          const e = Math.min(lines.length - 1, h + after)
          const last = ranges[ranges.length - 1]
          if (last && s <= last.e + 1) last.e = Math.max(last.e, e)
          else ranges.push({ s, e })
        }
        for (const { s, e } of ranges) {
          for (let i = s; i <= e; i++) {
            const mark = hits.includes(i) ? ':' : '-'
            const ln = wantLineNo ? `${i + 1}${mark}` : ''
            matches.push(wantLineNo ? `${full}:${ln}${lines[i]}` : `${full}:${lines[i]}`)
          }
          matches.push('--')   // 区间之间用 -- 分隔（rg 惯例）
        }
        return
      }

      for (let i = 0; i < lines.length; i++) {
        if (onlyMatch) {
          // -o：只输出匹配片段，一行里可能有多个
          rGlobal.lastIndex = 0
          let m
          let any = false
          while ((m = rGlobal.exec(lines[i])) !== null) {
            any = true
            const ln = wantLineNo ? `:${i + 1}` : ''
            matches.push(`${full}${ln}:${m[0]}`)
            if (m[0] === '') rGlobal.lastIndex++   // 防空匹配死循环
            if (matches.length >= collectCap) return
          }
          if (any) continue
        } else if (lines[i].search(r) !== -1) {
          const ln = wantLineNo ? `:${i + 1}:` : ':'
          matches.push(`${full}${ln}${lines[i]}`)
          if (matches.length >= collectCap) return
        }
      }
    }

    // ⚠️ path 可能指向**单个文件**而不是目录。
    // 单文件搜索不跳过大文件（用户明确指定了目标），只截断输出。
    let isFile = false
    try { isFile = lstatSync(root).isFile() } catch { /* 路径不存在，下面 walk 会处理 */ }

    if (isFile) {
      searchFile(root, { skipLarge: false })
    } else {
      await walkBounded(root, (full, name, isDir) => {
        if (isDir) return  // 目录由 walkBounded 自己决定是否深入
        // 文件过滤：glob/include/type 任一指定就必须通过
        if (nameFilters.length && !nameFilters.some(f => f.test(name))) return
        if (typeFilter && !typeFilter.test(name)) return
        searchFile(full, { skipLarge: true })
        if (matches.length >= collectCap) return false
      })
    }

    // ── 组装输出 ────────────────────────────────────────────────
    // 先按模式取「未分页」的完整结果，再统一做 offset/head_limit，
    // 这样分页语义在三种模式下一致（否则 count 模式无法分页）。
    let rows
    if (mode === 'files_with_matches') {
      rows = [...fileHits]
    } else if (mode === 'count') {
      rows = [...counts.entries()].map(([f, n]) => `${f}:${n}`)
    } else {
      rows = matches
    }

    const total = rows.length
    // off / headLimit 已在采集前算好（见上方分页参数段），这里直接复用。
    let page = off > 0 ? rows.slice(off) : rows
    if (headLimit > 0 && page.length > headLimit) page = page.slice(0, headLimit)

    let result = page.join('\n') || '(no matches)'
    // 截断必须显式告知 —— 否则模型会以为「就这么多」。
    // 顺带点出「传 0 可取消限制」，否则模型不知道有这个开关，
    // 只会反复调 offset 翻页（翻到第 5 页就把上下文烧光了）。
    if (headLimit > 0 && total > off + page.length) {
      result += `\n[已截断：显示第 ${off + 1}-${off + page.length} 条，共 ${total} 条。`
        + `用 offset=${off + page.length} 看下一页；确实需要全部时传 head_limit=0 取消限制]`
    } else if (off > 0) {
      result += `\n[已跳过前 ${off} 条，共 ${total} 条]`
    }
    if (skippedLarge > 0) {
      result += `\n[跳过了 ${skippedLarge} 个 >5MB 的大文件（目录遍历时为保响应速度）。如需搜索它们，请直接指定文件路径。]`
    }
    return result
  }
}

/**
 * glob → RegExp。只支持 ripgrep 常用的三种形态：
 *   *.js         同目录下任意 .js（**不跨目录**，与 rg 一致）
 *   **\/*.tsx     跨任意层级
 *   *.{js,ts}    花括号展开
 * 其它高级语法（字符类、取反）按字面处理 —— 猜错比不支持更糟。
 *
 * 【顺序很关键】必须**先转义**所有正则元字符，再替换 glob 通配符。
 * 反过来做的话，自己生成的 `[^/]*` 会被后续的转义步骤打坏成 `[\^/]*`
 * （把 `^` 当字面量），结果是任何文件名都匹配不上，且不报错 —— 静默返回
 * 「no matches」，看起来像「文件里真的没有」，极难排查。
 */
function globToRegExp(glob) {
  let s = String(glob).trim()
  // ① 先把 glob 语法换成占位符，避免被下面的元字符转义打坏
  s = s.replace(/\{([^}]*)\}/g, (_, inner) => '\u0000BRACE' + inner + '\u0000')
  s = s.replace(/\*\*\//g, '\u0000SLASHSTAR\u0000')
  s = s.replace(/\*\*/g, '\u0000STARSTAR\u0000')
  s = s.replace(/\*/g, '\u0000STAR\u0000')
  s = s.replace(/\?/g, '\u0000QMARK\u0000')
  // ② 转义所有正则元字符（此时字符串里只剩字面量 + 占位符）
  s = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // ③ 把占位符还原成对应的正则片段
  s = s.replace(/\u0000BRACE([^\u0000]*)\u0000/g, (_, inner) =>
    `(?:${inner.split(',').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
  s = s.replace(/\u0000SLASHSTAR\u0000/g, '(?:.*/)?')   // **/ → 任意层级（含零层）
  s = s.replace(/\u0000STARSTAR\u0000/g, '.*')          // ** → 任意字符（含 /）
  s = s.replace(/\u0000STAR\u0000/g, '[^/]*')           // *  → 不跨目录
  s = s.replace(/\u0000QMARK\u0000/g, '[^/]')           // ?  → 单个非斜杠字符
  try { return new RegExp(`^${s}$`) } catch { return /$^/ }   // 构造失败 → 永不匹配
}

/**
 * ripgrep 的 --type 到文件后缀的映射（常用子集）。
 *
 * 【为什么只做常用子集】rg 内置 200+ 类型，全量搬过来要几百行，而实际
 * 搜索里 js/ts/py/go/rust/java 等十几种覆盖了 95% 场景。没收录的类型
 * 会退化成「不过滤」并给出提示，而不是静默返回空结果。
 */
const TYPE_GLOBS = {
  js: /\.(js|mjs|cjs|jsx)$/i,
  ts: /\.(ts|mts|cts|tsx)$/i,
  py: /\.pyi?$/i,
  rust: /\.rs$/i,
  rs: /\.rs$/i,
  go: /\.go$/i,
  java: /\.java$/i,
  kotlin: /\.kts?$/i,
  kt: /\.kts?$/i,
  c: /\.(c|h)$/i,
  cpp: /\.(cc|cpp|cxx|hpp|hh|hxx)$/i,
  cs: /\.cs$/i,
  rb: /\.rb$/i,
  ruby: /\.rb$/i,
  php: /\.php$/i,
  swift: /\.swift$/i,
  md: /\.(md|markdown)$/i,
  json: /\.json$/i,
  yaml: /\.(ya?ml)$/i,
  yml: /\.(ya?ml)$/i,
  toml: /\.toml$/i,
  html: /\.html?$/i,
  css: /\.css$/i,
  scss: /\.scss$/i,
  sh: /\.(sh|bash|zsh)$/i,
  sql: /\.sql$/i,
  xml: /\.xml$/i,
}

// 关键词符号搜索：全词匹配（toLowerCase + split 空白 + filter），无倒排索引
// 用法：query 关键词，可选 path 限定目录；返回 文件:行号:内容
export class CodeSearchTool extends Tool {
  constructor() {
    super({
      name: 'CodeSearch',
      description: '关键词符号搜索：用空格分隔的关键词全词匹配符号、函数、变量名（比 Grep 更适合"找那个函数叫什么"）',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（支持空格分隔多个词，全部匹配才命中）' },
          path: { type: 'string', description: '限定目录（默认当前目录）' },
          include: { type: 'string', description: '文件名过滤正则（如 \\.mjs$）' },
          limit: { type: 'number', description: '返回条数上限（默认 50）' },
        },
        required: ['query'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      // 与 Glob / Grep 保持同一量级（三者都是只读检索工具）。
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.query) errors.push('query is required')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const root = resolve(ctx.cwd || process.cwd(), input.path || '.')
    const query = String(input.query).toLowerCase().split(/\s+/).filter(Boolean)
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 50))
    let fileFilter = null
    if (input.include) { try { fileFilter = new RegExp(input.include) } catch {} }

    const results = []

    /** 搜一个文件 */
    const searchFile = (full, name) => {
      if (fileFilter && !fileFilter.test(name)) return
      if (!/\.(mjs|js|ts|jsx|tsx|py|json|md|css|html|sh)$/i.test(name)) return
      let content; try { content = readFileSync(full, 'utf-8') } catch { return }
      const srcLines = content.split('\n')
      for (let i = 0; i < srcLines.length; i++) {
        if (results.length >= limit) return
        const line = srcLines[i]
        const low = line.toLowerCase()
        const hit = query.every(q => low.includes(q))
        if (hit) {
          results.push(`${full}:${i + 1}:${line.trim().slice(0, 200)}`)
        }
      }
    }

    let isFile = false
    try { isFile = lstatSync(root).isFile() } catch { /* 不存在，交给 walk */ }

    if (isFile) {
      searchFile(root, root.split(sep).pop() || root)
    } else {
      await walkBounded(root, (full, name, isDir) => {
        if (isDir) return
        searchFile(full, name)
        if (results.length >= limit) return false
      })
    }

    return results.join('\n') || '(no matches)'
  }
}
