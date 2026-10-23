/**
 * ToolSearch —— 延迟加载工具的检索层（对齐官方 ToolSearch）。
 *
 * 【解决什么问题】CCM 有 111 个工具，schema 全量每轮发给 API 是最大的单项上下文开销。
 * 低频工具标 `shouldDefer` 后只输出占位（name + 一句话），本工具负责把完整 schema
 * 交回模型。
 *
 * 【注入方式为什么选「工具结果 + 实例标志位」，而不是 steering / system 消息】
 * 审计给了两个候选，都在 agent.mjs（本次独占范围外）。实际上有第三条路，而且更好：
 *   · agent.mjs 两处发请求都是 `this.tools.map(t => t.toSchema())`，this.tools 持有
 *     **同一批 Tool 实例引用**；
 *   · toSchema() 内部按 `this._deferOverride` 决定输出占位还是完整 schema；
 *   · 所以本工具只要把目标实例 `undefer()`，**下一轮请求自动带上完整 schema**，
 *     零 agent.mjs 改动、也无需往历史里塞 system 消息。
 * 相比 steering/system 注入的优点：不污染 messages 历史（那两条每轮都要重发，
 * 而且历史里会残留「该工具已可用」的过期状态）；模型本轮看到的完整 schema 来自
 * 工具结果（自包含、可回读），下一轮的 tools 字段自动跟上。
 *
 * 【幂等与边界】undefer 不可逆（工具一旦解除就一直是完整态）——这是有意的：
 * 同一会话里反复检索同一个工具只会浪费字符，不会造成正确性问题。
 */
import { Tool } from './tools.mjs'

export class ToolSearchTool extends Tool {
  constructor({ getRegistry }) {
    super({
      name: 'ToolSearch',
      description: '检索并加载延迟加载的工具。部分低频工具默认只给出名称和一句话说明（标「延迟加载」），'
        + '完整参数说明需要用本工具取回。'
        + '两种用法：给 query 按关键词模糊匹配（如 "github" / "phone" / "image"）；'
        + '给 select 按精确工具名加载（如 ["GitHubIssues", "ImageGen"]）。'
        + '加载后本轮回传完整参数说明，下一轮即可正常调用。',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '关键词，大小写不敏感，匹配工具名和一句话说明。如 "github"、"phone"、"image"、"team"。'
          },
          select: {
            type: 'array',
            items: { type: 'string' },
            description: '精确工具名列表。已知工具名时用这个，比 query 更准。例：["GitHubIssues", "ImageGen"]'
          },
          detail: {
            type: 'string',
            enum: ['full', 'names'],
            description: 'full=回传完整 schema（默认，可直接照着调用）；names=只列命中的工具名（省字符，用于先看有哪些）'
          },
        },
      },
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true,
      searchHint: 'load full schema of a deferred tool by keyword or exact name',
    })
    this.getRegistry = getRegistry
  }

  async execute(input) {
    const reg = this.getRegistry?.()
    if (!reg || typeof reg.undefer !== 'function') return '错误：registry 不可用（ToolSearch 未正确接线）'

    const hasSelect = Array.isArray(input.select) && input.select.length > 0
    const query = String(input.query || '').trim()
    if (!hasSelect && !query) {
      return '错误：必须给 query（关键词）或 select（精确工具名列表）之一。'
    }

    const detail = input.detail === 'names' ? 'names' : 'full'

    if (!hasSelect && query && detail === 'names') {
      return this._renderNames(reg.searchDeferred(query), query)
    }

    const targets = hasSelect ? input.select.map(String) : []
    const lines = []
    const loaded = []

    if (hasSelect) {
      for (const name of targets) {
        const res = reg.undefer(name)
        if (res.ok) {
          loaded.push(name)
          lines.push(this._renderOne(reg.get(name), detail))
        } else if (res.already) {
          // 本来就没延迟：直接给完整 schema，别让模型以为失败了
          lines.push(this._renderOne(reg.get(name), detail))
        } else {
          lines.push(`未找到工具：${res.error}`)
        }
      }
    } else {
      const hits = reg.searchDeferred(query)
      if (hits.length === 0) return this._renderMiss(query, reg)
      for (const t of hits) {
        reg.undefer(t.name)
        loaded.push(t.name)
        lines.push(this._renderOne(t, detail))
      }
    }

    const head = loaded.length > 0
      ? `已加载 ${loaded.length} 个工具的完整参数说明（下一轮即可调用）：${loaded.join('、')}`
      : '本次没有新加载的工具'
    const note = detail === 'names'
      ? '\n（detail=names 只列了名字；需要参数说明请改用 detail=full 或不传 detail）'
      : '\n请按上面的参数说明在本轮之后调用这些工具。'
    return head + '\n\n' + lines.join('\n\n') + note
  }

  _renderNames(hits, query) {
    if (hits.length === 0) return this._renderMiss(query, this.getRegistry?.())
    const names = hits.map(t => t.name)
    return `关键词 "${query}" 命中 ${hits.length} 个延迟工具：${names.join('、')}\n`
      + '需要参数说明请改用 detail=full 或不传 detail。'
  }

  _renderOne(tool, detail) {
    if (!tool) return '未找到工具'
    if (detail === 'names') return tool.name
    const s = tool.toSchema()
    // 走 toSchema() 而不是直接拼 input_schema —— undefer() 已经翻转标志位，
    // 这里拿到的就是完整 schema；万一没翻转，占位也会如实反映，不会骗模型。
    return `### ${s.name}\n${JSON.stringify({ description: s.description, input_schema: s.input_schema }, null, 1)}`
  }

  _renderMiss(query, reg) {
    let out = `关键词 "${query}" 没有命中任何延迟加载的工具。`
    const deferred = reg?.listDeferred?.() || []
    if (deferred.length > 0) {
      out += `\n当前仍延迟的工具共 ${deferred.length} 个，名称如下（可用 select 精确加载）：\n`
      out += deferred.map(t => t.name).join('、')
    } else {
      out += '\n当前没有处于延迟状态的工具 —— 说明目标工具要么本来就可直接用（未标延迟），'
      out += '要么不存在。可用 select 试精确名。'
    }
    return out
  }
}
