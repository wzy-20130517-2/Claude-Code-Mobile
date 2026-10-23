// EnterWorktree / ExitWorktree —— 会话级 git worktree 切换
//
// 对齐官方 Claude Code 2.1.303 的 EnterWorktree / ExitWorktree
//（claude.js:1064074 / 1064290，prompt 在 fn172125 / fn17630）。
//
// 【它解决什么问题】
// 在一个仓库里同时干两件互不干扰的活（比如「修这个 bug」和「顺手重构那块」），
// 或者要让子 Agent 在隔离副本里改文件、不污染主工作区 —— 手动做法是
// `git worktree add ../xxx` 然后自己 cd 过去，但**会话的 cwd 不会跟着变**：
// 后续所有 Read/Edit/Bash 还在原目录里跑，等于没隔离。
// 这个工具把「建 worktree」和「把会话切过去」合成一步，ExitWorktree 再切回来。
//
// 【与 Agent 的 isolation:"worktree" 的区别】
// 那个是「给子 Agent 一次性副本」，跑完就没了，主会话完全无感。
// 这个是**当前会话自己**搬进 worktree，后续所有工具调用都在里面。
//
// 【官方有哪些我们没做】
// · WorktreeCreate / WorktreeRemove hooks（非 git 仓库的自定义隔离方案）—— CCM 没这套 hook
// · tmux 会话联动（keep 时保留、remove 时 kill）—— CCM 不跑 tmux
// · PR/MR ref 拉取（--from-pr）—— 属于命令行入口，不是工具参数
// · sparsePaths / symlinkDirectories 配置 —— CCM 的 settings 里没有 worktree 段
// 这些都不影响「创建 → 切过去 → 切回来」的主链路。

import { Tool } from './tools.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { resolveConfigPath } from '../infra/paths.mjs'
import { atomicWrite } from '../infra/atomic.mjs'

/** 会话 → worktree 状态的落盘文件（跨 Ctrl+X 重启仍能 ExitWorktree）。 */
const STATE_PATH = () => resolveConfigPath('worktree-sessions.json')

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH(), 'utf-8')) || {} } catch { return {} }
}
function saveState(all) {
  try {
    mkdirSync(dirname(STATE_PATH()), { recursive: true })
    atomicWrite(STATE_PATH(), JSON.stringify(all, null, 2))
  } catch { /* 落盘失败不影响本次会话内使用 */ }
}

/** git 执行器：失败返回 { ok:false, stderr }，不抛（工具要给出可读原因）。 */
function git(cwd, args) {
  try {
    const stdout = execFileSync('git', args, {
      cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
      // ⚠ stderr 必须 'pipe'（这是 execFileSync 的默认值，但这里显式写出来锁死）。
      // 实测踩到：git 失败时 stderr 里有 "fatal: ..."，而 git 成功时也有
      // "Preparing worktree (new branch 'fix-a')" 这类进度输出。
      // 一旦 stderr 走 inherit（或者有人改成 'inherit'），这些行会**绕过渲染层
      // 直写终端**，在全屏模式下怼到输入框上 —— 项目里已有多处同类事故
      //（见 CLAUDE.md「回收站备份信息不能直写 stderr」）。这里的 git 调用
      // 全都要把 stderr 收进返回值，由工具结果统一呈现。
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { ok: true, stdout }
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || '').trim(), stderr: String(e.stderr || e.message || '').trim() }
  }
}

/** 仓库根目录；不在仓库里返回 null。 */
function repoRootOf(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok && r.stdout ? r.stdout : null
}

/**
 * worktree 名字校验（对齐官方 fn174210 的 name 描述）：
 * 每段只允许字母数字点下划线横线，总长 ≤64，段之间用 / 分隔。
 * 为什么要校验：名字直接拼进路径和分支名，放任 `../` 就能写到仓库外面去。
 */
function validateName(name) {
  const s = String(name || '').trim()
  if (!s) return '名字不能为空'
  if (s.length > 64) return `名字太长（${s.length} 字符，上限 64）`
  const segs = s.split('/')
  for (const seg of segs) {
    if (!seg) return '名字里不能有空的路径段（// 或首尾斜杠）'
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return `路径段 "${seg}" 只能包含字母、数字、点、下划线、横线`
    if (seg === '.' || seg === '..') return `路径段不能是 "${seg}"`
  }
  return null
}

