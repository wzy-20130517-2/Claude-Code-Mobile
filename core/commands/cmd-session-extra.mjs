// 会话操作命令批（handleCommand 拆分第十四批 · 2026-09-23）
//
// 这些命令原来只存在于 index.mjs 的 switch 里，Web（APK）够不着。
// APK 里 index.mjs 根本不启动（ccm-start.mjs 直接拉 web/server.mjs），
// 所以「只写在 index.mjs 的命令」= APK 上不存在。
//
// 本批把已经模块化好的（实现就在 cmd-extensions.mjs，只是没进注册表）搬上来：
//   /branch   从当前会话分叉出新会话
//   /rewind   单文件改动回滚（multiUndo）
//   /copy     复制会话全文到剪贴板
//   /review   代码审查（给出 diff 视角的审查提示）
//   /plugins  插件列表
//   /x11      X11 图形环境配置
//
// 【2026-10-22 移出 /add-dir】它从来没有生效过（extraDirs 无消费方、
// CCM 也没有目录白名单），已连同实现一起删除，详见 cmd-extensions.mjs 的说明。
//
// 【为什么单独一个文件而不是塞进 cmd-misc】cmd-misc 管的是保活/回收站/字体，
// 这批管的是会话操作，混在一起下次找命令要翻两个语义域。

import { cmdBranch, cmdRewind, cmdCopy, cmdReview, cmdCodeReview, cmdPlugins, cmdX11 } from './cmd-extensions.mjs'

/**
 * @param {object} ctx
 *   multiUndo          MultiUndoStore（/rewind 用）
 *   agent
 *   sessionStore
 *   sessionId          () => string
 *   todos              () => array
 *   copyToClipboard    (text) => Promise<void> | void  可选，缺省退化为「其实我复制不了」
 */
export function makeSessionExtraCommands(ctx) {
  return {
    /**
     * /branch — 从当前会话分叉出新会话，便于「保留主线、试另一条路」。
     *
     * 【为什么要先保存】分叉点必须在当前会话的最新状态上，
     * 不然新分支会从「上次自动保存时的旧内容」长出来，丢掉最近几轮。
     */
    branch(args) {
      try { ctx.saveSession() } catch { /* 存不下仍允许分叉，只是分叉点可能偏旧 */ }
      return cmdBranch(ctx.sessionStore, ctx.sessionId(), ctx.agent, ctx.todos(), args)
    },

    /**
     * /rewind — 回滚文件改动（多步撤销）。
     *
     * ⚠ Incognito 会话禁用：隐私模式的历史不落盘，回滚会去读不存在的快照。
     * CLI 侧原来在 switch 里判 incognito，搬到模块后同样要判。
     */
    rewind(args) {
      if (ctx.incognito?.()) return 'Incognito 会话禁用 /rewind'
      return cmdRewind(ctx.multiUndo, ctx.agent, ctx.sessionStore, ctx.sessionId(), args)
    },

    /** /copy — 把当前会话全文复制到剪贴板 */
    copy(args) {
      return cmdCopy(ctx.agent, args)
    },

    /** /review — 代码审查（把改动喂给 agent 做 review 视角的分析） */
    review(args) {
      if (ctx.incognito?.()) return 'Incognito 会话禁用 /review'
      return cmdReview(args)
    },

    /**
     * /code-review —— 官方 2.1.303 的正式名（/review 是它的别名，见 COMMAND_ALIASES）。
     * 实现在 cmd-extensions 的 cmdCodeReview：先拦掉官方独有的 ultra 子命令，
     * 其余走本地静态扫描 cmdReview，与 /review 同一份实现。
     */
    'code-review'(args) {
      if (ctx.incognito?.()) return 'Incognito 会话禁用 /code-review'
      return cmdCodeReview(args)
    },

    /** /plugins — 列出已装插件 */
    plugins(args) {
      return cmdPlugins(args)
    },

    /** /x11 — X11 图形环境（mcp.json 里登记 x11 服务器） */
    x11(args) {
      return cmdX11(args, './mcp.json')
    },
  }
}
