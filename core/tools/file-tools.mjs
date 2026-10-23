// Claude Code Mobile - 文件工具（带 Undo + 回收站支持）
import { Tool } from './tools.mjs'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { backupBeforeOverwrite } from '../session/trash.mjs'

function toolPath(filePath, ctx = {}) {
  return resolve(ctx.cwd || process.cwd(), filePath)
}

/**
 * 文件不存在时，找出同目录下名字相近的候选，拼进错误信息。
 *
 * 【为什么值得做】「File not found」是最常见的死路：模型拼错一个字母
 *（`agnt.mjs` vs `agent.mjs`）、大小写写错、少了个 `s`，拿到的只有一句
 * 干巴巴的 not found，于是它要么换路径乱试、要么直接放弃任务。给三个候选
 * 通常一眼就能看出真名，一轮就修好。
 *
 * 只在**同目录**里找，不做全盘搜索 —— 全盘搜会慢、而且跨目录的相似名
 * 反而是噪音（`a/foo.mjs` 和 `b/foo.mjs` 谁都不是要找的那个）。
 * 找不到候选就返回空串，调用方照常抛原始错误。
 */
function similarPathHint(filePath) {
  try {
    const dir = dirname(filePath)
    const base = basename(filePath)
    if (!existsSync(dir)) return ''
    const entries = readdirSync(dir)
    if (!entries.length) return ''
    // 相似度：小写后按「公共前缀长度 + 是否互为子串」粗排，够用且够快
    const lowBase = base.toLowerCase()
    const scored = []
    for (const e of entries) {
      const le = e.toLowerCase()
      if (le === lowBase) continue          // 完全同名（大小写差异）另算，下面单独给
      let score = 0
      if (le.includes(lowBase) || lowBase.includes(le)) score = 100
      else {
        // 公共前缀
        let i = 0
        while (i < le.length && i < lowBase.length && le[i] === lowBase[i]) i++
        score = i
        // 扩展名相同加分（拼错主体名比拼错扩展名常见）
        const extA = le.slice(le.lastIndexOf('.'))
        const extB = lowBase.slice(lowBase.lastIndexOf('.'))
        if (extA && extA === extB) score += 20
      }
      if (score >= 3) scored.push({ e, score })
    }
    // 大小写只差一个的情况最值得提示（Termux 文件系统区分大小写）
    const caseOnly = entries.find(e => e.toLowerCase() === lowBase && e !== base)
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, 3).map(x => x.e)
    if (caseOnly && !top.includes(caseOnly)) top.unshift(caseOnly)
    if (!top.length) return ''
    return `\n  · 同目录下相近的文件：${top.map(t => `"${t}"`).join('、')}`
  } catch { return '' }
}

// ── 并发写保护：记录「本进程读过的文件版本」────────────────────────────
// 要堵的漏：worker-A Read 文件 → worker-B 改并写 → worker-A 拿旧内容 Write
//   → B 的工作静默消失，退出码 0，无任何告警（回收站里有，但没人知道要去找）。
// 做法：Read 时记录 mtime+size，Write 覆盖前比对，不一致就拒写并要求重新 Read。
// 只对「本进程 Read 过的文件」生效——没读过就直接 Write 视为用户明确要覆盖，不拦。
//
// ⚠ 已知局限（只是缩小窗口，没有解决）：
//   1. mtime 精度取决于文件系统。部分 FS（某些 FAT / 网络挂载）只有秒级精度，
//      同一秒内的两次修改测不出 mtime 差异。size 作为辅助信号能捞回一部分
//      （改动使长度变化的情况），但「同一秒内 + 长度不变」的修改仍然漏检。
//   2. 校验与写入之间不是原子的（check-then-write），理论上仍有极窄竞态窗口。
//   3. 记录以「解析后的绝对路径」为 key，也只覆盖本进程内的 Read；
//      走符号链接/不同挂载点指向同一文件，或别的进程读过的记录，都识别不到。
//   以上任一情况的失败方向都是 fail-open（退回旧的无校验行为），不会误拦。
const MAX_TRACKED = 500        // 记录上限，超了淘汰最早的；淘汰只会退回「不校验」
const fileVersions = new Map() // absPath -> { mtimeMs, size }