/** 随机名字：wt-<6位十六进制>，避免默认名字撞车。 */
function randomName() {
  return 'wt-' + Math.random().toString(16).slice(2, 8)
}

/** 默认分支名：origin/HEAD 指向谁就是谁；解析不出来退回 main。 */
function defaultBranch(repoRoot) {
  const r = git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (r.ok && r.stdout) return r.stdout.replace(/^origin\//, '')
  return 'main'
}

function hasOrigin(repoRoot) {
  const r = git(repoRoot, ['remote'])
  return r.ok && r.stdout.split('\n').includes('origin')
}

/**
 * 会话级的「当前在哪个 worktree」状态。
 * key 用 sessionId —— Web 端一个进程里可能同时跑多个会话，
 * 用全局单变量会让 A 会话的 ExitWorktree 把 B 会话的 cwd 切走。
 */
class WorktreeSessions {
  constructor() {
    this.mem = new Map()     // sessionKey -> { originalCwd, worktreePath, worktreeBranch, repoRoot }
    this.loaded = false
  }
  _ensure() {
    if (this.loaded) return
    this.loaded = true
    for (const [k, v] of Object.entries(loadState())) this.mem.set(k, v)
  }
  get(key) { this._ensure(); return this.mem.get(key) || null }
  set(key, val) {
    this._ensure()
    this.mem.set(key, val)
    const all = {}
    for (const [k, v] of this.mem) all[k] = v
    saveState(all)
  }
  clear(key) {
    this._ensure()
    this.mem.delete(key)
    const all = {}
    for (const [k, v] of this.mem) all[k] = v
    saveState(all)
  }
}

const sessions = new WorktreeSessions()

/** 状态键：有 sessionId 用它，没有就退化成「进程级」（Web 无 sessionId 的老路径）。 */
function stateKey(sessionId) {
  return String(sessionId || '__default__')
}

export class EnterWorktreeTool extends Tool {
  /**
   * @param {object} opts
   *   getCwd()  取当前会话 cwd（必给）
   *   setCwd(p) 切换会话 cwd（必给；不给就只建不切，那没有意义）
   */
  constructor({ getCwd, setCwd } = {}) {
    super({
      name: 'EnterWorktree',
      description: [
        '创建一个隔离的 git worktree，并把**当前会话的工作目录切过去**。之后所有 Read/Edit/Bash 都在这个 worktree 里跑。',
        '',
        '## 什么时候用（严格）',
        '- 用户**明确说了** "worktree"（"开个 worktree"、"在 worktree 里做"、"用 worktree"）',
        '- CLAUDE.md / 记忆里明确要求这个任务在 worktree 里做',
        '',
        '## 什么时候不要用',
        '- 用户说"建个分支/切分支/换个分支干活" → 用 git 命令，不是这个工具',
        '- 用户说"修个 bug/做个功能" → 正常 git 流程即可，除非他或 CLAUDE.md 明确提到 worktree',
        '- **没听到 "worktree" 这个词就不要用**',
        '',
        '## 行为',
        '- 在仓库的 `.claude/worktrees/<name>` 下创建 worktree，分支同名',
        '- base ref：默认 `fresh`（从 origin/<默认分支> 拉，干净起点）；仓库没有 origin 时退回当前 HEAD',
        '- 创建成功后会话 cwd 切到新 worktree；用 ExitWorktree 退出（keep 保留 / remove 删除）',
        '- 已经在 worktree 会话里时**不能**再建新的（先 ExitWorktree）',
        '',
        '## 参数',
        '- `name`（可选）：worktree 名。每段只允许字母数字点下划线横线，总长 ≤64，可用 `/` 分段（如 `feat/login`）。省略则随机生成。',
        '- `path`（可选）：切到一个**已存在**的 worktree，而不是新建。必须是 `git worktree list` 里出现过的路径。与 `name` 互斥。',
        '',
        '示例：',
        '  {name:"fix-login"}                                   新建并切过去',
        '  {}                                                   随机名新建',
        '  {path:"/repo/.claude/worktrees/fix-login"}           切到已有的',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '新建 worktree 的名字。每段只允许字母数字点下划线横线，总长 ≤64，可用 / 分段。省略则随机生成。与 path 互斥。',
          },
          path: {
            type: 'string',
            description: '切到一个已存在的 worktree（必须出现在 git worktree list 里），而不是新建。与 name 互斥。',
          },
        },
      },
      isConcurrencySafe: () => false,
      maxResultSizeChars: 3000,
      validateInput: (input) => {
        const errors = []
        if (input.name && input.path) errors.push('name 和 path 只能给一个')
        if (input.name) {
          const err = validateName(input.name)
          if (err) errors.push(`name 不合法：${err}`)
        }
        return { valid: errors.length === 0, errors }
      },
    })
    this.getCwd = getCwd || (() => process.cwd())
    this.setCwd = setCwd || null
  }

  async execute(input, ctx = {}) {
    const key = stateKey(ctx.sessionId)
    const existing = sessions.get(key)
    if (existing && !input.path) {
      return `已经在 worktree 会话里了：${existing.worktreePath}\n`
        + `要建新的，先用 ExitWorktree（action:"keep" 保留当前 / "remove" 删除）退出。`
    }
    const cwd = this.getCwd() || process.cwd()

    // ── 分支 A：切到已存在的 worktree ──
    if (input.path) {
      return this._enterExisting(input.path, cwd, key)
    }

    // ── 分支 B：新建 ──
    const repoRoot = repoRootOf(cwd)
    if (!repoRoot) {
      return `当前目录不在 git 仓库里（${cwd}），无法创建 worktree。\n`
        + `请先 cd 到仓库目录，或在仓库里执行 git init。`
    }
    const name = String(input.name || randomName()).trim()
    const wtPath = join(repoRoot, '.claude', 'worktrees', name)
    const branch = name

    if (existsSync(wtPath)) {
      return `目标路径已存在：${wtPath}\n`
        + `如果它是个已注册的 worktree，用 {path:"${wtPath}"} 切过去；`
        + `如果是个残留目录，先手动删掉它。`
    }
    // 分支已被别处签出 → git 会拒绝（-b 不允许重复）。先探一下，给出人话。
    const branchCheck = git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (branchCheck.ok) {
      return `分支 "${branch}" 已存在，无法用它创建新 worktree。\n`
        + `换个 name，或先 git branch -D ${branch}（确认那个分支没用了再删）。`
    }

    // base ref：fresh = origin/<默认分支>（先 fetch 一次保证新鲜），
    // head = 当前 HEAD（保留未推送的提交）。
    // 为什么默认 fresh：官方就是这么定的 —— 隔离工作应该从干净的起点开始，
    // 否则「顺手带上本地未提交改动」会让 worktree 里的结果不可复现。
    let base
    if (hasOrigin(repoRoot)) {
      const def = defaultBranch(repoRoot)
      // fetch 失败不阻断：可能离线。退回本地已有的 origin/<def>。
      git(repoRoot, ['fetch', 'origin', def])
      const remoteRef = `origin/${def}`
      const check = git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}`])
      base = check.ok ? remoteRef : 'HEAD'
    } else {
      base = 'HEAD'
    }

    try { mkdirSync(join(repoRoot, '.claude', 'worktrees'), { recursive: true }) } catch {}
    const add = git(repoRoot, ['worktree', 'add', '--no-track', '-b', branch, wtPath, base])
    if (!add.ok) {
      return `创建 worktree 失败：\n${add.stderr || add.stdout || '(无输出)'}\n`
        + `常见原因：路径被占用、分支已存在、磁盘空间不足。`
    }

    const state = { originalCwd: cwd, worktreePath: wtPath, worktreeBranch: branch, repoRoot }
    sessions.set(key, state)
    if (this.setCwd) this.setCwd(wtPath)

    return `已创建 worktree 并切换会话目录\n`
      + `  路径: ${wtPath}\n`
      + `  分支: ${branch}（基于 ${base}）\n`
      + `  原目录: ${cwd}\n`
      + `之后所有文件/命令操作都在这个 worktree 里。用 ExitWorktree 退出（keep 保留 / remove 删除）。`
  }

  /** path 模式：只接受 git 认识的 worktree，避免把会话切到任意目录。 */
  _enterExisting(rawPath, cwd, key) {
    const repoRoot = repoRootOf(cwd)
    if (!repoRoot) return `当前目录不在 git 仓库里（${cwd}），无法识别 worktree。`
    const target = resolve(cwd, rawPath)
    if (!existsSync(target)) return `路径不存在：${target}`

    const list = git(repoRoot, ['worktree', 'list', '--porcelain'])
    if (!list.ok) return `读取 git worktree 列表失败：${list.stderr}`
    const registered = list.stdout.split('\n')
      .filter(l => l.startsWith('worktree '))
      .map(l => resolve(l.slice('worktree '.length).trim()))
    if (!registered.includes(target)) {
      return `${target} 不在当前仓库的 worktree 列表里，拒绝切过去。\n`
        + `已注册的 worktree：\n${registered.map(p => '  ' + p).join('\n') || '  (无)'}\n`
        + `要用别的目录，先 cd 过去或手动 git worktree add。`
    }

    // path 模式不动原 cwd 的语义：如果当前不在 worktree 会话里，
    // originalCwd 记当前目录；已经在会话里则保留最初的 originalCwd，
    // 这样连续切几次之后 ExitWorktree 仍能回到真正的起点。
    const prev = sessions.get(key)
    const state = {
      originalCwd: prev?.originalCwd || cwd,
      worktreePath: target,
      worktreeBranch: prev?.worktreeBranch || null,
      repoRoot,
      // 用 path 进来的是「别人的 worktree」，ExitWorktree 不应该删它
      enteredByPath: true,
    }
    sessions.set(key, state)
    if (this.setCwd) this.setCwd(target)
    return `已切到已有 worktree：${target}\n原目录: ${state.originalCwd}\n`
      + `注意：这个 worktree 不是你创建的，ExitWorktree 只会切回原目录，不会删除它。`
  }
}

export class ExitWorktreeTool extends Tool {
  constructor({ getCwd, setCwd } = {}) {
    super({
      name: 'ExitWorktree',
      description: [
        '退出由 EnterWorktree 创建的 worktree 会话，把工作目录切回原目录。',
        '',
        '## 范围',
        '只处理**本会话用 EnterWorktree 建的** worktree。不会碰：',
        '- 你手动 `git worktree add` 出来的',
        '- 上一个会话留下的（哪怕当时也是 EnterWorktree 建的）',
        '- 从没调过 EnterWorktree 时的当前目录',
        '不在 worktree 会话里调用 = **空操作**，只回报一句「当前没有活动的 worktree 会话」，不改任何东西。',
        '',
        '## 什么时候用',
        '- 用户明确说「退出 worktree / 离开 worktree / 回去」',
        '- **不要自己主动调**，除非用户要求',
        '',
        '## 参数',
        '- `action`（必填）：`"keep"` 保留目录和分支在磁盘上；`"remove"` 删掉目录和分支。',
        '- `discard_changes`（可选，默认 false）：只在 action="remove" 时有意义。',
        '  worktree 里有未提交文件或未合并提交时，工具会**拒绝删除**并列出它们；',
        '  确认要丢弃才传 true。**传之前先问用户**。',
        '',
        '示例：',
        '  {action:"keep"}                                    保留，切回原目录',
        '  {action:"remove"}                                  删除（干净的才能删）',
        '  {action:"remove", discard_changes:true}            连改动一起丢（先问用户）',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['keep', 'remove'], description: 'keep=保留 worktree 目录和分支；remove=删除两者' },
          discard_changes: { type: 'boolean', description: '仅 action="remove" 时有效。worktree 有未提交改动或未合并提交时必须显式传 true 才会删；传之前先跟用户确认。' },
        },
        required: ['action'],
      },
      isConcurrencySafe: () => false,
      // 官方语义：只有 action='remove' 才是破坏性的（会删目录 + 删分支）。
      // 'keep' 只是切回原目录，什么都不删。
      //
      // 【为什么必须区分】isDestructive 是权限层「要不要拦/要不要确认」的依据。
      // 一律 true 会让「切回目录」这种无害操作也被当危险动作；一律 false 则删除
      // 动作畅通无阻。官方在 claude.js 里就是按 action 判断的。
      isDestructive: (v) => v && v.action === 'remove',
      maxResultSizeChars: 100_000,
      validateInput: (input) => {
        const errors = []
        if (!['keep', 'remove'].includes(input.action)) errors.push('action 必须是 keep 或 remove')
        return { valid: errors.length === 0, errors }
      },
    })
    this.getCwd = getCwd || (() => process.cwd())
    this.setCwd = setCwd || null
  }

  async execute(input, ctx = {}) {
    const key = stateKey(ctx.sessionId)
    const state = sessions.get(key)
    if (!state) {
      // 官方语义：不在会话里就是 no-op，明确说清楚，不要报错
      return '当前没有活动的 worktree 会话（本会话没调过 EnterWorktree），未做任何改动。'
    }
    const { originalCwd, worktreePath, worktreeBranch, enteredByPath } = state

    let removedNote = ''
    if (input.action === 'remove') {
      if (enteredByPath) {
        // 用 path 进来的是别人的 worktree，删了会毁掉别人的工作
        removedNote = '（这个 worktree 不是本会话创建的，只切回原目录，未删除任何东西）'
      } else if (!existsSync(worktreePath)) {
        removedNote = `（worktree 目录已不存在：${worktreePath}，只切回原目录）`
      } else {
        // 脏检查：有未提交改动或未合并提交就拒绝
        const dirty = []
        const st = git(worktreePath, ['status', '--porcelain'])
        if (st.ok && st.stdout) dirty.push(`${st.stdout.split('\n').length} 个未提交改动`)
        if (worktreeBranch) {
          // 分支上比 base 多出的提交数。base 解析不出来就跳过这项检查。
          //
          // 为什么不用写死的 `origin/HEAD..HEAD`：没有 origin 的仓库（本地 init 的、
          // 离线克隆的）会直接 fatal，虽然被我们吞掉但会白跑一次 git。
          // 先探 origin/HEAD 在不在，在才算。
          const hasOriginHead = git(worktreePath, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD'])
          if (hasOriginHead.ok) {
            const cnt = git(worktreePath, ['rev-list', '--count', 'origin/HEAD..HEAD'])
            if (cnt.ok) {
              const n = Number.parseInt(cnt.stdout, 10) || 0
              if (n > 0) dirty.push(`${n} 个未合并提交`)
            }
          }
        }
        if (dirty.length && !input.discard_changes) {
          return `拒绝删除 worktree：${worktreePath}\n`
            + `  存在：${dirty.join('、')}\n`
            + `确认要丢弃这些工作的话，带 discard_changes:true 重试；否则用 action:"keep" 保留。\n`
            + `**丢弃前先跟用户确认**。`
        }
        const rm = git(state.repoRoot || originalCwd, ['worktree', 'remove', '--force', worktreePath])
        if (!rm.ok) {
          removedNote = `（删除 worktree 目录失败：${rm.stderr || rm.stdout}，目录仍在 ${worktreePath}）`
        } else {
          removedNote = `已删除 worktree 目录 ${worktreePath}`
          if (worktreeBranch) {
            const del = git(state.repoRoot || originalCwd, ['branch', '-D', worktreeBranch])
            removedNote += del.ok ? ` 与分支 ${worktreeBranch}` : `（分支 ${worktreeBranch} 删除失败：${del.stderr}）`
          }
        }
      }
    }

    sessions.clear(key)
    // 切回原目录。原目录被删了（用户删了整个目录）就退到仓库根，并说明。
    let restored = originalCwd
    let fallbackNote = ''
    if (!existsSync(originalCwd)) {
      restored = state.repoRoot && existsSync(state.repoRoot) ? state.repoRoot : process.cwd()
      fallbackNote = `\n原目录已不存在（${originalCwd}），退回到 ${restored}`
    }
    if (this.setCwd) this.setCwd(restored)

    return `已退出 worktree 会话\n`
      + `  原目录: ${restored}\n`
      + `  原 worktree: ${worktreePath}\n`
      + (input.action === 'keep' ? `  已保留（目录和分支都在磁盘上）` : `  ${removedNote}`)
      + fallbackNote
  }
}

/** 供 index.mjs / engine-setup 直接取状态（如 /status 显示当前 worktree）。 */
export function getWorktreeState(sessionId) {
  return sessions.get(stateKey(sessionId))
}
