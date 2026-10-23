// @ts-nocheck
// Claude Code Mobile - 自动上下文压缩
// 策略：默认关闭自动摘要；只认手动 /compact 与 /compact force；
// 已移除 cache-aware 自动摘要（易引发幻觉）；紧急保护依赖 agent 层上下文超长截断。
import { CompactService } from './compact.mjs'
import { backupBeforeCompact } from './compact-trash.mjs'
import { readFileSync, existsSync, statSync } from 'fs'
import { atomicWrite } from '../infra/atomic.mjs'
import { resolveConfigPath } from '../infra/paths.mjs'

// 默认值：固定阈值关闭 + 自动压缩关闭
const DEFAULT_TOKEN_LIMIT = 0
const DEFAULT_MESSAGE_LIMIT = 0
const DEFAULT_MAX_CONTEXT = 1000000 // 当前模型 1M 上下文
const DEFAULT_CACHE_POLICY = {
  enabled: false, // 关键：不自动生成摘要
  minChunkMessages: 8,
  minChunkTokens: 1800,
  pressureRatio: 0.82,
  hardPressureRatio: 0.94,
}

// 【2026-10-03】原为相对路径 → 读写源码目录。配置属用户数据，
// 统一放 ~/.claude-code-mobile/（见 core/paths.mjs）。
// ⚠ 自动压缩阈值（compactThresholdTokens/Messages）就存在这个文件里。
//
// 【2026-10-08 澄清：CLI 与 Web **共享**这一份配置】
// README 写明「与 CLI 共享配置与会话数据——同一个 ~/.claude-code-mobile/」。
// Web 的 loadWebConfig 也是 `{...cli, ...web}` 合并 —— CLI config.json 的
// 字段对 Web 全部可见，web-config.json 只是「Web 覆盖层」（存 current 等
// 会话级字段）。所以本模块**不需要**任何注入机制：Web 直接读这里就是
// 共享值，写也写回共享文件 —— 两边天然一致。
//
// 【踩坑记录】我一度加了 setThresholdSource 注入点，让 Web 写
// web-config.json「各读各的」——方向反了：那样 Web 设的阈值 CLI 看不到、
// CLI 设的 Web 改了也不影响终端，正是「共享配置」要避免的分裂。
const CONFIG_PATH = resolveConfigPath('config.json')

function loadThresholds() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return {
        tokenLimit: DEFAULT_TOKEN_LIMIT,
        messageLimit: DEFAULT_MESSAGE_LIMIT,
        keepLast: 10,
        maxContext: DEFAULT_MAX_CONTEXT,
        cachePolicy: { ...DEFAULT_CACHE_POLICY },
      }
    }
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    return {
      tokenLimit: config.compactThresholdTokens ?? DEFAULT_TOKEN_LIMIT,
      messageLimit: config.compactThresholdMessages ?? DEFAULT_MESSAGE_LIMIT,
      keepLast: config.compactKeepLast ?? 10,
      maxContext: config.maxContextTokens ?? DEFAULT_MAX_CONTEXT,
      cachePolicy: { ...DEFAULT_CACHE_POLICY, ...(config.compaction || {}) },
    }
  } catch {
    return {
      tokenLimit: DEFAULT_TOKEN_LIMIT,
      messageLimit: DEFAULT_MESSAGE_LIMIT,
      maxContext: DEFAULT_MAX_CONTEXT,
      cachePolicy: { ...DEFAULT_CACHE_POLICY },
    }
  }
}