function statVersion(p) {
  try {
    const st = statSync(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch { return null }      // stat 不到就放弃校验（fail-open，绝不误拦）
}

// 记录/刷新版本。Read 之后、以及本模块每次成功写盘之后都必须调用，
// 否则「读一次、写两次」的第二次写会拿旧 mtime 比新文件 → 误拦自己。
function trackVersion(p) {
  const v = statVersion(p)
  if (!v) return
  if (fileVersions.has(p)) fileVersions.delete(p)  // 重新 set 到队尾，形成 LRU 顺序
  fileVersions.set(p, v)
  if (fileVersions.size > MAX_TRACKED) {
    fileVersions.delete(fileVersions.keys().next().value)
  }
}

// 覆盖写前的守卫。返回 null = 放行；返回字符串 = 拒绝原因。
function staleWriteReason(p) {
  if (!existsSync(p)) return null       // 新建文件，无冲突可言
  const known = fileVersions.get(p)
  if (!known) return null              // 本进程没读过 → 明确要覆盖，不拦
  const now = statVersion(p)
  if (!now) return null
  if (now.mtimeMs === known.mtimeMs && now.size === known.size) return null
  const fmt = (t) => { try { return new Date(t).toISOString() } catch { return String(t) } }
  return `文件已被其他 Agent 修改，拒绝覆盖（否则对方的改动会静默消失）：${p}\n`
    + `  记录 mtime ${fmt(known.mtimeMs)}（${known.mtimeMs}，${known.size} bytes）\n`
    + `  当前 mtime ${fmt(now.mtimeMs)}（${now.mtimeMs}，${now.size} bytes）\n`
    + `请重新 Read 这个文件，把对方的改动合并进来后再写。`
}

// 测试/诊断用：清空版本记录
export function _resetFileVersions() { fileVersions.clear() }

// ── Jupyter notebook 支持 ──────────────────────────────────────────────
// 对齐官方 Claude Code 2.1.303：Read 读 .ipynb 时输出**按 cell 组织**的视图，
// 每个 cell 带 `<cell id="...">` 标签；NotebookEdit 靠这个 id 定位 cell。
//
// 【为什么不直接当文本读】.ipynb 是 JSON，行号视图里全是 `"source": [` 这类
// 结构噪音，模型既看不出 cell 边界，也拿不到 cell id —— 而 NotebookEdit 的
// cell_id 参数**只能**从这个 id 来（官方硬要求「先 Read 再 Edit」正是为此）。
// 纯文本视图下 NotebookEdit 等于不可用。
const NOTEBOOK_MAX_BYTES = 150000   // 官方 num6862 = 150000，超了拒绝读（防爆上下文）

/** 顶层 cells 必须是数组、每项 source 是字符串或字符串数组。官方 fn828322 同款校验。 */
function isValidNotebook(nb) {
  const cells = nb?.cells
  return Array.isArray(cells) && !cells.some(c =>
    c === null || typeof c !== 'object' ||
    (typeof c.source !== 'string' && !(Array.isArray(c.source) && c.source.every(s => typeof s === 'string')))
  )
}

function cellSource(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '')
}

/**
 * `cell-3` 这种合成 id 反查索引。官方 fn82842 同款：
 * nbformat < 4.5 的 notebook 没有 cell.id，Read 时用 `cell-<序号>` 兜底，
 * 编辑时要能把它换算回下标，否则老 notebook 完全无法编辑。
 */
function cellIndexFromSyntheticId(id) {
  const m = /^cell-(\d+)$/.exec(String(id || ''))
  if (!m) return undefined
  const n = Number.parseInt(m[1], 10)
  return Number.isNaN(n) ? undefined : n
}

/** 把 notebook 渲染成「每个 cell 一段」的文本视图（对齐官方 fn82932 的标签格式）。 */
function renderNotebookView(nb) {
  const lang = nb?.metadata?.language_info?.name ?? 'python'
  return nb.cells.map((cell, i) => {
    const id = cell.id ?? `cell-${i}`
    const tags = []
    // 非 code 的 cell 才标类型；code 且非 python 才标语言 —— 与官方一致，
    // 目的是省掉绝大多数 cell 上的冗余标签。
    if (cell.cell_type !== 'code') tags.push(`<cell_type>${cell.cell_type}</cell_type>`)
    if (cell.cell_type === 'code' && lang !== 'python') tags.push(`<language>${lang}</language>`)
    return `<cell id="${id}">${tags.join('')}${cellSource(cell)}</cell id="${id}">`
  }).join('\n')
}

export class FileReadTool extends Tool {
  constructor() {
    super({
      name: 'Read',
      description: '读取文件内容（支持指定行范围）。大文件默认会被结果上限截断，传 allow_large 可读完',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '要读取的文件绝对路径（或相对当前工作目录的路径）' },
          // ── 官方字段名（对齐 claude.js:952169 的 schema）──────────────
          // offset: 从第几行开始（1-based，与官方一致）
          // limit:  读多少行
          // start_line / end_line 保留为 deprecated 别名（见 resolveRange）。
          offset: {
            type: 'number',
            description: '起始行号（从 1 开始）。省略则从文件开头读。',
          },
          limit: {
            type: 'number',
            description: '最多读取多少行。省略则读到文件末尾（或结果大小上限）。',
          },
          start_line: {
            type: 'number',
            description: '【已弃用，用 offset 代替】起始行号（1-based）。两者都给时 offset 优先。',
          },
          end_line: {
            type: 'number',
            description: '【已弃用，用 limit 代替】结束行号（含）。两者都给时 offset+limit 优先。',
          },
          // PDF 页范围（官方同名字段）。CCM 没有 PDF 解析器，这里**接收并明确说明**
          // —— 报「不支持」比静默忽略好：静默忽略会让模型以为读到了指定页。
          pages: {
            type: 'string',
            description: 'PDF 的页码范围，如 "1-5"、"3"、"10-20"。仅对 PDF 有效，单次最多 20 页。',
          },
          // 对齐官方 Claude Code 2.1.x 的 allow_large：默认情况下工具结果会被
          // maxResultSizeChars（50000 字符）截断，读大文件时只能看到前一段，
          // 得反复调 start_line 往后翻。allow_large 显式放大上限，一次读完。
          // 为什么要显式：不加限制的话，一个几百 MB 的日志会把上下文直接撑爆，
          // 而这个决定应该由调用方在知道自己在干什么时做出。
          allow_large: {
            type: 'boolean',
            description: '允许突破结果大小上限（默认 false）。仅在确知文件很大且确实需要全文时使用',
          },
        },
        required: ['file_path'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        const { start, end } = resolveReadRange(input)
        if (start !== null && start < 1) errors.push('offset/start_line 必须 >= 1')
        if (end !== null && start !== null && end < start) errors.push('end_line 必须 >= offset/start_line')
        if (input.limit !== undefined && input.limit !== null && !(Number(input.limit) > 0)) {
          errors.push('limit 必须是正数')
        }
        if (input.pages !== undefined && input.pages !== null && !/^\d+(-\d+)?$/.test(String(input.pages).trim())) {
          errors.push('pages 格式应为 "N" 或 "N-M"，如 "1-5"')
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }
  /** allow_large 时把结果上限抬高，否则沿用默认。 */
  getMaxResultSizeChars(input) {
    return input && input.allow_large ? 2_000_000 : this.maxResultSizeChars
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    if (!existsSync(p)) throw new Error(`File not found: ${p}${similarPathHint(p)}`)
    // PDF：CCM 没有解析器。明确说出来，不要静默忽略 pages 让模型以为读到了。
    if (/\.pdf$/i.test(p)) {
      return `PDF 读取暂不支持（CCM 未内置 PDF 解析器）${input.pages ? `；请求的页范围 ${input.pages} 未生效` : ''}。\n`
        + `替代方案：用 Bash 跑 pdftotext（若已安装）：\n`
        + `  pdftotext -f 1 -l 5 "${p}" - | head -200`
    }
    // 先记录版本再读内容：万一读取期间文件被改，宁可记旧版本（后续写被拦、可重读），
    // 也不要记新版本（那会放行「旧内容覆盖新文件」，正是要堵的漏）
    trackVersion(p)
    // .ipynb 走 cell 视图：NotebookEdit 的 cell_id 只能从这里拿到。
    // 行范围对 notebook 无意义（cell 不是行），忽略并说明。
    if (/\.ipynb$/i.test(p)) {
      return renderNotebookRead(p, input)
    }
    const content = readFileSync(p, 'utf-8')
    const lines = content.split('\n')
    const { start: startLine, end: endLine } = resolveReadRange(input)
    // 内部统一成 0-based 切片
    const start = Math.max(0, (startLine ?? 1) - 1)
    const end = endLine ?? (input.limit ? start + Number(input.limit) : lines.length)
    return lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(5)}| ${line}`).join('\n')
  }
}

/**
 * 解析行范围，官方字段名优先，旧名兜底。
 *
 * 【为什么要有这层】官方 schema 是 `offset`/`limit`，CCM 历史是
 * `start_line`/`end_line`。模型按训练习惯多半会传官方名，但老会话/老提示词
 * 里还留着旧名。两个都认、官方优先，才能既对齐又不破坏已有调用。
 *
 * 返回 `{ start, end }`，`end` 为**含**的结束行号（1-based），null 表示未指定。
 * `offset`+`limit` 组合会换算成 `end = offset + limit - 1`（limit 是行数）。
 */
function resolveReadRange(input) {
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const offset = num(input.offset)
  const limit = num(input.limit)
  const startLine = num(input.start_line)
  const endLine = num(input.end_line)

  const start = offset ?? startLine
  let end = endLine
  // offset+limit 优先于 end_line：官方语义里 limit 是「行数」不是「结束行」
  if (offset !== null && limit !== null) {
    end = offset + limit - 1
  } else if (limit !== null && start !== null) {
    end = start + limit - 1
  }
  return { start, end }
}

/**
 * .ipynb 的读取视图。失败时**降级成普通文本读**，不报错 ——
 * 坏掉的 notebook 也得能看一眼，直接抛错等于把「诊断」这一步也堵死了。
 */
function renderNotebookRead(p, input) {
  let raw
  try { raw = readFileSync(p, 'utf-8') } catch (e) { throw new Error(`读取失败: ${e.message}`) }
  const bytes = Buffer.byteLength(raw)
  if (bytes > NOTEBOOK_MAX_BYTES) {
    return `Notebook 文件 ${bytes} 字节，超过本工具能读的上限（${NOTEBOOK_MAX_BYTES} 字节）。\n`
      + `用 Bash 配合 jq 读特定部分：\n`
      + `  cat <notebook_path> | jq '.cells[:20]'              # 前 20 个 cell\n`
      + `  cat <notebook_path> | jq '.cells | length'          # cell 总数\n`
      + `  cat <notebook_path> | jq '.cells[] | select(.cell_type=="code") | .source'`
  }
  let nb
  try { nb = JSON.parse(raw) } catch {
    return `（不是合法 JSON，按普通文本显示；NotebookEdit 无法用于此文件）\n\n` + raw
  }
  if (!isValidNotebook(nb)) {
    return `（不是合法 Jupyter notebook：顶层 cells 必须是 cell 对象数组，每个 source 是字符串或字符串数组；按普通文本显示）\n\n` + raw
  }
  const hasRange = input.offset !== undefined || input.limit !== undefined
    || input.start_line !== undefined || input.end_line !== undefined
  const note = hasRange
    ? `（提示：行范围对 notebook 无效，已忽略；按 cell 组织显示）\n\n`
    : ''
  return note + renderNotebookView(nb)
}

export class FileWriteTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'Write',
      description: [
        '把内容写入本地文件（覆盖已有内容）。',
        '',
        '## 用法',
        '- 路径处已有文件时会被**整个覆盖**。',
        '- 如果文件已存在，必须先用 Read 读过它再写；没读过就覆盖会被并发守卫拦下。',
        '- 修改已有文件优先用 Edit（只发 diff，省 token 也更安全）。',
        '  只有「新建文件」或「整篇重写」才用 Write。',
        '',
        '## 不要做的事',
        '- 不要主动创建文档文件（*.md）或 README，除非用户明确要求。',
        '- 不要在内容里写「本文件由 AI 生成」这类元注释。',
      ].join('\n'),
      input_schema: { type: 'object', properties: {
        file_path: { type: 'string', description: '要写入的文件路径（建议用绝对路径；相对路径按当前工作目录解析）' },
        content: { type: 'string', description: '要写入的完整内容' },
        backup_note: { type: 'string', description: '（可选）这次写入的目的/简短描述，会写进备份文件名方便回溯' },
      }, required: ['file_path', 'content'] },
      isDestructive: () => true,   // 覆盖写入
      // 官方 Write 是 1e5。CCM 原来 500 —— 连一个「Wrote N bytes」都快装不下，
      // 但 Write 的返回值本来就极短，这个值只影响「异常时的错误详情」能不能完整显示。
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (input.content === undefined || input.content === null) errors.push('content is required')
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    // 并发守卫放最前面：校验失败不产生任何副作用（不污染 undo / 回收站）
    const stale = staleWriteReason(p)
    if (stale) throw new Error(stale)
    // 如果文件已存在，先备份到回收站（大文件才备份）
    backupBeforeOverwrite(p, input.content, input.backup_note || '')
    // 再保存 undo 快照
    if (existsSync(p) && this.undoStore) {
      const oldContent = readFileSync(p, 'utf-8')
      this.undoStore.saveSnapshot(p, oldContent, input.backup_note || '')
    }
    writeFileSync(p, input.content, 'utf-8')
    trackVersion(p)   // 刷新记录，否则连续两次 Write 会被自己的第一次写误拦
    return `Wrote ${input.content.length} bytes`
  }
}

