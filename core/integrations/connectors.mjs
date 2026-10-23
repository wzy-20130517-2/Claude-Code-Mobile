// 连接器（Connector）统一注册表 —— 「需要配置才能用的外部服务接入点」
//
// 【为什么要做这一层】
// 2026-10-20 排查发现「每加一个连接器要改三处」：
//   1. Web 前端 web/src/components/customize/connectorCatalog.ts 加一条静态目录
//   2. Web 服务端 web/server.mjs 的 /api/connectors/status 加一段 if/else 手写探针
//   3. CLI 端各命令自己实现状态查询（/github 在 index.mjs 的 switch、/qq 在 cmd-qq.mjs）
// 三处各写一份「怎么判断这个连接器能不能用」，必然漂移 —— 而且**已经漂移了**：
// /api/connectors/status 判断 QQ 是否连接用的是 `qq.qqActive` 字段，
// 但 2026-09-24 之后 QQ 配置的真实字段是 `endpoints.<端>.enabled`，
// qqActive 只是给旧版本留的**只读镜像**，没有任何代码再写它。
// 结果：在 Web/CCM 里敲 /qq on 之后，连接器页面永远显示「未连接」。
//
// 所以把「连接器是什么、怎么探状态」收成一份注册表，两端都从这里读。
//
// 【不做的事（刻意的）】
//   · 不做「连接器市场」/ 远程注册表 / 关键词搜索 —— 官方那套 SearchMcpRegistry /
//     SuggestConnectors 依赖 claude.ai 账号体系（org UUID + OAuth），
//     CCM 是自部署单机，没有「目录服务」这个概念，照抄只会得到一堆点不动的按钮。
//     这也是 2026-09-19 把前端目录从 28 个砍到 2 个的同一个理由。
//   · 不做「一键安装」—— 每个连接器的凭据获取路径都不一样（GitHub PAT / QQ 授权码 /
//     MCP server 命令行），统一按钮只能统一成「去终端敲命令」。
//   · 不主动发网络请求探活 —— /connectors 要能离线、秒回。真实连通性验证留在
//     各自的 /github test 这类命令里（它们会真的打 API）。
//
// 【连接器的判定标准】
// 一个东西算连接器，需要同时满足：
//   1. 有独立的凭据/配置（github.json / qq-config.json / mcp.json / mail-accounts.json）
//   2. 配置后向 Agent 暴露一组工具
//   3. 有自己的 slash 命令做配置入口
// 按这个标准，GitHub / QQ / MCP / 邮箱 是；Pexels / Tavily 不是 ——
// 它们是某个工具（FindImage / WebSearch）的内部依赖，不是「接入的外部服务」。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MCP_PATH } from '../infra/paths.mjs'
import { githubStatus } from './github.mjs'
import { loadQqConfig, detectEndpoint, listEndpoints, QQ_CONFIG_PATH } from './qq-config.mjs'

const DATA_DIR = join(homedir(), '.claude-code-mobile')
const MAIL_ACCOUNTS_PATH = join(DATA_DIR, 'mail-accounts.json')

// ── 各连接器的探针 ──────────────────────────────────────
//
// 统一返回结构（多出来的字段按连接器各自需要给，调用方可以忽略）：
//   connected  配置层面「可用」吗 —— 这是唯一必须的字段
//   detail     给人看的一句话状态（Web 端直接显示它）
//   running    进程层面「真的在跑」吗（有活对象才准，没有时给 null 而不是猜）
//   error      探针本身失败（配置文件坏了之类），与「未配置」区分开
//
// 【connected 与 running 为什么分开】
// 「配了 token」和「服务真的在监听」是两件事。QQ 桥最容易出现「开关开着但进程没起来」
// （端口被另一个端占用、NapCat 没启动）。把两者混成一个布尔值，排查时就没有抓手了。

function probeGithub() {
  try {
    const st = githubStatus()
    if (!st.configured) {
      return { connected: false, detail: '未配置 token · 终端执行 /github login' }
    }
    return {
      connected: true,
      detail: `${st.defaultRepo ? `仓库 ${st.defaultRepo}` : '已配置 token'} · ${st.masked}`,
      defaultRepo: st.defaultRepo || null,
      tokenFrom: st.tokenFrom || 'none',
      masked: st.masked || '',
    }
  } catch (e) {
    return { connected: false, detail: `状态读取失败: ${e?.message || e}`, error: e?.message || String(e) }
  }
}

