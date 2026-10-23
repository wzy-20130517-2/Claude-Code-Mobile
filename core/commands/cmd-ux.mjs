// 界面 / 会话体验命令批（对齐官方 Claude Code 2.1.303）
//
//   /theme          终端配色主题（官方：Change the theme）
//   /tui            渲染器选择（官方：Set the terminal UI renderer，[default|fullscreen]）
//   /scroll-speed   滚动步长（官方：Adjust mouse wheel scroll speed）
//   /keybindings    键位表 / 打开自定义键位文件（官方：Open your keyboard shortcuts file）
//   /version        当前运行的版本（官方：Print the version this session is running）
//   /release-notes  版本更新记录（官方：local-jsx，无描述）
//   /recap          一句话会话小结（官方：Generate a one-line session recap now）
//   /focus          专注视图：只留提问、摘要、回复（官方：Toggle focus view）
//   /cd             把会话切到另一个工作目录（官方：Move this session to a new working directory）

import { resolve } from 'node:path'
import { homedir } from 'node:os'
//
// 【为什么这些放一个文件】它们的共同点是「改的是**显示/会话外壳**，
// 不动模型行为、不动工具」。与 cmd-small-config（voice/statusline/mail，
// 改的是外部服务）和 cmd-system-config（provider 相关的系统配置）语义域不同。
//
// 【官方实现与 CCM 的形态差异（都是有意为之）】
//   · 官方这批几乎全是 local-jsx（Ink 弹窗：方向键选主题、滑块调速度）。
//     手机窄屏 + 触屏，多级弹窗的每一步都要点一下；这里全部做成
//     「一行命令 + 文本回执」，能直接带参数的就不进交互。
//   · /tui 官方是 default|fullscreen 两种渲染器。CCM 的全屏是固定启用的
//     （2026-10 用户拍板「全屏界面固定启用，不再通过 /fullscreen 切换」），
//     所以这里**不假装能切**，而是如实说明现状 + 给出真正能调的相关项。

/**
 * @param {object} ctx
 *   C, config, saveConfig
 *   CLI_VERSION                   当前版本字符串
 *   getMarkdownTheme() / setMarkdownTheme(name) / markdownThemeNames()
 *   getMaxContext / setMaxContext
 *   fsSession                     () => 全屏会话实例（可能为 null）
 *   getScrollStep / setScrollStep 滚动步长（可选，缺省读 config.scrollStep）
 *   getCurrentSystemPrompt        系统提示词全文（/recap 估算用）
 *   runAgent?                     (prompt, opts) => Promise<string>  一句话小结用
 *   setWorkspacePath / getWorkspacePath
 *   onWorkspaceChange?            () => void  切目录后重建提示词等
 *   reloadSkills?                 () => { count }  （/reload-skills 用，见 cmd-diag）
 */
