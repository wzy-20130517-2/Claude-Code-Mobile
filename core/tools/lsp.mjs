// Claude Code Mobile - LSP 客户端（供 Diagnostics 工具使用）
// 提供诊断能力；支持 TypeScript 和 Python（pyright）

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, extname, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Tool } from './tools.mjs'

// ─────────────────────────────────────────────────────────────
// LSP Server 配置：按文件扩展名路由
// ─────────────────────────────────────────────────────────────
const NPM_ROOT = '/data/data/com.termux/files/usr/lib/node_modules'
const TSLSP_BIN = `${NPM_ROOT}/typescript-language-server/lib/cli.mjs`
const TSSERVER_PATH = `${NPM_ROOT}/typescript/lib/tsserver.js`
const PYRIGHT_LS = `${NPM_ROOT}/pyright/langserver.index.js`

// 语言 → LSP 服务器配置
const SERVER_CONFIGS = {
  typescript: {
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    command: process.execPath,
    args: [TSLSP_BIN, '--stdio'],
    initOptions: {
      // typescript-language-server 支持的 initializationOptions
      tsserver: { path: TSSERVER_PATH },
      logVerbosity: 'off',
      plugins: [],
      // 启用诊断（推送到 client）
      diagnostics: true,
      // 关闭 file-level 语义检查的延迟（尽快发送）
      diagnosticDelay: 0,
    },
  },
  python: {
    extensions: ['.py', '.pyi'],
    command: process.execPath,
    args: [PYRIGHT_LS, '--stdio'],
    initOptions: {},
  },
}

// 扩展名 → 语言
const EXT_TO_LANG = {}
for (const [lang, cfg] of Object.entries(SERVER_CONFIGS)) {
  for (const ext of cfg.extensions) EXT_TO_LANG[ext] = lang
}

function getLanguage(filePath) {
  return EXT_TO_LANG[extname(filePath).toLowerCase()]
}

// ─────────────────────────────────────────────────────────────
// LSP Client：单例，管理一个语言的长连接子进程
// ─────────────────────────────────────────────────────────────
class LspClient {
  constructor(config, language) {
    this.config = config
    this.language = language
    this.proc = null
    this.requestId = 0
    this.pending = new Map()      // id → { resolve, reject, timer }
    this.openedFiles = new Map()  // filePath → { mtime, version }，用 mtime 检测文件改动
    this.initialized = false
    this.initPromise = null
    this.shuttingDown = false
    this.lastActivity = Date.now()
  }

  async _ensureStarted() {
    if (this.proc && this.proc.exitCode === null && !this.shuttingDown) return
    if (this.initPromise) return this.initPromise
    // 失败时清空 initPromise，允许下次重试（否则 rejected promise 会被缓存，LSP 永久不可用直到重启）
    this.initPromise = this._start().catch((e) => {
      this.initPromise = null
      throw e
    })
    return this.initPromise
  }

