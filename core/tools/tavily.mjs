// Claude Code Mobile - Tavily 搜索工具
import { Tool } from './tools.mjs'
import { readFileSync } from 'node:fs'
import { loadEnvFile, resolveEnvString } from '../api/env-secrets.mjs'
import { resolveConfigPath } from '../infra/paths.mjs'

// 搜索 key 不硬编码：从环境变量 TAVILY_API_KEY 或 config.json 的 tavilyKey 字段读取。
// 开源时 config.json 里写 ${TAVILY_API_KEY} 占位符，.env 里放真实 key。
const TAVILY_URL = 'https://api.tavily.com/search'

let cachedKey = null

export function getTavilyKey() {
  if (cachedKey) return cachedKey
  loadEnvFile(process.cwd())
  // 优先级：环境变量 > .env > config.json 的 tavilyKey（支持 ${VAR} 占位符）
  const fromEnv = process.env.TAVILY_API_KEY || process.env.TAVILY_KEY
  if (fromEnv) { cachedKey = fromEnv; return cachedKey }
  try {
    // 【2026-10-03】配置在用户数据目录（Tavily key 存在这里）
    const cfg = JSON.parse(readFileSync(resolveConfigPath('config.json'), 'utf-8'))
    // 【2026-09-20 修】原来只读顶层的 tavilyKey / searchKey，
    // 但 Web 设置页写的是 **provider.tavilyApiKey**（每个 Provider 一个），
    // 两边对不上 —— 用户在设置页填了 key，WebSearch 照样报「key 未配置」，
    // 而且设置页回显也是空的（服务端从 provider.tavilyApiKey 取值，没人写过）。
    //
    // 用户原话：「搜索 API key 点了小眼睛也显示不出来」→ 实测根因就是这个错位。
    //
    // 现在按顺序找：顶层 tavilyKey > 当前 Provider 的 tavilyApiKey > 任一 Provider 的。
    // 保持顶层优先是为了兼容老配置（CLI 用户习惯在顶层写一个共用的）。
    const raw = cfg.tavilyKey || cfg.searchKey
      || cfg.providers?.[cfg.current]?.tavilyApiKey
      || Object.values(cfg.providers || {}).map(p => p?.tavilyApiKey).find(Boolean)
    if (raw) {
      const resolved = resolveEnvString(raw)
      if (resolved) { cachedKey = resolved; return cachedKey }
    }
  } catch { }
  cachedKey = ''
  return cachedKey
}

/**
 * 清空 key 缓存 —— 设置页保存新 key 后必须调，否则本进程内一直用旧的。
 * （cachedKey 是模块级，改了 config.json 不会自动失效。）
 */
export function resetTavilyKeyCache() { cachedKey = null }

// 兼容旧用法：无参时返回当前 key（打码显示用）
export function tavilyKey() { return getTavilyKey() }