export function makeUxCommands(ctx) {
  const C = ctx.C || new Proxy({}, { get: () => '' })

  /** 滚动步长：存 config.scrollStep，默认 3 行（与全屏适配器 scrollUp/scrollDown 默认一致） */
  const scrollStep = () => {
    const n = Number(ctx.config?.scrollStep)
    return Number.isFinite(n) && n > 0 ? n : 3
  }

  return {
    /**
     * /theme —— 终端配色主题
     *
     * 【官方语义】2.1.303：`Change the theme`，local-jsx（弹窗选）。
     *
     * 【CCM 的「主题」有两个层面，别混】
     *   1. **终端配色**（claude orange / 蓝紫 / 绿红）—— 写死在 index.mjs 的 C 对象里，
     *      属于品牌视觉，没有多套可选。改它等于改整个项目的视觉语言，
     *      不是一条命令该干的事。
     *   2. **Markdown 渲染配色**（classic / official）—— 已有 /markdown 管。
     * 所以 /theme 在这里**不重复造一套主题系统**，而是：
     *   · 无参 → 报告当前生效的是哪套，并指出能改的地方
     *   · 带参 → 转发到 /markdown（因为它才是真正可切的配色）
     * 这样用户敲 /theme official 能得到他期待的效果，而不是一句「不支持」。
     *
     * 【为什么不干脆加一套终端主题】那要重做 C 对象、流式渲染器、
     * 全屏适配器里几十处颜色引用，且官方也没有「终端主题」这个概念
     * （官方主题是 Markdown + diff + 语法的统一配色）。做一个半吊子的
     * 终端配色开关，比不做更糟。
     */
    theme(args) {
      const sub = String(args[0] || '').trim().toLowerCase()
      const available = (() => { try { return ctx.markdownThemeNames() } catch { return [] } })()
      if (!sub) {
        const cur = (() => { try { return ctx.getMarkdownTheme() } catch { return '(unknown)' } })()
        return [
          `${C.bold}当前渲染配色${C.reset}: ${cur}`,
          '',
          '可切换的:',
          ...available.map(n => `  ${n === cur ? '*' : ' '} ${n}`),
          '',
          `切换: ${C.dim}/theme official${C.reset}（等价 /markdown official）`,
          `${C.dim}注：终端本身的基础配色（品牌橙 / 成功绿 / 错误红）是项目视觉的一部分，`,
          `不可切换 —— 官方也没有这个开关，它的 theme 就是 Markdown + diff 的统一配色。${C.reset}`,
        ].join('\n')
      }
      // 转发给 markdown 命令 —— 一份实现，避免两套配色逻辑漂移
      if (typeof ctx.setMarkdownTheme === 'function' && available.includes(sub)) {
        ctx.setMarkdownTheme(sub)
        ctx.config.markdownTheme = sub
        ctx.saveConfig(ctx.config)
        return `配色已切换为 ${sub}（新内容立刻生效；已输出的旧内容不重绘）`
      }
      return `未知主题: ${sub}\n可用: ${available.join(' / ') || '(无)'}\n`
        + `用 /theme 看当前配色。`
    },

    /**
     * /tui —— 渲染器
     *
     * 【官方语义】2.1.303：`Set the terminal UI renderer (default | fullscreen)`，
     * argumentHint `[default|fullscreen]`。
     *
     * 【CCM 为什么不实现切换】2026-10 用户明确拍板「全屏界面固定启用，
     * 不再通过 /fullscreen 切换」—— 全屏已经是唯一形态，没有 default 渲染器了。
     * 假造一个 `default` 分支（比如退化成逐行打印）等于把删掉的东西加回来，
     * 且那条路径长期无人走、必然腐坏。
     *
     * 所以这里如实说明，并给出**真正能调的**相关项。用户敲 `/tui fullscreen`
     * 会得到「已经是了」，而不是报错 —— 因为他的意图确实被满足了。
     */
    tui(args) {
      const sub = String(args[0] || '').trim().toLowerCase()
      const active = !!ctx.fsSession?.()
      if (!sub) {
        return [
          `${C.bold}渲染器${C.reset}: ${active ? 'fullscreen（固定启用）' : '尚未启动全屏会话'}`,
          '',
          'CCM 只有一种渲染器：全屏。2026-10 起固定启用，不再提供 default 切换 ——',
          '全屏是唯一形态，另做一个逐行打印的 default 等于维护一条无人走的路。',
          '',
          '能调的替代项:',
          `  ${C.dim}/scroll-speed <1-20>   滚动步长（滑动一格走几行）${C.reset}`,
          `  ${C.dim}/markdown <classic|official>   Markdown 配色${C.reset}`,
          `  ${C.dim}/keys                  查看全部快捷键${C.reset}`,
        ].join('\n')
      }
      if (sub === 'fullscreen') {
        return active
          ? '已经是 fullscreen 了（固定启用，无需切换）。'
          : '当前还没进全屏会话（可能处于非交互环境）。全屏是唯一渲染器，不需要手动切。'
      }
      if (sub === 'default') {
        return 'CCM 没有 default 渲染器 —— 全屏是唯一形态（2026-10 起固定启用）。\n'
          + '如果你觉得全屏不合适，说清具体哪里不合适，那是要改全屏本身，而不是加回一条老路径。'
      }
      return `用法: /tui\n（无参看当前渲染器与可调项；fullscreen / default 仅作兼容识别，实际不可切换）`
    },

    /**
     * /scroll-speed —— 滚动步长
     *
     * 【官方语义】2.1.303：`Adjust mouse wheel scroll speed`，local-jsx（弹窗滑块），
     * 且只在支持鼠标滚轮的终端里 isEnabled。手机没有鼠标滚轮 —— 对应物是
     * **手指滑动/上下方向键一次走几行**（全屏适配器 scrollUp/scrollDown）。
     *
     * 【为什么保留这个命令】终端里滑动一次只走 3 行，长回复要划几十次；
     * 而滑太快又会跳过内容。这个体感参数确实需要可调。
     *
     * 【取值上限 20】一次滑 20 行在 40 行的手机上已经是半屏，
     * 再大就等于「翻页」而不是「滚动」，滑一下不知道自己在哪。
     */
    'scroll-speed'(args) {
      const sub = String(args[0] || '').trim().toLowerCase()
      const cur = scrollStep()
      if (!sub) {
        return [
          `${C.bold}滚动步长${C.reset}: ${cur} 行/次`,
          '',
          '调整: /scroll-speed <1-20>',
          `  ${C.dim}小（1-3）—— 逐行精读长代码${C.reset}`,
          `  ${C.dim}中（4-8）—— 日常${C.reset}`,
          `  ${C.dim}大（10-20）—— 快速翻长回复${C.reset}`,
          '',
          `${C.dim}作用于：滑动手势 / 上下方向键 / 滚轮事件。默认 3。${C.reset}`,
        ].join('\n')
      }
      const n = parseInt(sub, 10)
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        return `需要 1-20 的整数，收到 "${sub}"。\n当前: ${cur} 行/次`
      }
      ctx.config.scrollStep = n
      ctx.saveConfig(ctx.config)
      // 立刻应用到运行中的全屏适配器（它读的是自己的字段，不读 config）
      try { if (ctx.fsSession?.()) ctx.fsSession().scrollStep = n } catch {}
      return `滚动步长已设为 ${n} 行/次（立即生效）`
    },

    /**
     * /keybindings —— 键位
     *
     * 【官方语义】2.1.303：`Open your keyboard shortcuts file`，
     * 即把用户带到 `~/.claude/keybindings.json` 去改。
     *
     * 【CCM 为什么不支持自定义键位文件】手机端键位是**硬编码在
     * core/readline.mjs + fullscreen-adapter.mjs** 里的（Ctrl+I 补全、Ctrl+X 重启…），
     * 没有配置层。做一个「打开一个改了也不生效的文件」是欺骗。
     *
     * 所以这条命令做的是它在这个项目里**唯一有意义**的版本：
     * 列出真实生效的键位（来源是 /keys 的实现），并明确说明不可自定义。
     * 用户问「怎么改键位」时得到的是实情，而不是一个空文件。
     */
    keybindings(args) {
      const sub = String(args[0] || '').trim().toLowerCase()
      if (sub === 'edit' || sub === 'open') {
        return [
          'CCM 的键位是硬编码的（core/readline.mjs + core/ui/fullscreen-adapter.mjs），',
          '没有 keybindings.json 这一层 —— 打开一个改了也不生效的文件只会误导。',
          '',
          '想看有哪些键: /keybindings（或 /keys）',
          '想改某个键: 说清「把 X 改成 Y」，那是改代码，不是改配置。',
        ].join('\n')
      }
      // 无参：转发到 /keys（那是唯一真值源，别在这里复制一份键位表 —— 会漂移）
      return ctx.keysHelp ? ctx.keysHelp() : '用 /keys 查看全部快捷键。'
    },

    /**
     * /version —— 当前运行的版本
     *
     * 【官方语义】2.1.303：`Print the version this session is running
     * (not what autoupdate downloaded)`。
     *
     * 【「this session is running」这个限定很关键】官方有自动更新：
     * 磁盘上可能是新版本，但**进程里跑的还是旧的**。CCM 用 /update 手动更新、
     * 更新后要 Ctrl+X 重启，所以同样有「磁盘新、进程旧」的窗口。
     * 这里两个都报，并明确指出要不要重启 —— 只报一个都会误导。
     */
    version(args) {
      const running = String(ctx.CLI_VERSION || '0.0.0')
      let onDisk = running
      try {
        onDisk = String(ctx.diskVersion?.() || running)
      } catch {}
      const same = onDisk === running
      const lines = [
        `版本（当前进程）: ${C.bold}${running}${C.reset}`,
      ]
      if (!same) {
        lines.push(`版本（磁盘上）  : ${onDisk}`)
        lines.push('')
        lines.push(`${C.yellow}磁盘上已是新版本，但进程里跑的还是旧的 —— 按 Ctrl+X 重启后生效。${C.reset}`)
      } else {
        lines.push(`${C.dim}磁盘与进程一致。检查有没有更新版: /update check${C.reset}`)
      }
      if (String(args[0] || '').toLowerCase() === 'all') {
        lines.push('')
        lines.push(`Node: ${process.version}`)
        lines.push(`平台: ${process.platform} ${process.arch}`)
        lines.push(`工作目录: ${process.cwd()}`)
      }
      return lines.join('\n')
    },

    /**
     * /release-notes —— 版本更新记录
     *
     * 【官方语义】2.1.303：local-jsx，无描述（Ink 弹窗展示 changelog）。
     * 官方 changelog 来自云端；CCM 是本地 git 仓库，对应物是 `git log`。
     *
     * 【为什么不硬编码一份 CHANGELOG.md】项目没有维护 CHANGELOG 文件
     * （版本号规则写在 CLAUDE.md 的「版本号规则」一节，commit message 就是记录）。
     * 凭空生成一份会立刻过期。直接读 git log 永远是准的。
     *
     * 参数: /release-notes [N]（默认 20 条）
     */
    'release-notes'(args) {
      const n = Math.min(200, Math.max(1, parseInt(args[0], 10) || 20))
      try {
        const out = ctx.gitLog?.(n)
        if (!out) return '读不到 git log（当前目录可能不是 git 仓库，或是浅克隆）。'
        return [`最近 ${n} 条提交（当前版本 ${ctx.CLI_VERSION || '?'}）`, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', out].join('\n')
      } catch (e) {
        return `读 git log 失败: ${e?.message || e}\n（/release-notes 依赖本地 git 历史）`
      }
    },

    /**
     * /recap —— 一句话会话小结
     *
     * 【官方语义】2.1.303：`Generate a one-line session recap now`，
     * 而且官方有一段很硬的前置限制（str1799）：**只在你本人主动请求时运行**，
     * 从 Slack / 项目线程 / 定时任务转发进来的消息不能触发它。
     * 理由显然是「别让自动化把 recap 当免费摘要服务刷」。
     *
     * 【CCM 的落地】CCM 没有 Slack/远程转发通道（QQ 桥也算「本人私聊」），
     * 所以这条限制不适用。真正要防的是**模型自己调**——recap 要发一次 API，
     * 模型不该拿它当省事的总结工具。所以：
     *   · 命令层不检查（用户敲就是要）
     *   · 但也不给模型工具入口（它只能用 Bash/CommandExec 绕，成本比直接总结高）
     *
     * 【为什么不用「最近一条助手消息」充数】官方是真发一次模型请求做压缩。
     * 用现成消息充数看着像成功、实际给的是旧内容 —— 用户分不清「recap 坏了」
     * 和「这轮没干活」。所以这里要么真跑一次，要么明说跑不了。
     */
    async recap(args) {
      const history = (() => { try { return ctx.agent?.getHistory?.() || [] } catch { return [] } })()
      if (history.length === 0) return 'Nothing to recap yet — 先发一条消息。'
      if (typeof ctx.runAgent !== 'function') {
        return [
          '当前环境不支持生成 recap（没有注入 runAgent）。',
          '',
          `本会话概况（本地统计，不调 API）:`,
          `  消息 ${history.length} 条 · 累计输出 ${(() => { try { return ctx.agent.getTokenUsage().output } catch { return 0 } })()} tokens`,
          '要看真正的总结，直接说「总结一下这次会话」即可。',
        ].join('\n')
      }
      try {
        const text = await ctx.runAgent(
          '用**一句话**（不超过 40 字）概括这段会话在做的事和当前进展。'
          + '只输出那一句话，不要前缀、不要解释、不要引号。',
          { kind: 'recap' },
        )
        const one = String(text || '').trim().split('\n').filter(Boolean)[0] || '(空)'
        return `会话小结: ${one}`
      } catch (e) {
        return `生成 recap 失败: ${e?.message || e}\n（这不影响对话本身）`
      }
    },

    /**
     * /focus —— 专注视图
     *
     * 【官方语义】2.1.303：`Toggle focus view: just your prompt, summary, and response`，
     * 即隐藏工具调用、思考过程、看板，只留「我问的 / 摘要 / 你答的」。
     *
     * 【实现分两层，缺一不可】
     *   1. **看板折叠** —— 全屏适配器已有的 collapsed.{todo,activity}
     *      （Ctrl+T / Ctrl+Y / Ctrl+O），一键收起。
     *   2. **工具行与思考静默** —— 由 index.mjs 的 focusMode 开关控制，
     *      拦截点是三个「往正文写工具内容」的出口（工具行、结果行、
     *      执行中的输出窗口 / 参数预览窗口）和 onReasoning。
     *
     * 【为什么第 2 层放在 index.mjs 而不是渲染器】
     * 渲染器只认「逻辑行数组」，不区分这一行是正文还是工具行；判断依据
     * （工具名、⎿ 前缀、思考色）全在 index.mjs 生成。在**生成处**拦截
     * 既准确又便宜：不写进 body 就不需要任何「事后隐藏/恢复」的重排。
     *
     * 【隐藏 ≠ 不执行】工具照常跑、结果照常回给模型，只是不画出来。
     * 退出 focus 后新输出正常显示；focus 期间被隐藏的内容不会补画
     * （它们从来没进过 bodyLines）。
     *
     * 参数: /focus on|off（省略 = toggle）
     */
    focus(args) {
      const sub = String(args[0] || '').trim().toLowerCase()
      const getFocus = ctx.getFocusMode
      const setFocus = ctx.setFocusMode
      if (typeof getFocus !== 'function' || typeof setFocus !== 'function') {
        return '专注视图未接入（缺少 focusMode 开关，属实现问题）。'
      }
      const cur = !!getFocus()
      const want = sub === 'on' ? true : sub === 'off' ? false : !cur
      setFocus(want)
      // 看板折叠：非全屏环境没有看板，跳过即可（不再整体拒绝）。
      const fs = ctx.fsSession?.()
      let boardMsg = ''
      if (fs && typeof fs.toggleBoard === 'function') {
        const collapsed = fs.collapsed || {}
        const isCollapsed = !!(collapsed.todo && collapsed.activity)
        if (isCollapsed !== want) boardMsg = fs.toggleBoard('all')
        else boardMsg = `待办 ${collapsed.todo ? '收起' : '展开'} · 活动 ${collapsed.activity ? '收起' : '展开'}`
      }
      const lines = [
        `${C.bold}专注视图${C.reset}: ${want ? '开' : '关'}`,
        `${C.dim}工具调用 / 执行输出 / 思考内容: ${want ? '已隐藏（仍照常执行）' : '已恢复显示'}${C.reset}`,
      ]
      if (boardMsg) lines.push(`${C.dim}看板: ${boardMsg}${C.reset}`)
      if (want) {
        lines.push('')
        lines.push(`${C.dim}只留「你的提问 / 我的回复」。运行状态仍在底部状态条可见。${C.reset}`)
      }
      return lines.join('\n')
    },

    /**
     * /cd —— 把会话切到另一个工作目录
     *
     * 【官方语义】2.1.303：`Move this session to a new working directory`，
     * argumentHint `<path>`。
     *
     * 【与 /workspace 的区别（两个都存在，别合并）】
     *   /workspace  —— 改**配置里**的工作区路径（持久化，下次启动也用它）
     *   /cd         —— 只改**这次会话**的当前目录（等价 shell 的 cd）
     * 官方只有 /cd（它没有 workspace 配置这个概念）。CCM 两个都要：
     * 「临时进某个目录看看」和「以后都在这里开工」是两种意图。
     *
     * 【为什么必须同时 chdir + 重建提示词】系统提示词里写着「工作目录: xxx」，
     * 只 chdir 不改提示词的话，模型仍以为自己在旧目录，相对路径全错。
     */
    cd(args) {
      const target = String(args[0] || '').trim()
      const cur = process.cwd()
      if (!target) {
        return [
          `${C.bold}当前会话目录${C.reset}: ${cur}`,
          '',
          '用法: /cd <路径>',
          `  /cd ..                  上一级`,
          `  /cd ~                   家目录`,
          `  /cd /sdcard/Download    绝对路径`,
          '',
          `${C.dim}只影响本次会话（等价 shell 的 cd）。`,
          `想让以后每次启动都在那里，用 /workspace <路径>（持久化到 config.json）。${C.reset}`,
        ].join('\n')
      }
      // 解析 ~ / 相对路径
      let abs = target
      if (target === '~' || target.startsWith('~/')) {
        abs = target === '~' ? homedir() : homedir() + target.slice(1)
      }
      abs = resolve(cur, abs)
      try {
        process.chdir(abs)
      } catch (e) {
        return `切不过去: ${abs}\n  ${e?.message || e}`
      }
      // 提示词里的工作目录要跟着变，否则模型按旧目录算相对路径
      try { ctx.onWorkspaceChange?.() } catch {}
      return [
        `会话目录已切换: ${cur}`,
        `            → ${process.cwd()}`,
        '',
        `${C.dim}只影响本次会话。要持久化用 /workspace。`,
        `注意：工具的相对路径现在都相对新目录解析。${C.reset}`,
      ].join('\n')
    },
  }
}
