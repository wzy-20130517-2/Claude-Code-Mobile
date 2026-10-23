// .claude/commands/*.md 自定义 slash 命令（对标原版 Claude Code）
// frontmatter: description / argument-hint / allowed-tools
import { readdirSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { DATA_DIR } from '../infra/paths.mjs'
import { join, basename } from 'node:path'

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: raw }
  const head = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).replace(/^\n/, '')
  const meta = {}
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return { meta, body }
}

/**
 * 运行时注册的命令表（进程级，跨 loader 实例共享）。
 *
 * 【为什么不是 loader 实例上的字段】MCP 是异步就绪的，prompt 到达时
 * customCommands 已经建好了；要让它看见，要么改 index.mjs 把 loader
 * 传进 MCP（那会多改一个别人的文件、还要处理时序），要么用一张模块级表
 * 让所有实例都能读到。后者 reload() 时自动重放，代价是跨实例共享 ——
 * 本进程只有一个 CLI 或一个 Web 会话在用，可接受。
 */
const dynamicCommands = new Map()

/**
 * 注册一条运行时命令（MCP prompt 转 slash 命令用）。
 * body 存 prompt 的展开说明；source 标 'mcp:<server>' 供排查。
 */
export function registerDynamicCommand(name, entry) {
  const n = String(name || '').replace(/^\//, '').trim()
  if (!n || n.includes('/') || n.includes('..')) return false
  dynamicCommands.set(n, {
    name: n,
    description: entry?.description || '',
    argumentHint: entry?.argumentHint || '',
    body: entry?.body || '',
    source: entry?.source || 'dynamic',
    dynamic: true,
  })
  return true
}

/** 撤掉某个前缀下所有动态命令（MCP 重连时先清再重建）。 */
export function clearDynamicCommands(prefix) {
  if (!prefix) dynamicCommands.clear()
  else for (const k of [...dynamicCommands.keys()]) if (k.startsWith(prefix)) dynamicCommands.delete(k)
}

export class CustomCommandLoader {
  constructor(roots = []) {
    this.roots = roots
    this.commands = new Map() // name -> { name, description, body, source }
    this.reload()
  }

  reload() {
    this.commands.clear()
    for (const [name, entry] of dynamicCommands) this.commands.set(name, entry)
    for (const root of this.roots) {
      if (!existsSync(root)) continue
      let files = []
      try { files = readdirSync(root).filter(f => f.endsWith('.md')) } catch { continue }
      for (const f of files) {
        try {
          const full = join(root, f)
          if (!statSync(full).isFile()) continue
          const raw = readFileSync(full, 'utf-8')
          const { meta, body } = parseFrontmatter(raw)
          const name = (meta.name || basename(f, '.md')).replace(/^\//, '')
          if (!name || name.includes('/') || name.includes('..')) continue
          this.commands.set(name, {
            name,
            description: meta.description || meta['argument-hint'] || '',
            argumentHint: meta['argument-hint'] || '',
            body,
            source: full,
          })
        } catch {}
      }
    }
  }

  list() {
    return [...this.commands.values()].map(c => ({
      name: c.name,
      description: c.description,
      source: c.source,
      argumentHint: c.argumentHint || '',
      dynamic: c.dynamic === true,
    }))
  }

  has(name) { return this.commands.has(name) }

  /** 展开命令：把 $ARGUMENTS / {{args}} 替换成用户参数 */
  expand(name, argsText = '') {
    const c = this.commands.get(name)
    if (!c) return null
    let body = c.body
    body = body.replace(/\$ARGUMENTS/g, argsText)
    body = body.replace(/\{\{\s*args\s*\}\}/g, argsText)
    // $1 $2 … 按空白切分
    const parts = argsText.trim() ? argsText.trim().split(/\s+/) : []
    body = body.replace(/\$(\d+)/g, (_, n) => parts[Number(n) - 1] || '')
    return {
      name: c.name,
      description: c.description,
      content: body,
      source: c.source,
      argumentHint: c.argumentHint || '',
      dynamic: c.dynamic === true,
    }
  }

  formatForPrompt() {
    const list = this.list()
    if (!list.length) return ''
    return '\n\n# 用户自定义 slash 命令（.claude/commands）\n' +
      list.map(c => `- \`/${c.name}\`: ${c.description || '(无描述)'}`).join('\n') +
      '\n用户输入这些命令时，系统会展开对应 markdown 作为任务指令。\n'
  }
}

export function ensureCommandsDir(cwd) {
  const dir = join(cwd, '.claude', 'commands')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/**
 * 用户级 commands 目录（数据目录下）—— 优先级最高。
 * 同 agents：用户手写的 slash 命令是用户数据，2026-10-03 起放 ~/.claude-code-mobile/commands/。
 */
export function userCommandsDir() {
  const dir = join(DATA_DIR, 'commands')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
