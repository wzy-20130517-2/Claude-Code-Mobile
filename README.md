# Claude Code Mobile

> 在 Android 手机上跑一个 Claude Code 风格的 AI 编程助手 —— 纯 Termux 环境，无需 root，无需电脑。

一个从零实现的 AI Agent 客户端，对齐 Anthropic 官方 Claude Code 的交互习惯与工具协议，
但完全独立开发、运行在 Android/Termux 上。

---

## 这是什么

Claude Code Mobile（简称 CCM）是一个**运行在 Android 手机上的命令行 AI 编程助手**。

它长这样：

```
❯ 帮我看看 core/api/api.mjs 里的重试逻辑

● Read (core/api/api.mjs)
  ⎿ 1: // Claude Code Mobile - API 客户端
    2: import { ...

∴ Thinking…
  用户想看重试逻辑，先读文件找到相关代码…

● api.mjs 里的重试分三层，我来梳理一下：

  1. **连接层**（STREAM_CONNECT_TIMEOUT = 150s）—— 只管建连阶段
  2. **API 层**（maxRetries = 3）—— 内部退避重试
  3. **Agent 层** —— 只在特定错误类型上重试

  ⚠️ 这三层会叠加放大：一次 60s 超时实际可能跑 687 秒。
```

**它不是 Anthropic 官方产品**，而是一个独立实现（开源复刻），与 Anthropic 无隶属关系。

真正回答你问题的模型由你 `/config` 切换 Provider 决定（Claude / GLM / MiniMax 等任意兼容接口），且会经常更换。

---

## 三端架构