  async _start() {
    const { command, args } = this.config
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_prefix: NPM_ROOT },
    })
    // spawn 失败（命令不存在/无执行权限）会异步 emit 'error'，无监听者会抛未捕获异常崩整个进程
    this.proc.on('error', (err) => {
      for (const { reject } of this.pending.values()) {
        try { reject(new Error(`LSP server (${this.language}) spawn failed: ${err.message}`)) } catch {}
      }
      this.pending.clear()
      this.openedFiles.clear()
      this.initialized = false
      this.initPromise = null
      this.proc = null
    })
    this.proc.on('exit', (code, signal) => {
      // 非预期退出，清理状态，下次重新启动
      if (!this.shuttingDown) {
        for (const { reject } of this.pending.values()) {
          reject(new Error(`LSP server (${this.language}) exited unexpectedly (code=${code})`))
        }
        this.pending.clear()
        this.openedFiles.clear()
        this.initialized = false
        this.initPromise = null
        this.proc = null
      }
    })
    let buf = Buffer.alloc(0)
    this.proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        if (buf.length < 16) return
        const headerEnd = buf.indexOf('\r\n\r\n', 0, 'utf8')
        if (headerEnd < 0) return
        const headerStr = buf.slice(0, headerEnd).toString('utf8')
        const headerMap = {}
        for (const line of headerStr.split('\r\n')) {
          const [k, v] = line.split(': ')
          if (k && v) headerMap[k.toLowerCase()] = v
        }
        const contentLen = parseInt(headerMap['content-length'] || '0', 10)
        if (isNaN(contentLen) || contentLen <= 0 || buf.length < headerEnd + 4 + contentLen) return
        const body = buf.slice(headerEnd + 4, headerEnd + 4 + contentLen).toString('utf8')
        buf = buf.slice(headerEnd + 4 + contentLen)
        let msg
        try { msg = JSON.parse(body) } catch { continue }
        this._handleMessage(msg)
      }
    })
    this.proc.stderr.on('data', () => { /* 丢弃 stderr，避免噪音 */ })
    // LSP initialize
    const result = await this._send('initialize', {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: false, willSave: false },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          completion: { completionItem: { snippetSupport: false } },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: { linkSupport: false },
        },
        workspace: { symbol: {} },
      },
      rootUri: `file://${this.config.cwd || process.cwd()}`,
      initializationOptions: this.config.initOptions || {},
    })
    // 发 initialized notification
    this._notify('initialized', {})
    this.initialized = true
    return result
  }

  _handleMessage(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id)
      clearTimeout(timer)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      // 按 uri 缓存诊断（push 模式）
      const uri = msg.params && msg.params.uri
      if (uri) this.diagnosticsByUri = this.diagnosticsByUri || new Map()
      if (uri && this.diagnosticsByUri) {
        const diags = msg.params.diagnostics || []
        this.diagnosticsByUri.set(uri, diags)
        // 跟踪每个 uri 最近的 publish 时间（用于静默等待）
        this._diagTimes = this._diagTimes || new Map()
        this._diagTimes.set(uri, Date.now())
        // 仅当获得非空诊断或多次更新后再通知等待者
        this._diagNotifyCount = this._diagNotifyCount || new Map()
        const cnt = (this._diagNotifyCount.get(uri) || 0) + 1
        this._diagNotifyCount.set(uri, cnt)
        // 第一次空（0 项）表示 server 预热阶段，继续等
        // 第二次或非空即可通知
        if (cnt >= 2 || diags.length > 0) {
          const waiters = this._diagWaiters && this._diagWaiters.get(uri)
          if (waiters) {
            this._diagWaiters.delete(uri)
            this._diagNotifyCount.delete(uri)
            for (const w of waiters) w()
          }
        }
        // 第一次 0 项时继续等待后续 publish 或总超时
      }
    }
    // 其他通知忽略
  }

  _waitForDiagnostics(uri, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!this.diagnosticsByUri) this.diagnosticsByUri = new Map()
      this._diagWaiters = this._diagWaiters || new Map()
      const arr = this._diagWaiters.get(uri) || []
      arr.push(resolve)
      this._diagWaiters.set(uri, arr)
      // 总超时兜底
      setTimeout(() => {
        const waiters = this._diagWaiters && this._diagWaiters.get(uri)
        if (waiters) {
          this._diagWaiters.delete(uri)
          for (const w of waiters) w()
        }
      }, timeoutMs)
    })
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        reject(new Error('LSP server not running'))
        return
      }
      const id = ++this.requestId
      const msg = { jsonrpc: '2.0', id, method, params: params || {} }
      const body = JSON.stringify(msg)
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request '${method}' timed out (10s)`))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(header + body)
    })
  }

  _notify(method, params) {
    if (!this.proc || this.proc.exitCode !== null) return
    const msg = { jsonrpc: '2.0', method, params: params || {} }
    const body = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    this.proc.stdin.write(header + body)
  }

  async openFile(filePath) {
    await this._ensureStarted()
    let text
    try { text = readFileSync(filePath, 'utf8') } catch (e) {
      throw new Error(`无法读取文件: ${e.message}`)
    }
    // 用 mtime 判断文件自上次打开后是否被改动（Edit/Write 后）
    let mtime = 0
    try { mtime = statSync(filePath).mtimeMs } catch {}
    const prev = this.openedFiles.get(filePath)
    if (prev && prev.mtime === mtime) return false  // 未变化，命中缓存（未重新同步）
    const uri = `file://${filePath}`
    const lang = getLanguage(filePath)
    const LANGUAGE_ID = { typescript: 'typescript', python: 'python' }
    if (prev) {
      // 文件已打开但内容变了：先 didClose 再重新 didOpen，让 server 丢弃旧诊断
      this._notify('textDocument/didClose', { textDocument: { uri } })
      // 清掉该 uri 的旧推送诊断缓存，避免 getDiagnostics 命中过期结果
      if (this.diagnosticsByUri) this.diagnosticsByUri.delete(uri)
    }
    const version = prev ? (prev.version + 1) : 1
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId: LANGUAGE_ID[lang] || lang, version, text },
    })
    this.openedFiles.set(filePath, { mtime, version })
    this.lastActivity = Date.now()
    // 给 server 500ms 预热 publishDiagnostics
    await new Promise(r => setTimeout(r, 500))
    return true  // 发生了 open / 重新 open（内容变化）
  }

  async getDiagnostics(filePath) {
    const uri = `file://${filePath}`
    // openFile 返回是否发生了同步（首次打开或文件改动后重开）；发生了就等诊断刷新
    const synced = await this.openFile(filePath)
    if (synced) await this._waitForDiagnostics(uri, 3000)
    // 尝试 pull diagnostics（LSP 3.17）
    try {
      const result = await this._send('textDocument/diagnostic', { textDocument: { uri } })
      if (result && result.items && result.items.length > 0) return result.items
    } catch { /* server 不支持 pull */ }
    // 回退到 push 缓存
    if (this.diagnosticsByUri && this.diagnosticsByUri.has(uri)) {
      const cached = this.diagnosticsByUri.get(uri)
      if (cached.length > 0) return cached
    }
    // 最终兜底：tsc 命令行 / pyright 命令行
    return this._fallbackDiagnostics(filePath)
  }

  async _fallbackDiagnostics(filePath) {
    const lang = getLanguage(filePath)
    if (lang === 'typescript') {
      try {
        const output = execFileSync(process.execPath, [
          `${NPM_ROOT}/typescript/bin/tsc`, '--noEmit', '--pretty', 'false', filePath
        ], { cwd: dirname(filePath), timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
        return []  // tsc 成功=无错误
      } catch (e) {
        const stderr = (e.stderr || '') + (e.stdout || '')
        return parseTscErrors(stderr)
      }
    }
    if (lang === 'python') {
      try {
        const output = execFileSync(process.execPath, [
          `${NPM_ROOT}/pyright/index.js`, filePath
        ], { cwd: dirname(filePath), timeout: 15000, encoding: 'utf-8' })
        return parsePyrightErrors(output)
      } catch (e) {
        const stdout = e.stdout || ''
        return parsePyrightErrors(stdout)
      }
    }
    return []
  }

  async hover(filePath, line, character) {
    await this.openFile(filePath)
    return this._send('textDocument/hover', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
  }

  async definition(filePath, line, character) {
    await this.openFile(filePath)
    const result = await this._send('textDocument/definition', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
    return result
  }

  async completion(filePath, line, character) {
    await this.openFile(filePath)
    const result = await this._send('textDocument/completion', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
    return result
  }

  async references(filePath, line, character, includeDeclaration = true) {
    await this.openFile(filePath)
    return this._send('textDocument/references', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration },
    })
  }

  async documentSymbol(filePath) {
    await this.openFile(filePath)
    return this._send('textDocument/documentSymbol', {
      textDocument: { uri: `file://${filePath}` },
    })
  }

  async implementation(filePath, line, character) {
    await this.openFile(filePath)
    return this._send('textDocument/implementation', {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })
  }

  // workspace/symbol 与具体文件无关，但仍需要 server 已起来；
  // 拿不到 filePath 时调用方会传同语言的任意文件来定语言。
  //
  // 必须先 openFile 一个文件：tsserver 在没有任何打开文件时没有 project，
  // 直接 workspace/symbol 会回 "TypeScript Server Error: No Project"
  // （实测：全新进程首个调用必现，同进程先做过 definition 就正常 —— 极隐蔽）。
  async workspaceSymbol(query, hintFilePath) {
    await this._ensureStarted()
    if (hintFilePath) await this.openFile(hintFilePath)
    return this._send('workspace/symbol', { query })
  }

  async shutdown() {
    if (!this.proc || this.proc.exitCode !== null) return
    this.shuttingDown = true
    try {
      await this._send('shutdown', {})
      this._notify('exit', null)
    } catch {}
    this.proc.stdin.end()
    this.proc.kill()
    this.proc = null
    this.initialized = false
    this.initPromise = null
    this.openedFiles.clear()
    this.pending.clear()
  }
}

// ─────────────────────────────────────────────────────────────
// 全局 LSP 管理器：按语言缓存 client，长时持有
// ─────────────────────────────────────────────────────────────
class LspManager {
  constructor() {
    this.clients = new Map()  // lang → LspClient
    this.idleCheckTimer = setInterval(() => this._gcIdle(), 60000)
    // 不阻止进程自然退出
    if (this.idleCheckTimer.unref) this.idleCheckTimer.unref()
  }

  getClient(lang, cwd = process.cwd()) {
    if (!SERVER_CONFIGS[lang]) return null
    const key = `${lang}:${resolve(cwd)}`
    if (!this.clients.has(key)) {
      const cfg = { ...SERVER_CONFIGS[lang], cwd: resolve(cwd) }
      this.clients.set(key, new LspClient(cfg, lang))
    }
    return this.clients.get(key)
  }

  async run(filePath, action, params, cwd = process.cwd()) {
    const lang = getLanguage(filePath)
    if (!lang) {
      return {
        error: `LSP 不支持此文件类型: ${extname(filePath)}`,
        supported: Object.values(SERVER_CONFIGS).flatMap(c => c.extensions),
      }
    }
    if (!existsSync(resolve(filePath))) {
      return { error: `文件不存在: ${filePath}` }
    }
    const client = this.getClient(lang)
    try {
      switch (action) {
        case 'diagnostic':
          return await client.getDiagnostics(filePath)
        case 'hover':
          return await client.hover(filePath, params.line - 1, params.character - 1)
        case 'definition':
          return await client.definition(filePath, params.line - 1, params.character - 1)
        case 'references':
          return await client.references(
            filePath,
            params.line - 1,
            params.character - 1,
            params.includeDeclaration !== false
          )
        case 'implementation':
          return await client.implementation(filePath, params.line - 1, params.character - 1)
        case 'completion':
          return await client.completion(filePath, params.line - 1, params.character - 1)
        case 'documentSymbol':
          return await client.documentSymbol(filePath)
        case 'workspaceSymbol':
          return await client.workspaceSymbol(params.query || '', filePath)
        default:
          return { error: `未知操作: ${action}` }
      }
    } catch (e) {
      return { error: e.message }
    }
  }

  _gcIdle() {
    // 5 分钟未使用则关闭
    const now = Date.now()
    for (const [lang, client] of this.clients) {
      if (now - client.lastActivity > 5 * 60 * 1000) {
        client.shutdown().catch(() => {})
        this.clients.delete(lang)
      }
    }
  }

  async shutdownAll() {
    await Promise.allSettled([...this.clients.values()].map(c => c.shutdown()))
    this.clients.clear()
    clearInterval(this.idleCheckTimer)
  }
}

// 全局单例
const lspManager = new LspManager()

// 解析 tsc 输出（格式：file(line,col): error TS1234: msg）
function parseTscErrors(output) {
  const diagnostics = []
  const re = /^([^(]+)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/gm
  let m
  while ((m = re.exec(output)) !== null) {
    diagnostics.push({
      severity: m[4] === 'error' ? 1 : 2,
      message: `TS${m[5]}: ${m[6]}`,
      source: 'tsc',
      range: {
        start: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) - 1 },
        end: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) },
      },
    })
  }
  return diagnostics
}