function probeQq() {
  try {
    const endpoint = detectEndpoint()
    // 【为什么先自己解析一次】loadQqConfig 内部的 readRaw() 用 try/catch 吞掉了解析错误
    // 并返回 {} —— 对命令层是合理的降级（不能让 /qq 因为一个坏 JSON 就崩），
    // 但对「状态查询」是错的：配置文件坏了会表现成「未开启」，
    // 用户于是去重新配一遍，而真正的病因是文件语法错误。
    // 所以这里独立验一次语法，坏了就如实报 error，与「没配过」区分开。
    let parseError = null
    if (existsSync(QQ_CONFIG_PATH)) {
      try { JSON.parse(readFileSync(QQ_CONFIG_PATH, 'utf-8')) }
      catch (e) { parseError = e?.message || String(e) }
    }
    const cfg = loadQqConfig(endpoint)
    const others = listEndpoints().filter((e) => e.name !== endpoint && e.enabled)
    const otherNote = others.length ? `（${others.map((e) => e.name).join('/')} 端正在监听，端口共用）` : ''
    if (parseError) {
      return {
        connected: false,
        detail: `qq-config.json 解析失败，请修好后重启: ${parseError}`,
        error: parseError,
        endpoint,
      }
    }
    return {
      connected: cfg.enabled,
      detail: cfg.enabled
        ? `监听中（${endpoint} 端）· 主人号 ${cfg.owner || '未设'} · API ${cfg.napcatApi}`
        : `未开启 · 主人号 ${cfg.owner || '未设'}${otherNote}`,
      owner: cfg.owner || null,
      endpoint,
      port: cfg.port,
      otherEndpoints: others.map((e) => e.name),
    }
  } catch (e) {
    return { connected: false, detail: `状态读取失败: ${e?.message || e}`, error: e?.message || String(e) }
  }
}

function probeMcp(opts = {}) {
  let cfg = { mcpServers: {} }
  // 【区分「没配」和「配坏了」】和 QQ 探针同一个理由：mcp.json 语法错误时
  // 如果静默当成「未配置」，用户会去新建一份，而真正的病因是少了个逗号。
  if (existsSync(MCP_PATH)) {
    try {
      cfg = JSON.parse(readFileSync(MCP_PATH, 'utf-8')) || { mcpServers: {} }
    } catch (e) {
      return { connected: false, detail: `mcp.json 解析失败: ${e?.message || e}`, error: e?.message || String(e), servers: [] }
    }
  }
  const all = Object.entries(cfg.mcpServers || {})
  if (all.length === 0) {
    return { connected: false, detail: '未配置服务器 · 在 mcp.json 里加 mcpServers', servers: [] }
  }
  const enabled = all.filter(([, s]) => s?.disabled !== true)
  // mcpClient 是活对象（servers 是 Map，会被 /mcp disable 增删）。
  // 没传就只报配置层状态，running 给 null —— 不能假装「没在跑」。
  const client = opts.mcpClient
  const running = client?.servers?.get
    ? enabled.filter(([n]) => client.servers.get(n)).length
    : null
  const servers = all.map(([name, srv]) => {
    const disabled = srv?.disabled === true
    const live = client?.servers?.get?.(name) || null
    return {
      name,
      disabled,
      // 三态：配置里禁用 / 配了但没连上 / 正常运行（与 /mcp 命令的展示口径一致）
      state: disabled ? 'disabled' : live ? 'running' : (client ? 'disconnected' : 'unknown'),
      toolCount: live?.tools?.length ?? null,
    }
  })
  const usable = enabled.length > 0
  return {
    connected: usable,
    detail: usable
      ? `${all.length} 个配置 · ${running === null ? '运行状态未知（未接入 MCP 客户端）' : `${running} 个运行中`}`
      : `${all.length} 个配置但全部已禁用`,
    servers,
    running,
    configuredCount: all.length,
    enabledCount: enabled.length,
  }
}

function probeMail() {
  let raw = null
  try {
    if (existsSync(MAIL_ACCOUNTS_PATH)) raw = JSON.parse(readFileSync(MAIL_ACCOUNTS_PATH, 'utf-8'))
  } catch (e) {
    return { connected: false, detail: `账号表解析失败: ${e?.message || e}`, error: e?.message || String(e) }
  }
  const accounts = Object.entries(raw?.accounts || {})
  if (accounts.length === 0) {
    return { connected: false, detail: '未配置邮箱 · 终端执行 /mail add', accounts: [] }
  }
  const def = raw?.default || null
  // 只回别名和域名，不回授权码 —— 这个结构会被 Web API 直接吐给浏览器，
  // 打码不是「防用户」而是「别让凭据顺手流进日志/剪贴板/截图」。
  return {
    connected: true,
    detail: `${accounts.length} 个账号${def ? ` · 默认 ${def}` : ''}`,
    defaultAccount: def,
    accounts: accounts.map(([alias, a]) => ({
      alias,
      isDefault: alias === def,
      host: a?.host || '',
      domain: String(a?.user || '').includes('@') ? String(a.user).split('@')[1] : '',
    })),
  }
}

