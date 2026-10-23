// Claude Code Mobile - 导出对话
//
// 官方 /export 是交互式选择（"Copy to clipboard" / "Save to file"，
// 见 split/out/src/chunk-5b1h5pgx.js），CCM 在终端里改成参数式：
//   /export [文件]              写文件，按扩展名选 md/html/json
//   /export --clipboard [格式]   复制到剪贴板，不落盘
import { writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { termuxTools } from '../phone/termux-tools.mjs'

/**
 * argv 通道的安全上限。
 *
 * ClipboardSetTool 走 execFileSync 的 argv 传参，Linux 单参数上限是 128KB
 *（MAX_ARG_STRLEN）。实测 130000 字节能过、200000 直接 E2BIG。
 * 取 100000 留余量：超过就走 stdin 通道（同一二进制，termux-api 支持空参数读 stdin）。
 */
const CLIPBOARD_ARGV_LIMIT = 100000

/** 复用 ClipboardSet 工具实例（不重复实现路径探测与错误包装） */
function getClipboardTool() {
  try {
    return (termuxTools || []).find(t => t?.name === 'ClipboardSet') || null
  } catch {
    return null
  }
}

/** stdin 兜底通道用的二进制路径（与 termux-tools 的 findTermuxBin 同一套候选） */
function findClipboardBin() {
  const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr'
  const candidates = [
    `${prefix}/bin/termux-clipboard-set`,
    '/data/data/com.termux/files/usr/bin/termux-clipboard-set',
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch {}
  }
  return null
}

export class Exporter {
  static toMarkdown(messages) {
    const lines = ['# 对话记录\n']
    for (const msg of messages) {
      const role = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 AI' : '🔧 工具'
      lines.push(`## ${role}\n`)
      if (typeof msg.content === 'string') lines.push(msg.content)
      else if (Array.isArray(msg.content)) for (const b of msg.content) {
        if (b.type === 'text') lines.push(b.text)
        else if (b.type === 'tool_use') lines.push(`**调用工具**: \`${b.name}\`\n\`\`\`json\n${JSON.stringify(b.input,null,2)}\n\`\`\``)
        else if (b.type === 'tool_result') { const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content); lines.push(`**结果**:\n\`\`\`\n${c.slice(0,2000)}\n\`\`\``) }
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  /** 从文件扩展名推格式（文件导出用） */
  static formatFromPath(filePath) {
    const p = String(filePath || '').toLowerCase()
    if (p.endsWith('.html') || p.endsWith('.htm')) return 'html'
    if (p.endsWith('.json')) return 'json'
    return 'md'
  }

  /**
   * 生成导出文本，不落盘。
   *
   * 文件和剪贴板共用这一个出口 —— 否则两条路径的格式会漂移
   *（比如剪贴板忘了转 html，用户复制到的和文件里的是两种东西）。
   */
  static toText(messages, format = 'md') {
    const f = String(format || 'md').toLowerCase()
    if (f === 'html' || f === 'htm') return Exporter.toHtml(messages)
    if (f === 'json') return JSON.stringify(messages, null, 2)
    return Exporter.toMarkdown(messages)
  }

  static save(messages, filePath) {
    writeFileSync(filePath, Exporter.toText(messages, Exporter.formatFromPath(filePath)), 'utf-8')
    return filePath
  }

  /**
   * 把文本写进系统剪贴板。
   *
   * 常规路径复用 ClipboardSetTool（argv 传参、不走 shell，天然免命令注入）；
   * 超长文本走 stdin —— 否则长对话会撞 128KB 单参数上限，E2BIG 直接失败。
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{chars:number, via:'tool'|'stdin'}>}
   * @throws 剪贴板不可用 / 写入失败时抛错，绝不静默失败
   */
  static async copyToClipboard(text, { timeoutMs = 10000 } = {}) {
    const s = String(text ?? '')
    if (!s) throw new Error('没有可复制的内容（对话为空）')

    const tool = getClipboardTool()
    if (tool && s.length <= CLIPBOARD_ARGV_LIMIT) {
      try {
        await tool.execute({ text: s })
      } catch (e) {
        // termuxExec 已经给出「需要装 termux-api / 不在 Termux 环境」的明确提示，原样透传
        throw new Error(e?.message || String(e))
      }
      return { chars: s.length, via: 'tool' }
    }

    const bin = findClipboardBin()
    if (!bin) {
      throw new Error(
        '剪贴板不可用：找不到 termux-clipboard-set\n' +
        '  · 需要安装 termux-api（pkg install termux-api）\n' +
        '  · 不在 Termux 环境（如 proot 容器）时不可用'
      )
    }
    try {
      execFileSync(bin, [], { input: s, encoding: 'utf-8', timeout: timeoutMs })
    } catch (e) {
      throw new Error(`写入剪贴板失败: ${e?.message || String(e)}`)
    }
    return { chars: s.length, via: 'stdin' }
  }

  static toHtml(messages, title='Claude Code 对话') {
    const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
    const lines = [`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:20px auto;padding:0 20px}.msg{margin:16px 0;padding:12px 16px;border-radius:8px}.user{background:#e3f2fd}.assistant{background:#f3e5f5}.tool{background:#fff3e0;font-family:monospace;font-size:13px}pre{background:#263238;color:#aed581;padding:8px;border-radius:4px;overflow-x:auto}</style></head><body><h1>${esc(title)}</h1>`]
    for (const msg of messages) {
      const cls = msg.role==='user'?'user':msg.role==='assistant'?'assistant':'tool'
      const role = msg.role==='user'?'👤 用户':msg.role==='assistant'?'🤖 AI':'🔧 工具'
      lines.push(`<div class="msg ${cls}"><strong>${role}</strong><br>`)
      if (typeof msg.content === 'string') lines.push(`<pre>${esc(msg.content)}</pre>`)
      else if (Array.isArray(msg.content)) for (const b of msg.content) {
        if (b.type === 'text') lines.push(`<pre>${esc(b.text)}</pre>`)
        else if (b.type === 'tool_use') lines.push(`<p><b>${esc(b.name)}</b></p>`)
        else if (b.type === 'tool_result') lines.push(`<pre>${esc(typeof b.content==='string'?b.content:JSON.stringify(b.content))}</pre>`)
      }
      lines.push('</div>')
    }
    lines.push('</body></html>'); return lines.join('\n')
  }
}