// 解析 pyright 输出（pyright 命令行模式默认输出：file:line:col - error: msg）
function parsePyrightErrors(output) {
  const diagnostics = []
  const re = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning|info):\s+(.+)$/gm
  let m
  while ((m = re.exec(output)) !== null) {
    diagnostics.push({
      severity: m[4] === 'error' ? 1 : m[4] === 'warning' ? 2 : 3,
      message: m[5],
      source: 'pyright',
      range: {
        start: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) - 1 },
        end: { line: parseInt(m[2]) - 1, character: parseInt(m[3]) },
      },
    })
  }
  return diagnostics
}

export { lspManager, SERVER_CONFIGS, getLanguage }

// ─────────────────────────────────────────────────────────────
// LSP 工具：把 LspClient 已有的能力暴露给模型
// 对齐官方设计：一个工具 + operation 字段分派（官方 dreamTask.js:4806）
// 行号入参统一 1-based（与 Read/HashlineRead 一致），内部转 0-based 给 LSP
// ─────────────────────────────────────────────────────────────

// LSP SymbolKind → 人类可读（与官方 dreamTask.js 的映射一致）
const SYMBOL_KINDS = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
  7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
  12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null', 22: 'EnumMember',
  23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
}

// hover.contents 可能是字符串 / {value} / {language,value} / 数组
function flattenHoverContents(contents) {
  const pick = (c) => (typeof c === 'string' ? c : (c && typeof c.value === 'string' ? c.value : ''))
  if (Array.isArray(contents)) return contents.map(pick).filter(Boolean).join('\n\n')
  return pick(contents)
}