export class FileEditTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'Edit',
      description: [
        '精确替换文件中的字符串。',
        '',
        '默认要求 old_string 在文件中**唯一匹配**（0 处或 >1 处都报错），',
        '这样能防止「以为改了一处、实际改了一片」。需要批量替换时显式传 replace_all: true。',
        '',
        'old_string 必须与文件内容逐字符一致（含缩进）。行号前缀（如 "   12| "）不属于文件内容，不要带上。',
      ].join('\n'),
      input_schema: { type: 'object', properties: {
        file_path: { type: 'string', description: '要修改的文件路径' },
        old_string: { type: 'string', description: '要替换的原文，必须在文件中唯一（除非 replace_all=true）。含缩进，不含行号前缀。' },
        new_string: { type: 'string', description: '替换成的新文本。空字符串表示删除这段内容。' },
        // 对齐官方 claude.js 的 Edit schema。CCM 的 MultiEdit 早就有这个字段，
        // Edit 却没有 —— 同一个功能在两条路径上行为不一致，属于漏改。
        replace_all: { type: 'boolean', description: '替换所有出现（默认 false，要求唯一匹配）' },
        backup_note: { type: 'string', description: '（可选）这次修改的目的/简短描述，会写进备份文件名方便回溯' },
      }, required: ['file_path', 'old_string', 'new_string'] },
      isDestructive: () => true,
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        // 注意：old_string 允许空串的情况在官方是不允许的（空串会匹配每个字符间）。
        // 这里沿用严格校验，并在错误里说清为什么。
        if (!input.old_string) errors.push('old_string is required（不能为空串——空串会在每个字符间插入）')
        if (input.new_string === undefined || input.new_string === null) errors.push('new_string is required')
        // 对齐官方 claude.js:947612 起的 Edit schema 语义，也与同文件 MultiEdit 的校验一致。
        // 没有这一条时 new === old 会走完整个 execute：old_string 找得到、替换成一样的文本、
        // 写回内容零变化，最后返回「已修改」——用户以为改了、实际什么都没改，且无从察觉。
        if (input.new_string !== undefined && input.new_string === input.old_string) {
          errors.push('new_string 与 old_string 相同，这次编辑不会产生任何改动。'
            + '要修改请给出不同的新内容；要删除内容请把 new_string 传空字符串。')
        }
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    if (!existsSync(p)) throw new Error(`File not found: ${p}${similarPathHint(p)}`)
    const content = readFileSync(p, 'utf-8')
    // 先校验，校验失败不产生任何副作用（不污染 undo / 回收站）
    const occurrences = content.split(input.old_string).length - 1
    if (occurrences === 0) throw new Error('old_string not found')
    // replace_all 时不要求唯一；否则 >1 处仍然报错（防误改一片）
    if (occurrences > 1 && !input.replace_all) {
      throw new Error(
        `old_string 匹配 ${occurrences} 处，不唯一。\n`
        + `  · 要全部替换：加 replace_all: true\n`
        + `  · 只改其中一处：在 old_string 里多带几行上下文，使它唯一`
      )
    }
    // 用 split/join 做替换，避免替换串里的美元符号被当作 replace 的特殊替换模式而损坏内容
    const newContent = content.split(input.old_string).join(input.new_string)
    // 备份到回收站（大修改才备份）
    backupBeforeOverwrite(p, newContent, input.backup_note || '')
    // undo 快照
    if (this.undoStore) this.undoStore.saveSnapshot(p, content, input.backup_note || '')
    writeFileSync(p, newContent, 'utf-8')
    trackVersion(p)   // Edit 也改了 mtime，不刷新的话之后的 Write 会被误拦
    return occurrences > 1
      ? `Edited ${p}（替换 ${occurrences} 处）`
      : `Edited ${p}`
  }
}