| 端 | 技术栈 | 代码仓库 | 状态 |
|---|---|---|---|
| **CLI** | Node.js (ESM) | [wzy-20130517-2/Claude-Code-Mobile](https://github.com/wzy-20130517-2/Claude-Code-Mobile) | ✅ 主力开发 |
| **Web** | React + TypeScript + Vite | 同仓库 `web/` 目录 | ✅ 共用核心代码、独立进程 |
| **APK** | Kotlin + Jetpack Compose | [wzy-20130517-2/ccm-android](https://github.com/wzy-20130517-2/ccm-android) | ✅ 原生重写、零共享内核 |

> **注意**：APK 与 CLI **不是同一内核**（旧架构已废弃）。唯一共用的是 `dsh-host` 插件宿主（npm 包）。

---

## 核心能力

### Agent 层（你正在用的这一层）
- **工具调用**：118+ 个内置工具（文件、Shell、Git、GitHub、手机操作、网络搜索、多模态、任务编排…）
- **Slash 命令**：116 个（`/config` `/model` `/compact` `/goal` `/qq` `/imagegen` 等）
- **多 Provider**：OpenAI 兼容 / Anthropic / Gemini / 自定义，Key 池自动轮换
- **会话持久化**：自动保存、撤销（`/undo`）、回收站、压缩快照
- **子 Agent 编排**：并行派活、团队协作、跨会话记忆、任务交接
- **目标模式** (`/goal`)：完成契约驱动的自主执行循环
- **Hooks 系统**：12 个事件点（PreToolUse/Stop/UserPromptSubmit…），可阻断/注入/改写

### 手机操作
- **双模式**：前台（占用主屏） / 后台（虚拟副屏，静默）
- **元素树优先**：`phone_snapshot` 文本树（毫秒级），仅 WebView/Flutter/Canvas 等回退截图识图
- **息屏可用**：Shizuku/adb 通道不依赖屏幕亮灭
- **中文输入**：`phone_type` 剪贴板粘贴（`input text` 对中文无效）

### 多模态
- **图片**：发图直接识别（ViewImage），或截屏/相册/网页抓取
- **视频**：关键帧抽取分析
- **文档**：PDF/Office 解析

### 其它
- **QQ 桥**：私聊/群 @ 唤醒，消息双向同步
- **MCP 支持**：stdio / SSE / HTTP，已内置 mail-qq / playwright / rea 等
- **Skills 系统**：项目级 + 全局技能，按需延迟加载

---

## 快速开始

### 前置要求
- Android 7.0+
- [Termux](https://github.com/termux/termux-app) (F-Droid 版或 GitHub Release)
- **Shizuku**（强烈推荐，手机操作走它，免 root、免 adb）
  - 或打开「USB 调试」+「USB 调试(安全设置)」让 Termux 自动走本机 adb 回环

### 安装
```bash
# 在 Termux 里
pkg install git nodejs python3
git clone https://github.com/wzy-20130517-2/Claude-Code-Mobile.git
cd Claude-Code-Mobile
npm install
node index.mjs  # 启动 CLI
```

首次启动会进入向导配置 Provider（API Key / Base URL / Model）。

### 启动 Web 端（可选）
```bash
cd web
npm install
node server.mjs  # 启动 Web 服务（端口见 web/package.json）
```

### 安装 APK（可选）
去 [ccm-android Releases](https://github.com/wzy-20130517-2/ccm-android/releases) 下载最新 `CCM-N.apk` 安装。
> APK 独立运行，不依赖 Termux，但功能与 CLI 对齐。

---

## 常用命令速查

| 类别 | 命令 | 说明 |
|---|---|---|
| **配置** | `/config` | 列出/切换/新增/测试 Provider |
| | `/model <id> <name>` | 改模型 |
| | `/url <id> <url>` | 改 Base URL |
| | `/key <id> <sk...>` | 单 Key / `pool k1 k2` 轮换池 |
| **会话** | `/clear` | 新会话（旧会话存档，`/resume <id>` 找回） |
| | `/resume` | 列出历史会话选一个接回 |
| | `/compact [N]` | 压缩上下文（`N`=阈值 token） |
| | `/replay on/off` | 进会话时是否回放历史正文 |
| **手机** | `/device` | 看通道/模式/副屏状态 |
| | `/device mode fg/bg/off` | 切前台/后台/不操作手机 |
| | `/keepalive on/off/status` | 息屏保活（wake-lock + 静音音频） |
| **QQ** | `/qq setup` | 向导配 QQ 机器人 |
| | `/qq open on/off` | 放行模式（群 @ 全唤醒） |
| **目标** | `/goal <目标>` | 启动完成契约自主执行 |
| **其它** | `/font <system|jetbrains|maple>` | 换终端字体 |
| | `/help` | 帮助 |
| | `/style <文本>` | 设置回复偏好（自由文本） |
| | `/memory` | 读写 CLAUDE.md 记忆 |

> 完整列表输 ` / ` 补全或看 `/help`。

---

## 项目结构

```
claude-code-mobile/
├── index.mjs                 # 入口（~8000 行）
├── package.json
├── core/
│   ├── agent/               # Agent 循环、工具调用、子 Agent、记忆
│   ├── commands/            # 116 个 slash 命令实现
│   ├── infra/               # API 客户端、提示词组装、权限、引擎
│   ├── phone/               # 手机操作工具实现
│   ├── session/             # 会话持久化、压缩、回收站
│   ├── tools/               # 118+ 个工具实现
│   └── ...
├── web/
│   ├── server.mjs           # Express + SSE 服务端
│   ├── src/                 # React + TS 前端
│   └── package.json
├── skills/                  # 项目技能（延迟加载）
├── .claude-code-mobile/     # 用户数据目录（运行时自动创建）
│   ├── config.json          # Provider 配置
│   ├── sessions/            # 会话文件
│   ├── memory/              # 子 Agent 记忆
│   └── trash/               # 回收站 / 撤销快照
└── README.md
```

> **源码与数据完全分离**：代码在 `~/claude-code-mobile/`，用户数据在 `~/.claude-code-mobile/`。找 config.json / sessions / CLAUDE.md 一律去数据目录。

---

## 规模数据（2026-11-19 实测）

| 模块 | 文件数 | 行数 |
|---|---:|---:|
| CLI 入口 (`index.mjs`) | 1 | 8,051 |
| CLI 核心 (`core/`) | 185 | 59,220 |
| **CLI 小计** | **186** | **~67,300** |
| Web 服务端 (`web/server.mjs`) | 1 | 4,049 |
| Web 前端 (`web/src/`) | 73 | 28,087 |
| **Web 小计** | **74** | **~32,100** |
| APK (`app/src/main/java`) | 194 | 82,965 |
| **合计** | **454** | **~182,000** |

- 命令：116 个
- 工具：~118 个（含 phone / github / task / team / session / termux / goal 七组 + 单独注册）
- Skills：5 个项目技能 + 10 个全局技能

---

## 开发/贡献

### 运行测试
```bash
node --check index.mjs           # 语法检查
# 全量语法检查（npm 不支持 glob，用 find）
find core -name '*.mjs' -exec node --check {} +
```

### APK 编译验证
**本机不能跑 Gradle**（CPU 100%、Compose 卡死）。唯一验证途径：
```bash
# 推送到 ccm-android 仓库，等 GitHub Actions
cd ~/ccm-android
git push origin main
# 然后去 https://github.com/wzy-20130517-2/ccm-android/actions 看构建
```

> 如需推送且 GitHub 被墙，见下文「推送绕墙」。

### 推送绕墙（github.com TCP 层阻断）
```bash
# 1. 探测可用 IP
for ip in 140.82.112.3 140.82.114.3 140.82.116.3 140.82.113.4; do
  echo -n "$ip → "
  timeout 8 bash -c "cat < /dev/null > /dev/tcp/$ip/443" 2>/dev/null && echo 通 || echo 不通
done
# 2. curl 复核 TLS 能过
curl -s -o /dev/null -w "%{http_code} (%{time_total}s)\n" --max-time 15 \
  --resolve "github.com:443:<可用IP>" https://github.com/
# 3. 推送（临时传 resolve，不写进 config）
git -c http.curloptResolve="github.com:443:<可用IP>" push -u origin main
```

> 大仓库先 `git config http.postBuffer 157286400`，推送放后台跑（`nohup ... &`）。

---

## 致谢 / 站在巨人肩上

- [Anthropic Claude Code](https://github.com/anthropics/claude-code) —— 交互习惯与工具协议的对齐参照
- [DeepSeek DSH 插件生态](https://github.com/topics/dsh-plugin) —— 插件宿主架构参考（`dsh-host` npm 包）
- [ZCode](https://github.com/zcode-ai/zcode) / [OpenClaw](https://github.com/openclaw/openclaw) / [Kimi Code](https://github.com/moonshotai/kimi-code) / [OpenCode](https://github.com/opencode-ai/opencode) —— 对标实现
- [Termux](https://termux.dev/) / [Shizuku](https://github.com/RikkaApps/Shizuku) / [KernelSU](https://github.com/tiann/KernelSU) —— 运行环境
- [MNN](https://github.com/alibaba/MNN) / [llama.cpp](https://github.com/ggerganov/llama.cpp) / [ggml](https://github.com/ggerganov/ggml) —— 本地推理后端参考

> 注：本项目为**独立实现**，与上述项目均无隶属关系，也未包含它们的代码。
> `dsh-host` 通过 npm 依赖使用官方包，插件由各自的作者维护。

---

## 许可

**MIT** — 随意用、改、发、闭源商用，保留版权声明即可。

---

## 免责声明

- **非官方产品**，与 Anthropic 无任何关联
- 底层模型由你自行配置 Provider 决定，本项目不提供、不代理、不担保任何模型服务
- 手机操作权限大（Shizuku/adb），请仅在可信设备上运行，自行承担风险
- 代码在快速迭代，API/配置/命令可能变动，以代码为准