// LSP uri（file:///abs/path）→ 绝对路径
function uriToPath(uri) {
  if (typeof uri !== 'string') return ''
  if (!uri.startsWith('file://')) return uri
  try { return fileURLToPath(uri) } catch { return decodeURIComponent(uri.replace(/^file:\/\//, '')) }
}

// 显示路径：能相对 cwd 就用相对（短，且和 Read 的入参风格一致）
function displayPath(absPath, cwd) {
  if (!absPath) return ''
  if (cwd && isAbsolute(absPath)) {
    const rel = relative(cwd, absPath)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  }
  return absPath
}

// 读文件某一行内容，失败返回空串（文件被删/越界不该让整个工具失败）
function safeReadLine(absPath, lineNo) {
  try {
    const lines = readFileSync(absPath, 'utf8').split('\n')
    return (lines[lineNo] ?? '').trim()
  } catch { return '' }
}

// 单条 location → `路径:行:列` + 该行内容（CCM 提示词要求引用代码用 file_path:line_number）
function formatLocation(loc, cwd) {
  if (!loc) return ''
  const abs = uriToPath(loc.uri)
  const line = (loc.range?.start?.line ?? 0) + 1
  const char = (loc.range?.start?.character ?? 0) + 1
  const p = displayPath(abs, cwd)
  const text = safeReadLine(abs, line - 1)
  return text ? `${p}:${line}:${char}  ${text}` : `${p}:${line}:${char}`
}

// LocationLink（targetUri 形式）→ 普通 location
function normalizeLocation(loc) {
  if (!loc || typeof loc !== 'object') return null
  if (typeof loc.targetUri === 'string') {
    return { uri: loc.targetUri, range: loc.targetSelectionRange || loc.targetRange || loc.range }
  }
  if (typeof loc.uri !== 'string') return null
  return loc
}

function toLocationArray(result) {
  if (!result) return []
  const arr = Array.isArray(result) ? result : [result]
  return arr.map(normalizeLocation).filter(l => l && l.uri)
}

// LSP CompletionItemKind 是另一套枚举（与 SymbolKind 差 1），别混用 ——
// 混用的表现是 completion 的 kind 全错位（Method 其实是 Text）。
const COMPLETION_KINDS = {
  1: 'Text', 2: 'Method', 3: 'Function', 4: 'Constructor', 5: 'Field',
  6: 'Variable', 7: 'Class', 8: 'Interface', 9: 'Module', 10: 'Property',
  11: 'Unit', 12: 'Value', 13: 'Enum', 14: 'Keyword', 15: 'Snippet',
  16: 'Color', 17: 'File', 18: 'Reference', 19: 'Folder', 20: 'EnumMember',
  21: 'Constant', 22: 'Struct', 23: 'Event', 24: 'Operator', 25: 'TypeParameter',
}

// documentSymbol 结果按文件分组（多位置时读起来更清楚）
function groupByFile(locs, cwd) {
  const map = new Map()
  for (const loc of locs) {
    const abs = uriToPath(loc.uri)
    const key = displayPath(abs, cwd)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(loc)
  }
  return map
}

function formatSymbolList(symbols, cwd) {
  const lines = []
  const walk = (list, depth) => {
    for (const s of list) {
      if (!s || typeof s.name !== 'string') continue
      const kind = SYMBOL_KINDS[s.kind] || 'Unknown'
      const indent = '  '.repeat(depth)
      const loc = normalizeLocation(s.location) || (s.range ? { uri: s.uri, range: s.range } : null)
      const line = loc?.range?.start?.line
      let text = `${indent}${s.name} (${kind})`
      if (s.detail) text += ` ${s.detail}`
      if (line !== undefined) {
        const p = loc ? displayPath(uriToPath(loc.uri), cwd) : ''
        text += p ? ` - ${p}:${line + 1}` : ` - 行 ${line + 1}`
      }
      lines.push(text)
      if (Array.isArray(s.children) && s.children.length > 0) walk(s.children, depth + 1)
    }
  }
  walk(symbols, 0)
  return lines
}

// 官方 operations 里没有 completion，CCM 的 LspClient 有 —— 保留但不写进
// 官方那份 description 措辞，避免和官方语义漂移
const OPERATIONS = [
  'definition', 'references', 'hover', 'documentSymbol',
  'workspaceSymbol', 'implementation', 'completion',
]

export class LspTool extends Tool {
  constructor() {
    super({
      name: 'LSP',
      description: [
        'Interact with Language Server Protocol (LSP) servers to get code intelligence features.',
        '',
        'Supported operations:',
        '- definition: Find where a symbol is defined',
        '- references: Find all references to a symbol',
        '- hover: Get hover information (documentation, type info) for a symbol',
        '- documentSymbol: Get all symbols (functions, classes, variables) in a document',
        '- workspaceSymbol: Search for symbols matching a query across the workspace',
        '- implementation: Find implementations of an interface or abstract method',
        '- completion: Get completion items at a position',
        '',
        'All operations require:',
        '- filePath: The file to operate on',
        '- line: The line number (1-based, as shown in editors)',
        '- character: The character offset (1-based, as shown in editors)',
        '',
        'The workspaceSymbol operation also takes:',
        '- query: The symbol name or partial name to search for. Always provide it.',
        '',
        'Note: LSP servers must be configured for the file type (.js/.ts/.mjs/.py).',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: OPERATIONS,
            description: 'The LSP operation to perform',
          },
          filePath: {
            type: 'string',
            description: 'The absolute or relative path to the file',
          },
          line: {
            type: 'integer',
            description: 'The line number (1-based, as shown in editors)',
          },
          character: {
            type: 'integer',
            description: 'The character offset (1-based, as shown in editors)',
          },
          query: {
            type: 'string',
            description: 'The symbol name or partial name to search for (workspaceSymbol only)',
          },
        },
        required: ['operation', 'filePath'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => false,  // LSP 内部有状态，避免并发
      maxResultSizeChars: 30000,
      userFacingName: 'LSP',
      validateInput: (input) => {
        const errors = []
        if (!OPERATIONS.includes(input.operation)) {
          errors.push(`operation 必须是: ${OPERATIONS.join(' / ')}`)
        }
        if (!input.filePath) errors.push('filePath is required')
        // documentSymbol / workspaceSymbol 不按位置取结果
        const needsPosition = input.operation !== 'documentSymbol' && input.operation !== 'workspaceSymbol'
        if (needsPosition && (typeof input.line !== 'number' || typeof input.character !== 'number')) {
          errors.push(`${input.operation} 需要 line 和 character（1-based）`)
        }
        if (input.operation === 'workspaceSymbol' && !input.query) {
          errors.push('workspaceSymbol 需要 query')
        }
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input, ctx = {}) {
    const cwd = ctx.cwd || process.cwd()
    const abs = resolve(cwd, input.filePath)
    if (!existsSync(abs)) return `文件不存在: ${abs}`

    const result = await lspManager.run(abs, input.operation, {
      line: input.line,
      character: input.character,
      query: input.query,
      includeDeclaration: input.includeDeclaration,
    }, cwd)

    if (result && result.error && !result.items) {
      return `LSP 失败 (${input.operation}): ${result.error}`
    }

    switch (input.operation) {
      case 'definition':
      case 'references':
      case 'implementation': {
        const locs = toLocationArray(result)
        if (locs.length === 0) {
          return `没有找到 ${input.operation} 结果。可能是光标不在符号上，或该符号在未被索引的外部库里。`
        }
        const label = { definition: '定义', references: '引用', implementation: '实现' }[input.operation]
        if (locs.length === 1) {
          return `找到 1 个${label}:\n  ${formatLocation(locs[0], cwd)}`
        }
        const groups = groupByFile(locs, cwd)
        const head = [`找到 ${locs.length} 个${label}，分布在 ${groups.size} 个文件:`]
        for (const [file, fileLocs] of groups) {
          head.push(`${file}:`)
          for (const loc of fileLocs) head.push(`  ${formatLocation(loc, cwd).replace(/^[^:]*:/, '')}`)
        }
        return head.join('\n')
      }

      case 'hover': {
        const text = flattenHoverContents(result?.contents)
        if (!text) return '该位置没有 hover 信息。'
        const start = result.range?.start
        const at = start ? `${start.line + 1}:${start.character + 1} ` : ''
        return `${at}的 hover 信息:\n\n${text}`
      }

      case 'documentSymbol': {
        const symbols = Array.isArray(result) ? result : []
        if (symbols.length === 0) {
          return `文档中没有符号，或该文件类型不受 LSP 支持。`
        }
        return [`${displayPath(abs, cwd)} 的符号:`].concat(formatSymbolList(symbols, cwd)).join('\n')
      }

      case 'workspaceSymbol': {
        const symbols = Array.isArray(result) ? result : []
        const valid = symbols.filter(s => s && s.location && s.location.uri)
        if (valid.length === 0) {
          return `工作区中没有匹配 "${input.query}" 的符号。`
        }
        const head = [`工作区中找到 ${valid.length} 个匹配 "${input.query}" 的符号:`]
        // 直接列表，每行自带完整「路径:行号」—— 模型可直接引用、用户可直接跳。
        // 不再按文件分组：分组标题已经写过路径，行里再写就重复了。
        for (const s of valid) {
          const p = displayPath(uriToPath(s.location.uri), cwd)
          const kind = SYMBOL_KINDS[s.kind] || 'Unknown'
          const line = s.location.range?.start?.line ?? 0
          let text = `  ${s.name} (${kind}) - ${p}:${line + 1}`
          if (s.containerName) text += ` in ${s.containerName}`
          head.push(text)
        }
        return head.join('\n')
      }

      case 'completion': {
        const items = Array.isArray(result?.items) ? result.items : (Array.isArray(result) ? result : [])
        if (items.length === 0) return '该位置没有补全项。'
        const lines = items.slice(0, 50).map(it => {
          const kind = COMPLETION_KINDS[it.kind] || 'Unknown'
          return `  ${it.label} (${kind})${it.detail ? ` ${it.detail}` : ''}`
        })
        return [`找到 ${items.length} 个补全项${items.length > 50 ? '（只显示前 50）' : ''}:`].concat(lines).join('\n')
      }

      default:
        return `未知操作: ${input.operation}`
    }
  }
}