export class MultiEditTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'MultiEdit',
      description: '对单个文件做多处精确替换（原子操作：全部成功才写盘，任一失败则整体不改）。edits 按顺序依次应用，后面的 edit 看到的是前面 edit 之后的内容。比多次调用 Edit 更快更安全。\n'
        + '注：官方 Claude Code 2.1.x 已把 MultiEdit 合并进 Edit（靠多次调用 + replace_all）。'
        + '本工具是 CCM 保留的扩展，功能等价；新代码更推荐用 Edit + replace_all。',
      input_schema: { type: 'object', properties: {
        file_path: { type: 'string', description: '目标文件路径' },
        edits: {
          type: 'array',
          description: '替换操作列表，按顺序应用',
          items: { type: 'object', properties: {
            old_string: { type: 'string', description: '要替换的原文（必须在当前内容中唯一，除非 replace_all=true）' },
            new_string: { type: 'string', description: '替换成的新文本' },
            replace_all: { type: 'boolean', description: '替换所有出现（默认 false，要求唯一匹配）' },
          }, required: ['old_string', 'new_string'] },
        },
        backup_note: { type: 'string', description: '（可选）这次修改的目的/简短描述，会写进备份文件名方便回溯' },
      }, required: ['file_path', 'edits'] },
      isDestructive: () => true,
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.file_path) errors.push('file_path is required')
        if (!Array.isArray(input.edits) || input.edits.length === 0) {
          errors.push('edits must be a non-empty array')
        } else {
          input.edits.forEach((e, i) => {
            if (!e || typeof e !== 'object') { errors.push(`edits[${i}] must be an object`); return }
            if (!e.old_string) errors.push(`edits[${i}].old_string is required`)
            if (e.new_string === undefined || e.new_string === null) errors.push(`edits[${i}].new_string is required`)
            if (e.old_string === e.new_string) errors.push(`edits[${i}]: old_string 与 new_string 相同`)
          })
        }
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }
  async execute(input, ctx = {}) {
    const p = toolPath(input.file_path, ctx)
    if (!existsSync(p)) throw new Error(`File not found: ${p}${similarPathHint(p)}`)
    const original = readFileSync(p, 'utf-8')

    // 全部在内存中应用，任一失败直接抛错 → 文件保持原样
    let content = original
    const applied = []
    for (let i = 0; i < input.edits.length; i++) {
      const { old_string, new_string, replace_all } = input.edits[i]
      const occurrences = content.split(old_string).length - 1
      if (occurrences === 0) {
        throw new Error(`edits[${i}] 失败：old_string 未找到（前 ${i} 个编辑已在内存中应用，文件未改动）\n  ${JSON.stringify(old_string.slice(0, 80))}`)
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(`edits[${i}] 失败：old_string 匹配 ${occurrences} 处，不唯一。加 replace_all:true 或提供更长的上下文（文件未改动）`)
      }
      content = content.split(old_string).join(new_string)
      applied.push(`  ${i + 1}. 替换 ${occurrences} 处`)
    }

    backupBeforeOverwrite(p, content, input.backup_note || '')
    if (this.undoStore) this.undoStore.saveSnapshot(p, original, input.backup_note || '')
    writeFileSync(p, content, 'utf-8')
    trackVersion(p)   // 同 Edit：刷新版本，避免后续 Write 被误拦
    return `MultiEdit 完成 ${p}（${input.edits.length} 个编辑）\n${applied.join('\n')}`
  }
}