function saveThresholds() {
  try {
    let config = {}
    if (existsSync(CONFIG_PATH)) config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    config.compactThresholdTokens = tokenLimit
    config.compactThresholdMessages = messageLimit
    config.compactKeepLast = keepLast
    config.maxContextTokens = maxContext
    config.compaction = { ...(config.compaction || {}), ...cachePolicy, enabled: cachePolicy.enabled === true }
    atomicWrite(CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch (e) {
    console.error(`\x1b[2m[警告: 无法保存压缩阈值: ${e.message}]\x1b[0m`)
  }
}

const { tokenLimit: _tl, messageLimit: _ml, keepLast: _kl, maxContext: _mc, cachePolicy: _cp } = loadThresholds()
let tokenLimit = _tl
let messageLimit = _ml
let keepLast = _kl
let maxContext = _mc
let cachePolicy = { ...DEFAULT_CACHE_POLICY, ..._cp, enabled: false } // 永远不强开自动摘要

// ══════════════════════════════════════════════════════════════════
//  【2026-10-06 修】阈值热更新 —— 原来只在模块加载时读一次
// ══════════════════════════════════════════════════════════════════
//
// 用户现象：「设了 600k 压缩阈值，但上下文到 654k 都没压缩」。
//
// 根因：`tokenLimit` 是模块级变量，只在**进程启动时**从 config 读一次
// （上面那行 loadThresholds()）。用户运行中改阈值（/compact-threshold）
// 只写了磁盘 —— 内存值还是旧的 0（= 关闭），于是 shouldCompact 恒 false。
//
// 实测时间线：进程启动 21:39:41，config 写入 21:39 —— 差 1 秒，读到了旧值。
//
// 修：每次 get 时比对 config.json 的 mtime，变了就重读。
// 代价：每轮一次 stat（微秒级），远比读盘+JSON 解析便宜。
//
// 【共享配置的意义】CLI 和 Web 读同一份 config.json —— mtime 热更新对
// 两边同时生效：Web 设置页改了阈值，CLI 侧下一轮就能看到（反之亦然）。
//
// 【2026-10-08 加固：mtime + size 双判据】实测本机（Termux/Android）的
// mtimeMs 分辨率约 10ms —— 连写 10 次 config，9 次的 mtimeMs 完全相同，
// 单靠 mtime 会把「同毫秒窗口内的写入」判成没变。加 size 作为第二判据：
// 改阈值（数字位数变化）几乎必然改变文件大小，能盖住绝大多数情况。
// 仍未覆盖的极端（同毫秒 + 同字节数，如 500000→600000）现实中不会发生
// （人手操作最快也要几百毫秒），不值得为此每轮读盘解析。
let _lastCfgMtime = -1
let _lastCfgSize = -1
function refreshIfChanged() {
  try {
    const st = statSync(CONFIG_PATH)
    if (st.mtimeMs === _lastCfgMtime && st.size === _lastCfgSize) return
    _lastCfgMtime = st.mtimeMs
    _lastCfgSize = st.size
    const fresh = loadThresholds()
    tokenLimit = fresh.tokenLimit
    messageLimit = fresh.messageLimit
    keepLast = fresh.keepLast
    maxContext = fresh.maxContext
    cachePolicy = { ...DEFAULT_CACHE_POLICY, ...fresh.cachePolicy, enabled: false }
  } catch { /* 读不到就保持当前值 */ }
}

export function getTokenLimit() { refreshIfChanged(); return tokenLimit }
export function getMessageLimit() { refreshIfChanged(); return messageLimit }
export function getMaxContext() { refreshIfChanged(); return maxContext }
export function getKeepLast() { refreshIfChanged(); return keepLast }
export function getCachePolicy() {
  return { ...cachePolicy, maxContextTokens: maxContext, enabled: false }
}

/** 是否允许自动压缩：仅当设置了固定阈值。
 *
 * 【2026-10-08 修】原来直接读模块变量 —— 不刷新配置。
 * 与 getTokenLimit 等不同，它没调 refreshIfChanged()，而 tokenLimit 只在
 * 那些 getter 被调用时才更新。调用链 autoCompact → shouldCompact →
 * isAutoCompactEnabled 中间没人调 getter，于是运行中改阈值（/compact-threshold
 * 或 Web 设置页）后本判断仍读进程启动时的旧值 —— 表现为「设了阈值不生效」。
 * 与 2026-10-06 修的是同族 bug（那次只修了 getter，漏了这个判定函数）。
 */
export function isAutoCompactEnabled() {
  refreshIfChanged()
  return tokenLimit > 0 || messageLimit > 0
}

export function setTokenLimit(v) {
  if (typeof v === 'number' && (v > 1000 || v === 0)) {
    tokenLimit = v
    saveThresholds()
    return true
  }
  return false
}

export function setMessageLimit(v) {
  if (typeof v === 'number' && (v >= 5 || v === 0)) {
    messageLimit = v
    saveThresholds()
    return true
  }
  return false
}

export function setKeepLast(v) {
  if (typeof v === 'number' && v >= 1 && v <= 10000) {
    keepLast = v
    saveThresholds()
    return true
  }
  return false
}

export function setMaxContext(v) {
  if (typeof v === 'number' && v > 10000) {
    maxContext = v
    saveThresholds()
    return true
  }
  return false
}

/** 三层水位（对标官方autoCompact.ts）：
 *   warning     = 剩 <20K 时提示（黄字，不阻塞）
 *   error       = 剩 <20K 且超预算 时警告（红字，不阻塞）
 *   blocking    = 剩 <13K 时直接合成错误拒绝（不打 API，防止 413 浪费）
 * 注意：自动压缩默认关，这三层只做状态提示与守门，不主动触发摘要。
 */
export function getContextWaterLevel(lastPromptTokens) {
  if (!lastPromptTokens || lastPromptTokens <= 0) return { level: 'ok', remain: -1 }
  const remain = maxContext - lastPromptTokens
  if (remain <= 13000) return { level: 'blocking', remain }
  if (remain <= 20000) return { level: 'error', remain }
  if (remain <= 33000) return { level: 'warning', remain }
  return { level: 'ok', remain }
}

// 多档阈值：warning → error → blocking（仅用于状态显示，不驱动自动摘要）
const MARGIN_AUTOCOMPACT = 13000
const MARGIN_WARNING = 33000
const MARGIN_ERROR = 53000

// getCompactLevel 已废弃，改用 getContextWaterLevel 后逐字段映射
export function getCompactLevel(lastPromptTokens) {
  return getContextWaterLevel(lastPromptTokens).level
}

/**
 * 是否在本轮结束后尝试自动压缩。
 * 默认 false。只有用户设置固定阈值（tokenLimit/messageLimit）才会 true。
 * 上下文超长紧急保护走 agent 层截断，不在这里生成摘要。
 */
export function shouldCompact(messages, tokenUsage, lastPromptTokens) {
  if (!isAutoCompactEnabled()) return false

  // 固定消息条数
  if (messageLimit > 0 && messages.length > messageLimit) return true
  // 固定 token
  if (tokenLimit > 0 && lastPromptTokens > 0 && lastPromptTokens > tokenLimit) return true

  return false
}

// 断路器：连续 3 次压缩失败则停止。
// 【2026-10-20】原来还导出 getConsecutiveFailures / resetFailures 两个 getter，
// 全项目零调用（`/compact status` 也不读它们）—— 已删。
// 计数器本身是活的，由 autoCompact 内部维护，别一起删。
let _consecutiveFailures = 0

// ══════════════════════════════════════════════════════════════════
//  rapid-refill 断路器（对齐官方 2.1.303）
// ══════════════════════════════════════════════════════════════════
//
// 【要解决什么】上面那个 _consecutiveFailures 只挡「压缩抛异常」。
// 还有一种更隐蔽的烧钱方式：压缩**成功**了，但压不下去多少 ——
// 下一轮上下文立刻又回到阈值以上，于是又压、又超、又压……
// 每一轮都白跑一次摘要 API 调用，且用户看到的是「一直在压缩」。
//
// 官方在 claude.js:864378 用 fn37392 判这个：
//   fn37382(v) = v?.compacted === true && v.turnCounter < 3
//                ? (v?.consecutiveRapidRefills ?? 0) + 1 : 0
//   fn37392 → { action: consecutiveRapidRefills >= 3 ? "trip" : "proceed" }
// 常量 num2892 = 3（轮窗口）、trip 阈值也是 3。
//
// 【为什么不用官方原样的 turnCounter】官方在主循环状态里维护 `turnCounter`
// （跨轮递增），CCM 的 agent.turnCount 每次 run 都重置，且 autoCompact 的
// 两个调用点（index.mjs / web/server.mjs）**只在超阈值时才调** ——
// 没有"每轮 tick 一次"的钩子，硬套轮次窗口只会得到错的数。
//
// 【等价判据：这次压缩到底压掉了多少】
// rapid refill 的本质是「压了等于没压」：压缩后 token 仍贴着阈值，
// 下一轮马上又超。所以直接量降幅即可，而且**零调用点改动**：
//   上次压缩前 lastPromptTokens = A
//   本次进来时  lastPromptTokens = B（= 上次压缩后的真实占用）
//   B >= A * EFFECTIVE_DROP_RATIO → 上次压缩无效 → 计数 +1
//   B <  A * EFFECTIVE_DROP_RATIO → 压缩有效     → 计数清零
// 这与官方「压缩后 <3 轮又超」抓的是同一批坏情况：
// 压不动 → 下一轮必超 → 连续命中。
//
// 【为什么不用时间窗口】官方用轮次不用时间 —— 慢速对话里「1 小时后又超」
// 是正常的，快速循环里「30 秒后又超」才是 thrashing。
const RAPID_REFILL_TRIP_THRESHOLD = 3 // 官方 fn37392 的 >= 3
// 降幅不足 10% 视为「没压下去」。取 10% 是因为：真正有效的压缩
// （摘要/丢工具输出）通常能砍掉 30%+；而阈值附近的抖动、新增长的一条消息
// 都远小于 10%。设太高会把「压了 8% 但确实够了」误判成 thrashing。
const EFFECTIVE_DROP_RATIO = 0.9
let _consecutiveRapidRefills = 0
let _lastPreCompactTokens = 0   // 上次压缩前的占用
let _tripped = false

// 【2026-10-20】原来这里导出 getRapidRefillState()（注释写"供 /compact status
// 与诊断使用"），但 /compact status 用的是 compactService.analyze，全项目零调用 —— 已删。
// 三个状态变量本身是活的（autoCompact 里读写），别一起删。

/** 用户手动 /compact 后调用：手动压缩是明确意图，清掉熔断状态重新开始 */
export function resetRapidRefill() {
  _consecutiveRapidRefills = 0
  _lastPreCompactTokens = 0
  _tripped = false
}

export async function autoCompact(agent, compactService, { print = console.log } = {}) {
  const history = agent.getHistory()
  // CLI 全屏模式传入 fsSession 的输出通道；不能让 console.log 直接把光标
  // 写进固定 footer。普通调用不传时保持原行为。
  const announce = (text) => {
    try { print(text) } catch {}
  }
  const lastPromptTokens = agent.getLastPromptTokens?.() || 0

  // 默认关闭：直接跳过，不评估、不打日志打扰用户
  if (!shouldCompact(history, null, lastPromptTokens)) return false

  if (_consecutiveFailures >= 3) {
    announce(`\n\x1b[2m[自动压缩已停用: 连续 3 次失败，用 /compact 手动压缩]\x1b[0m`)
    return false
  }

  // ── rapid-refill 断路器（对齐官方 fn37392）────────────────────────
  // 判定上次压缩是否「白压」：本次进来的占用 vs 上次压缩前的占用。
  // 只有真做过一次压缩（_lastPreCompactTokens > 0）才有可比基线。
  if (_lastPreCompactTokens > 0) {
    const nowTokens = agent.getLastPromptTokens?.() || 0
    if (nowTokens > 0 && nowTokens >= _lastPreCompactTokens * EFFECTIVE_DROP_RATIO) {
      _consecutiveRapidRefills++
    } else {
      // 上次压缩确实压下去了 → 不是 thrashing，计数清零重新观察
      _consecutiveRapidRefills = 0
    }
  }
  // 【熔断后怎么自愈】不靠外部调用 resetRapidRefill（那要改 /compact 命令层，
  // 属于别人的地盘）。判据放在这里更自然：熔断状态下如果占用**已经明显低于**
  // 上次压缩前的基线，说明用户手动 /compact 过了（它会 setApproxPromptTokens
  // 重估占用），此时自动解除熔断重新观察。
  // 不这么做的话，熔断一旦触发就只能 Ctrl+X 重启 —— 用户会以为功能坏了。
  if (_tripped && _lastPreCompactTokens > 0) {
    const nowT = agent.getLastPromptTokens?.() || 0
    if (nowT > 0 && nowT < _lastPreCompactTokens * EFFECTIVE_DROP_RATIO) {
      _tripped = false
      _consecutiveRapidRefills = 0
      _lastPreCompactTokens = 0
    }
  }
  if (_consecutiveRapidRefills >= RAPID_REFILL_TRIP_THRESHOLD) {
    // 只报一次，之后静默 —— 否则每轮都刷一行，用户以为程序坏了
    if (!_tripped) {
      _tripped = true
      announce(`\n\x1b[2m[自动压缩已熔断: 连续 ${RAPID_REFILL_TRIP_THRESHOLD} 次压缩后占用没降下来（压缩没有实际收益），本次会话不再自动压缩。用 /compact 手动压缩可重置。]\x1b[0m`)
    }
    return false
  }

  const before = history.length
  try {
    // ══════════════════════════════════════════════════════════════════
    //  先跑 micro（零 API、无损），压得下来就不调摘要
    // ══════════════════════════════════════════════════════════════════
    //
    // 【2026-10-20 修】下面这段 force 的注释一直写着「不影响压缩策略选择
    // （micro/摘要）」，但**代码里从来没有 micro 这一步** —— 自动压缩直接进摘要。
    // 手动 /compact 是有的（cmd-compact.mjs:93 先 microCompact 再摘要），
    // 两条路径行为不一致：长会话每次都白白多花一次摘要 API 调用，
    // 而其中大半体积只是可重跑的工具输出（Read/Grep/Bash 结果）。
    //
    // micro 只截断「可再生」的工具输出，对话本体一字不动，零信息损失。
    // 压完若压力已回到安全线（与手动 /compact 同口径取 70%），就此收手。
    let microNote = ''
    let microResult = null
    try {
      microResult = compactService.microCompact(agent.getHistory())
      if (microResult?.changed > 0) {
        agent.setHistory(microResult.messages)
        microNote = `已回收 ${microResult.changed} 条工具输出（~${microResult.reclaimedTokens} tokens，无损）`
        // 用微压缩后的历史重新评估：下面摘要若不需要了就走人
        const afterMicro = compactService.analyze(agent.getHistory(), {
          lastPromptTokens,
          maxContextTokens: maxContext,
          policy: getCachePolicy(),
          keepLast: getKeepLast(),
          force: true,
        })
        if ((afterMicro.pressure || 0) < 0.70) {
          announce(`\n\x1b[2m[自动压缩: ${microNote}，压力降至 ${((afterMicro.pressure || 0) * 100).toFixed(1)}%，无需摘要]\x1b[0m`)
          return true
        }
      }
    } catch (e) {
      // micro 是纯本地字符串裁剪，失败不应阻断后面的摘要路径
      microNote = ''
    }

    // ══════════════════════════════════════════════════════════════════
    //  【2026-10-06 修】force: true —— 否则两层判据打架
    // ══════════════════════════════════════════════════════════════════
    //
    // 用户现象：「设了 600k 阈值，上下文 660k 了还不压」。
    //
    // 根因：两条判据独立，后者否决前者 ——
    //   · shouldCompact（本函数开头）：tokenLimit=600000，660k > 600k → true ✓
    //   · compactService.analyze（内部）：pressure = 660k/1M = 0.66，
    //     低于 0.82 软阈值 → recommendation='defer' → **不压缩**
    //
    // 两条都对，但语义不同：analyze 的 82% 是「按模型上下文比例」自动判断，
    // 而用户设固定阈值（600k）是**明确表达「到这个数就压」** —— 应该尊重。
    //
    // force 只跳过「够不够格」的判断，不影响压缩策略选择（micro/摘要）
    // 和 keepLast 等参数。
    const result = await compactService.compact(agent.getHistory(), {
      lastPromptTokens,
      maxContextTokens: maxContext,
      policy: getCachePolicy(),
      keepLast: getKeepLast(),
      force: true,
    })
    if (!result.compacted) {
      // 摘要这一步没做成（比如 analyze 判定 defer），但 micro 已经生效过
      if (microNote) {
        announce(`\n\x1b[2m[自动压缩: ${microNote}]\x1b[0m`)
        return true
      }
      return false
    }
    // 备份的是**压缩前**的完整历史（micro 之前的 `history`），
    // 否则回收站里的副本已经是裁剪过的，想找回原始工具输出就晚了。
    backupBeforeCompact(history, { reason: 'auto', meta: { before: history.length, after: result.messages.length } })
    agent.setHistory(result.messages)
    _consecutiveFailures = 0
    // 记下本次压缩前的占用，作为「下次进来时判断有没有压下去」的基线
    _lastPreCompactTokens = lastPromptTokens
    const level = getCompactLevel(lastPromptTokens)
    announce(`\n\x1b[2m[自动压缩: ${before} → ${result.messages.length} 条消息 (${result.strategy}, ${level})${microNote ? `；${microNote}` : ''}]\x1b[0m`)
    return true
  } catch (e) {
    _consecutiveFailures++
    announce(`\n\x1b[2m[自动压缩失败 (${_consecutiveFailures}/3): ${e.message}]\x1b[0m`)
    return false
  }
}