// ── 注册表 ─────────────────────────────────────────────
//
// 顺序即展示顺序：GitHub（开发）→ QQ（通讯）→ MCP（扩展）→ 邮箱（通讯）。
// id 同时是「连接器标识」和「反查键」，改动会破坏 Web 前端的 statusSource 映射，
// 加新连接器时**只往这里加**，不要去改前端 catalog（它现在只有 github/qq 两条，
// 多出来的连接器由 /connectors 命令和 /api/connectors/status 的 connectors 数组承载）。
export const CONNECTORS = [
  {
    id: 'github',
    title: 'GitHub',
    category: 'developer-tools',
    configCommand: '/github login',
    statusCommand: '/github test',
    // 一句话说明「配了能干什么」——给 /connectors 和 Web 面板共用
    summary: '读仓库 / Issue / PR，发评论、建 issue（GitHubRepo / GitHubIssues / GitHubPRs 等 8 个工具）',
    configFile: join(DATA_DIR, 'github.json'),
    probe: probeGithub,
  },
  {
    id: 'qq',
    title: 'QQ',
    category: 'communication',
    configCommand: '/qq setup',
    statusCommand: '/qq status',
    summary: 'QQ 私聊下达指令、回复自动发回；QQPush 主动推送、QQRecall 回溯群消息',
    configFile: join(DATA_DIR, 'qq-config.json'),
    probe: probeQq,
  },
  {
    id: 'mcp',
    title: 'MCP 服务器',
    category: 'extension',
    configCommand: '/mcp',
    statusCommand: '/mcp status',
    summary: '按 MCP 协议接入的任意工具服务（playwright / 邮件 / 通知 …），工具名形如 mcp_<服务器>_<工具>',
    configFile: MCP_PATH,
    probe: probeMcp,
  },
  {
    id: 'mail',
    title: '邮箱',
    category: 'communication',
    configCommand: '/mail add',
    statusCommand: '/mail',
    summary: 'IMAP/SMTP 收发邮件、自动提取验证码（经 MCP mail-qq 接入）',
    configFile: MAIL_ACCOUNTS_PATH,
    probe: probeMail,
  },
]

/** 静态元数据（不含探针结果，也不含文件路径这类内部细节）。 */
export function listConnectors() {
  return CONNECTORS.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    summary: c.summary,
    configCommand: c.configCommand,
    statusCommand: c.statusCommand,
  }))
}

export function getConnector(id) {
  const key = String(id || '').trim().toLowerCase()
  return CONNECTORS.find((c) => c.id === key) || null
}

/**
 * 单个连接器的状态。
 *
 * 探针抛异常不往外冒 —— 一个连接器的配置文件坏了，不该让 /connectors 整体崩掉。
 * （与 /mcp 的容错口径一致：单个服务器加载失败只跳过它自己。）
 */
export function connectorStatus(id, opts = {}) {
  const c = getConnector(id)
  if (!c) return null
  let st
  try {
    st = c.probe(opts) || { connected: false, detail: '探针没有返回结果' }
  } catch (e) {
    st = { connected: false, detail: `状态读取失败: ${e?.message || e}`, error: e?.message || String(e) }
  }
  return {
    id: c.id,
    title: c.title,
    category: c.category,
    summary: c.summary,
    configCommand: c.configCommand,
    statusCommand: c.statusCommand,
    ...st,
    // connected 保证是布尔值 —— 前端拿它渲染徽章，undefined 会让徽章状态诡异
    connected: !!st.connected,
  }
}

/**
 * 全部连接器状态。
 *
 * @param {object} [opts]
 *   mcpClient  活的 MCPClient（Web/CLI 都传真实实例；不传则 MCP 只报配置层状态）
 */
export function allConnectorStatuses(opts = {}) {
  return CONNECTORS.map((c) => connectorStatus(c.id, opts)).filter(Boolean)
}

/**
 * 汇总：几个已连接 / 共几个。
 * /connectors 的标题行和 Web API 的 meta 字段都用它，避免两处各算一遍。
 */
export function connectorSummary(opts = {}) {
  const all = allConnectorStatuses(opts)
  const connected = all.filter((c) => c.connected)
  return {
    total: all.length,
    connected: connected.length,
    connectedIds: connected.map((c) => c.id),
    disconnectedIds: all.filter((c) => !c.connected).map((c) => c.id),
  }
}