/**
 * NotebookEdit —— 编辑 Jupyter notebook 的单个 cell。
 *
 * 对齐官方 Claude Code 2.1.303 的 NotebookEdit（claude.js:953407 起）。
 *
 * 【为什么需要独立工具而不是让 Edit 改 JSON】
 * .ipynb 是结构化 JSON，一次「改一行代码」在文本层面要同时处理
 * source 数组、转义、逗号、缩进 —— Edit 的字符串替换在这里既脆又难验证。
 * 更关键的是：改 code cell 必须**清空 execution_count 和 outputs**，
 * 否则 notebook 里会留着一段与代码不符的旧输出（Jupyter 打开时显示过期结果，
 * 这是最典型的「notebook 骗人」问题）。文本编辑做不到这件事。
 *
 * 【为什么强制先 Read】
 * cell_id 只能从 Read 的 `<cell id="...">` 视图里拿到。不先读就等于让模型
 * 猜 id，猜错了会改错 cell —— 静默改错比报错严重得多。
 * 所以这里沿用 file-tools 的「本进程读过」记录（fileVersions）作为闸门。
 */
export class NotebookEditTool extends Tool {
  constructor(undoStore) {
    const config = {
      name: 'NotebookEdit',
      description: [
        '替换、插入或删除 Jupyter notebook（.ipynb）里的单个 cell。',
        '',
        '用法要点：',
        '- **必须先用 Read 读这个 notebook**，否则工具会拒绝（cell_id 只能从 Read 的 `<cell id="...">` 里拿到）。',
        '- `notebook_path` 必须是**绝对路径**。',
        '- `cell_id` 就是 Read 输出里 `<cell id="...">` 的 id；`replace` / `delete` 时必需。',
        '- `edit_mode` 默认 `replace`。`insert` 表示「插到指定 cell 之后」（省略 cell_id 则插到最前面），此时 `cell_type` 必填。`delete` 删除该 cell。',
        '',
        '示例：',
        '  替换：{notebook_path:"/sdcard/x.ipynb", cell_id:"a1b2c3d4", new_source:"print(1)"}',
        '  插入：{notebook_path:"/sdcard/x.ipynb", cell_id:"a1b2c3d4", edit_mode:"insert", cell_type:"code", new_source:"df.head()"}',
        '  删除：{notebook_path:"/sdcard/x.ipynb", cell_id:"a1b2c3d4", edit_mode:"delete", new_source:""}',
        '',
        '注意：改 code cell 会**自动清空它的 execution_count 和 outputs**（旧输出已与代码不符，留着会误导）。',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: '要编辑的 Jupyter notebook 文件（必须是绝对路径，不能是相对路径）' },
          cell_id: { type: 'string', description: '要编辑的 cell id（来自 Read 输出的 `<cell id="...">`）。insert 时表示「插到这个 cell 之后」，省略则插到开头。' },
          new_source: { type: 'string', description: 'cell 的新内容。delete 时可传空字符串。' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'cell 类型。replace 时省略则保持原类型；insert 时**必填**。' },
          edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: '编辑方式，默认 replace。' },
          backup_note: { type: 'string', description: '（可选）这次修改的目的/简短描述，会写进备份文件名方便回溯' },
        },
        required: ['notebook_path', 'new_source'],
      },
      isDestructive: () => true,
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!input.notebook_path) errors.push('notebook_path is required')
        if (input.new_source === undefined || input.new_source === null) errors.push('new_source is required')
        const mode = input.edit_mode || 'replace'
        if (!['replace', 'insert', 'delete'].includes(mode)) errors.push('edit_mode 只能是 replace / insert / delete')
        if (mode === 'insert' && !input.cell_type) errors.push('edit_mode=insert 时 cell_type 必填（code 或 markdown）')
        if (mode !== 'insert' && !input.cell_id) errors.push(`${mode} 时 cell_id 必填`)
        return { valid: errors.length === 0, errors }
      },
    }
    super(config, { undoStore })
    this.undoStore = undoStore
  }

  async execute(input, ctx = {}) {
    const p = toolPath(input.notebook_path, ctx)
    if (!existsSync(p)) throw new Error(`File not found: ${p}${similarPathHint(p)}`)
    if (!/\.ipynb$/i.test(p)) {
      throw new Error('这个文件不是 Jupyter notebook（.ipynb）。编辑其他文件请用 Edit。')
    }
    // 闸门：必须本进程 Read 过。没读过就不知道有哪些 cell id，
    // 硬猜必然改错位置。
    if (!fileVersions.has(p)) {
      throw new Error(`还没有读过这个 notebook：${p}\n请先用 Read 读它，从输出里拿到 <cell id="..."> 再编辑。`)
    }
    // 读过之后又被别人改了 → 拒写（与 Write/Edit 同一套并发守卫）
    const stale = staleWriteReason(p)
    if (stale) throw new Error(stale)

    const raw = readFileSync(p, 'utf-8')
    let nb
    try { nb = JSON.parse(raw) } catch (e) { throw new Error(`notebook 不是合法 JSON: ${e.message}`) }
    if (!isValidNotebook(nb)) {
      throw new Error('不是合法 Jupyter notebook（顶层 cells 必须是 cell 对象数组，每个 source 是字符串或字符串数组）')
    }

    const mode = input.edit_mode || 'replace'
    const cellId = typeof input.cell_id === 'string' ? input.cell_id.trim() : ''
    const newSource = String(input.new_source ?? '')

    // 定位：先按真实 id 找，找不到再按 `cell-N` 合成 id 反查下标
    //（nbformat < 4.5 的 notebook 没有 cell.id，Read 时用 cell-N 兜底）
    let index = -1
    if (cellId) {
      index = nb.cells.findIndex(c => c && c.id === cellId)
      if (index === -1) {
        const synthetic = cellIndexFromSyntheticId(cellId)
        if (synthetic !== undefined && synthetic >= 0 && synthetic <= nb.cells.length) index = synthetic
      }
      if (index === -1) {
        const available = nb.cells.map((c, i) => c?.id ?? `cell-${i}`)
        throw new Error(
          `cell_id "${cellId}" 不存在。当前 notebook 的 cell：${available.join(', ') || '(空)'}\n`
          + `id 来自 Read 输出的 <cell id="...">；notebook 改过之后要重新 Read。`
        )
      }
    }

    // 官方同款兜底：replace 的 id 落到「末尾之后」（即 cell-N 恰好等于长度）
    // 说明调用方其实想追加，转成 insert，否则会越界报错。
    let effectiveMode = mode
    let effectiveCellType = input.cell_type
    if (effectiveMode === 'replace' && index === nb.cells.length) {
      effectiveMode = 'insert'
      if (!effectiveCellType) effectiveCellType = 'code'
    }

    // nbformat >= 4.5 的 notebook 每个 cell 必须有 id；老格式不加（加了反而不合法）
    const supportsCellId = nb.nbformat > 4 || (nb.nbformat === 4 && (nb.nbformat_minor ?? 0) >= 5)
    const language = nb.metadata?.language_info?.name ?? 'python'
    let oldSource = ''
    let resultCellId
    let resultCellType

    if (effectiveMode === 'insert') {
      const at = cellId ? index + 1 : 0
      resultCellId = supportsCellId ? randomBytes(4).toString('hex') : undefined
      resultCellType = effectiveCellType || 'code'
      const cell = resultCellType === 'markdown'
        ? { cell_type: 'markdown', ...(resultCellId ? { id: resultCellId } : {}), source: newSource, metadata: {} }
        : { cell_type: 'code', ...(resultCellId ? { id: resultCellId } : {}), source: newSource, metadata: {}, execution_count: null, outputs: [] }
      nb.cells.splice(at, 0, cell)
    } else if (effectiveMode === 'delete') {
      const cell = nb.cells[index]
      oldSource = cellSource(cell)
      resultCellId = cell?.id ?? `cell-${index}`
      resultCellType = cell?.cell_type || 'code'
      nb.cells.splice(index, 1)
    } else {
      // replace
      const cell = nb.cells[index]
      if (!cell) throw new Error(`cell 下标 ${index} 越界（共 ${nb.cells.length} 个 cell）`)
      oldSource = cellSource(cell)
      resultCellId = cell.id ?? `cell-${index}`
      cell.source = newSource
      // 改代码 → 旧输出必然过期，必须清掉（这是本工具相对 Edit 的核心价值）
      if (cell.cell_type === 'code') {
        cell.execution_count = null
        cell.outputs = []
      }
      if (effectiveCellType && effectiveCellType !== cell.cell_type) {
        cell.cell_type = effectiveCellType
        // 类型换成 code 时补上 code 必需的字段，否则 Jupyter 打开会报 schema 错
        if (effectiveCellType === 'code') {
          if (!Array.isArray(cell.outputs)) cell.outputs = []
          if (cell.execution_count === undefined) cell.execution_count = null
        } else {
          // 换成 markdown：code 专属字段留着是非法 schema
          delete cell.outputs
          delete cell.execution_count
        }
      }
      resultCellType = cell.cell_type
    }

    // 保留原文件的换行风格：不保留的话整个 notebook 会显示成全文件改动
    const usesCRLF = raw.includes('\r\n')
    let out = JSON.stringify(nb, null, 1)
    if (!out.endsWith('\n')) out += '\n'
    if (usesCRLF) out = out.replace(/\n/g, '\r\n')

    // 体积上限：与本工具能读的上限一致，超了拒绝（不写半截文件）
    const bytes = Buffer.byteLength(out)
    if (bytes > NOTEBOOK_MAX_BYTES) {
      throw new Error(
        `编辑被拒绝：改完的 notebook 会有 ${bytes} 字节，超过本工具上限 ${NOTEBOOK_MAX_BYTES}。文件未改动。`
      )
    }

    backupBeforeOverwrite(p, out, input.backup_note || '')
    if (this.undoStore) this.undoStore.saveSnapshot(p, raw, input.backup_note || '')
    writeFileSync(p, out, 'utf-8')
    trackVersion(p)   // 刷新版本记录，否则同一轮里连续两次 NotebookEdit 会被自己误拦

    const verb = effectiveMode === 'insert' ? '已插入' : effectiveMode === 'delete' ? '已删除' : '已更新'
    const idNote = resultCellId ? ` cell ${resultCellId}` : ' cell'
    return `${verb}${idNote}（${resultCellType}，语言 ${language}）\n`
      + `notebook: ${p}（共 ${nb.cells.length} 个 cell，${bytes} 字节）\n`
      + (effectiveMode === 'delete' ? '' : `新内容：\n${newSource}`)
  }
}