export class TavilySearchTool extends Tool {
  constructor() {
    super({
      name: 'WebSearch',
      description: '联网搜索获取最新信息。输入搜索关键词，返回相关网页标题、URL和摘要。支持中英文搜索。',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          max_results: { type: 'number', description: '最大结果数，默认 5，最多 10' },
          search_depth: { type: 'string', enum: ['basic', 'advanced'], description: '搜索深度：basic 快速，advanced 深度（更慢但更全），默认 basic' },
          include_answer: { type: 'boolean', description: '是否包含 AI 生成的摘要答案，默认 true。注意：摘要经常把不相关的事实缝在一起，只能当线索，不要直接当答案' },
          include_domains: { type: 'array', items: { type: 'string' }, description: '只在这些域名内搜索（如 ["github.com","stackoverflow.com"]），查技术问题时很有效' },
          exclude_domains: { type: 'array', items: { type: 'string' }, description: '排除这些域名（如排除 CSDN 之类的低质量转载站）' },
          // ── 对齐官方 Claude Code 2.1.303 的 mode ──
          // 官方语义：standard = 快而省，extended = 全面且新鲜但贵几倍。
          // CCM 底层是 Tavily，没有「一次调用搜多轮」的概念，能对上的就是
          // search_depth（basic/advanced）。所以 mode 做成它的同义别名：
          //   mode=standard → search_depth=basic
          //   mode=extended → search_depth=advanced
          // 两者都给时 mode 优先（它更接近官方的措辞，跨端 prompt 会带它）。
          //
          // ⚠ 默认值与官方不同：官方默认 extended，CCM 默认 standard（basic）。
          // 原因：Tavily 的 advanced 实测慢 2~3 倍，而 CCM 的搜索调用里
          // 大多数是「查一下这个报错」这种一次就够的场景，默认拉满等于每次
          // 都多花钱多等。要更全就显式传 mode:'extended'。
          mode: {
            type: 'string',
            enum: ['standard', 'extended'],
            description: '搜索强度（官方同名字段）。standard=快而省（默认，等同 search_depth:basic）；extended=更全更新但慢 2~3 倍（等同 search_depth:advanced）。仅在 standard 结果太薄/跑偏/可能过时时才用 extended。',
          },
          // ── 官方字段名的别名 ──
          // 官方 WebSearch 叫 allowed_domains / blocked_domains，CCM 早期跟着
          // Tavily 叫 include_domains / exclude_domains。两套都收，避免
          // 「按官方写法传了却被静默忽略」——那种失败不报错，只是范围没生效。
          allowed_domains: { type: 'array', items: { type: 'string' }, description: '（官方同名字段，等价于 include_domains）只在这些域名内搜索' },
          blocked_domains: { type: 'array', items: { type: 'string' }, description: '（官方同名字段，等价于 exclude_domains）不包含这些域名的结果' },
          days: { type: 'number', description: '只要最近 N 天的内容（查时效性话题用，如版本更新、近期事件）' },
        },
        required: ['query'],
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 15000,
      validateInput: (input) => {
        const errors = []
        if (!input.query) errors.push('query is required')
        if (input.max_results && (input.max_results < 1 || input.max_results > 10)) errors.push('max_results must be 1-10')
        if (input.mode !== undefined && !['standard', 'extended'].includes(input.mode)) errors.push('mode 只能是 standard 或 extended')
        return { valid: errors.length === 0, errors }
      },
    })
  }

  async execute(input) {
    const apiKey = getTavilyKey()
    if (!apiKey) throw new Error('Tavily API key 未配置：请设置环境变量 TAVILY_API_KEY 或 config.json 的 tavilyKey 字段')
    // mode（官方字段）优先于 search_depth（Tavily 原生字段）：
    // 跨端 prompt 里带的是 mode，它代表调用方的真实意图，不该被另一个别名覆盖。
    const depth = input.mode === 'extended'
      ? 'advanced'
      : input.mode === 'standard'
        ? 'basic'
        : (input.search_depth === 'advanced' ? 'advanced' : 'basic')
    const body = {
      api_key: apiKey,
      query: input.query,
      max_results: Math.min(10, Math.max(1, input.max_results || 5)),
      search_depth: depth,
      include_answer: input.include_answer !== false,
      include_raw_content: false,
      // chunks_per_source：每个来源取几段内容。实测（2026-09-04 对照实验）
      // 结果列表与默认**完全一致**，但耗时从 1675ms 降到 790ms（快一倍以上）。
      // 纯赚，所以固定开启。
      chunks_per_source: 3,
    }
    // 域名定向/排除：查技术问题时把范围收进 github/stackoverflow/官方文档
    // 比调任何「深度」参数都有效（Tavily 的强项就是英文技术内容）。
    // 官方字段名（allowed_/blocked_domains）与 Tavily 原生名（include_/exclude_domains）
    // 都收，合并成一个列表 —— 调用方按哪套写都该生效。
    const includeDomains = [
      ...(Array.isArray(input.include_domains) ? input.include_domains : []),
      ...(Array.isArray(input.allowed_domains) ? input.allowed_domains : []),
    ].filter(d => typeof d === 'string' && d.trim())
    const excludeDomains = [
      ...(Array.isArray(input.exclude_domains) ? input.exclude_domains : []),
      ...(Array.isArray(input.blocked_domains) ? input.blocked_domains : []),
    ].filter(d => typeof d === 'string' && d.trim())
    if (includeDomains.length) body.include_domains = includeDomains.slice(0, 20)
    if (excludeDomains.length) body.exclude_domains = excludeDomains.slice(0, 20)
    if (Number.isFinite(input.days) && input.days > 0) body.days = Math.min(365, Math.floor(input.days))
    //
    // 【实测确认帮倒忙的参数，别加回来】2026-09-04 对照实验（core/tavily.mjs 同目录无测试，
    // 实验脚本在 /sdcard/Download/claude-workspace/tavily-raw.mjs）：
    //   · topic:'news'          → 灾难。查「金爱梅 新平中学 物理老师」返回 6 条
    //                             金大中/李姬镐的英文诺奖新闻（跨语言实体链接跑偏）。
    //   · exact_match:true      → HTTP 400，当前 API 不支持。
    //   · filter_by_language    → 英文查询直接变 0 条（把目标语言全过滤掉了）。
    //   · language:'zh'         → 中文查询结果反而变差且慢 3.6s，无收益。
    //   · country:'china'       → 结果无变化。
    //   · auto_parameters       → 结果无变化，耗时翻倍。
    // 结论：除了 chunks_per_source 和域名过滤，其余参数在本项目场景下都不值得加。
    const resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`Tavily API error ${resp.status}: ${err.slice(0, 200)}`)
    }
    const data = await resp.json()
    const results = data.results || []
    let output = ''
    if (data.answer) output += `**AI 摘要（仅供参考，可能拼接不相关事实）:** ${data.answer}\n\n`

    // 【相关性自检】Tavily 的 score 只是向量距离，跟「答对了没有」无关：
    // 实测最高分 0.264 那条是完全不相关的页面。真正能判断的是
    // 「查询里的实体词有没有真的出现在结果里」。
    // 冷门中文实体（人名/校名/地方机构）常常一条都没命中 —— 这时必须明确告警，
    // 否则调用方会拿一堆无关结果当答案（2026-09-04 真实踩过：搜某老师
    // 返回的全是外地学校名单和英文招聘，AI 摘要还据此编了事迹）。
    // 判据不能用「任一关键词命中」：实测查「金爱梅 新平中学 物理老师」时，
    // 有两条结果因为含「物理老师」这个通用词被算作命中（实际是英文招聘岗位和
    // 广东某支教老师），警告因此不触发 —— 通用词命中毫无意义。
    // 改为只看**区分度最高的词**：去掉常见通用后缀词，优先取最长的那个
    // （人名/校名/专有名词通常就是它），只要它一条都没命中就警告。
    // 用后缀匹配而不是全词匹配：`物理老师`、`语文教师`、`初级中学` 这类复合词
    // 同样是通用描述，靠它命中毫无意义。（只全词匹配 `老师` 时，`物理老师`
    // 会漏网并因为够长挤进探针词，警告就永远不触发 —— 实测踩过。）
    const GENERIC = /(老师|教师|学校|中学|小学|大学|问题|方法|怎么|如何|是什么|介绍|资料|新闻|视频|图片|下载|官网|多少|哪个|为什么)$/
    const keywords = String(input.query).split(/[\s,，、]+/).filter(w => w.length >= 2)
    const distinctive = keywords
      .filter(w => !GENERIC.test(w))
      .sort((a, b) => b.length - a.length)
      .slice(0, 2)   // 最长的一两个词作为「必须出现」的实体
    const probe = distinctive.length ? distinctive : keywords
    const hitCount = results.filter(r => {
      const body = `${r.title || ''}${r.content || ''}`
      return probe.some(w => body.includes(w))
    }).length

    output += '**搜索结果:**\n'
    for (const r of results) {
      output += `### ${r.title}\n${r.url}\n${r.content || '(无内容)'}\n\n`
    }
    if (results.length > 0 && probe.length > 0 && hitCount === 0) {
      output += `\n**⚠ 相关性警告**：${results.length} 条结果中没有任何一条包含关键实体（${probe.join(' ')}）。\n` +
        'Tavily 对冷门中文实体（人名、校名、地方机构）覆盖很差，这批结果很可能全部无关，不要基于它下结论。\n'
    }
    return output || '(无结果)'
  }
}
