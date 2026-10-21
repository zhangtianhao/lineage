# Lineage 架构说明

本文说明 Lineage 的模块划分、运行流程，以及几项关键设计背后的原因，供维护和修改代码的人阅读。使用方法见 [README](../README.md)，本地开发流程见 [development.md](./development.md)。

## 1. 总体结构

```
┌──────────────────────── VSCode 主进程 / 渲染进程 ────────────────────────┐
│  行号栏右键菜单 ──(when: lineage.blameEnabled)──► enable / disable 命令   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ IPC
┌──────────────────── Extension Host 进程（扩展运行于此） ─────────────────┐
│ extension.ts       装配与生命周期                                         │
│   ├─ state.ts        开关状态：globalState 持久化 + setContext + 事件      │
│   ├─ controller.ts   监听编辑器与文档事件，缓存 + 防抖，渲染装饰           │
│   │    ├─ git.ts          execFile('git', [...])          ──► 系统 git    │
│   │    ├─ blameParser.ts  【纯函数】porcelain 输出 → BlameLine[]          │
│   │    └─ format.ts       【纯函数】日期、显示宽度、截断、注释文本         │
│   ├─ hover.ts        悬停详情，懒加载完整 commit message                  │
│   └─ logger.ts       LogOutputChannel "Lineage"                          │
└──────────────────────────────────────────────────────────────────────────┘
```

`blameParser.ts` 和 `format.ts` 不 import `vscode`，所以可以直接在普通 Node 中用 mocha 测试；所有副作用都集中在 `controller.ts` 和 `hover.ts`。**新增逻辑时请保持这条边界**，否则 `npm test` 会因找不到 `vscode` 模块而失败。

## 2. 模块职责

| 文件 | 职责 |
|---|---|
| `extension.ts` | 创建各对象，每创建一个就立即放入 `context.subscriptions`，注册两个命令和 HoverProvider。 |
| `state.ts` | `ToggleState`：读写 `globalState` 中的 `lineage.blameEnabled`，同步同名上下文键，并通过 `onDidChange` 广播变化。 |
| `controller.ts` | `BlameController`：持有装饰类型、blame 缓存、计算中任务和防抖计时器；对外提供 `getBlameLine` 供悬停查询。 |
| `git.ts` | `execGit`、`runBlame`、`getCommitMessage`，以及表示 git 失败的 `GitError`。 |
| `blameParser.ts` | `parseLinePorcelain`：用状态机解析 `git blame --line-porcelain` 的输出。 |
| `format.ts` | `formatDate`、`formatDateTime`、`displayWidth`、`fitToWidth`、`formatAnnotation`、`shortSha`。 |
| `hover.ts` | `BlameHoverProvider`：悬停在行首注释上时显示完整信息。 |
| `logger.ts` | 对 `LogOutputChannel` 的薄封装。 |

## 3. 关键设计决策

### 3.1 菜单"勾选"用两个命令模拟

VSCode 扩展的命令和菜单贡献点都不支持 `toggled` 字段，它只是 VSCode 内部属性，写进 `package.json` 会被忽略。因此扩展注册了两个命令：

| 命令 | 菜单标题 | 显示条件 |
|---|---|---|
| `lineage.enableBlame` | `Annotate with Git Blame` | `!lineage.blameEnabled` |
| `lineage.disableBlame` | `✓ Annotate with Git Blame` | `lineage.blameEnabled` |

两条菜单项位于同一 group 和同一位置，任一时刻只显示一个，用户看到的就是"同一个菜单项的勾选状态在变化"。两个命令都在 `commandPalette` 中通过 `"when": "false"` 隐藏。

### 3.2 激活时机：`onStartupFinished`

只靠命令激活的话，开关持久化为"开"时，重启后扩展要等用户点击菜单才会激活：注释不会自动恢复，而且上下文键未定义，菜单会错误地显示为未勾选。`onStartupFinished` 在启动完成后才激活，不会拖慢 VSCode 启动；而 `"*"` 会在启动阶段同步激活。

### 3.3 对编辑器当前内容做 blame

`runBlame` 执行的命令是：

```
git blame --line-porcelain --contents - -- <basename>
```

cwd 为文件所在目录，编辑器当前内容通过 stdin 传入。不加 `--contents -` 时 git 只读磁盘文件，未保存的编辑会让行号错位。新增或修改的行在 git 输出中 sha 全为 0，显示为"未提交"。

所有 git 调用都使用 `execFile` 并以参数数组传参，不经过 shell。路径只传 basename，并放在 `--` 之后，即使文件名以 `-` 开头也不会被当作选项。

`execGit` 还处理了以下细节：

- `maxBuffer` 设为 64MB，因为默认值只有 1MB，大文件的输出会超出；`timeout` 设为 15 秒。
- 给 stdin 挂上 `'error'` 监听：git 提前退出时，写入 stdin 会触发 EPIPE，不挂监听就会变成未处理异常。
- 调用前先检查 cwd 是否存在。目录不存在时，`spawn` 同样报 `ENOENT`，容易被误判为"未安装 git"。

### 3.4 缓存、防抖与过期结果

controller 内部维护以下状态，key 都是 `document.uri.toString()`：

| 状态 | 作用 |
|---|---|
| `cache` | 按文档 `version` 缓存 blame 结果。`lines: null` 是负缓存：git 失败后，同一 version 不再重试。 |
| `inflight` | 计算中的任务 `{ version, promise }`，避免同一 version 被重复计算。 |
| `timers` | 每个文档一个 300ms 防抖计时器。 |
| `generation` | 每次开关变化加 1，用来丢弃跨越开关切换的旧结果。 |

处理流程：

1. **切换或打开编辑器**（`onDidChangeVisibleTextEditors`）：缓存的 version 与文档一致时直接渲染，不执行 git；否则开始计算。
2. **内容变化**（`onDidChangeTextDocument`）：只处理可见文档，重置防抖计时器，到期后再计算。等待期间保留旧注释，以免每次输入都闪烁。
3. **计算完成时**，以下任一情况都直接丢弃结果，不写缓存：期间开关被切换过（generation 不同）、文档已关闭、文档 version 已经变化。
4. 完成后只删除属于自己的 `inflight` 记录（按 promise 引用比较），不会误删更新版本的计算。

### 3.5 以"装饰类型是否存在"作为激活判断

`ToggleState.set(true)` 会依次保存状态、调用 `setContext`、发出事件。在等待期间，`state.enabled` 已经是 true，但 controller 还没有创建装饰类型。因此 controller 内部用 `active`（`decorationType !== undefined`）判断是否开启，而不是读 `state.enabled`，从而避免在这段时间里渲染出错。唯一的例外是构造函数：重启恢复时还没有装饰类型，只能读取 `state.enabled`。

### 3.6 渲染

开启时创建一个 `TextEditorDecorationType`，通过 `before` 在每行第 0 列前插入文本。关闭时直接 dispose 它，VSCode 会把它从所有编辑器上移除。

注释文本由 `formatAnnotation` 生成，三列宽度如下，总宽固定为 `ANNOTATION_WIDTH = 50`：

```
作者(12)  日期 yyyy/MM/dd(10)  摘要(24)
```

- 列宽按显示宽度计算：东亚宽字符算 2 列，其余算 1 列（包括省略号 `…`）。
- `fitToWidth` 只负责截断：先去掉截断处的尾部空白，再加上 `…`。补齐由 `padRight` 完成。
- 所有空格都替换为 NBSP（`\u00A0`），因为 `contentText` 会被注入 DOM，连续的普通空格会被折叠。CSS `width: 50ch` 再做一层兜底。
- 日期按作者时区换算后用 `getUTC*` 读取，结果与运行环境的本地时区无关。

### 3.7 悬停

`BlameHoverProvider` 注册在 `{ scheme: 'file' }` 上。鼠标悬停在 `before` 注入的文本上时，VSCode 报告的位置是该行第 0 列（已在 F5 中实测确认），因此只处理 `position.character === 0` 且缓存 version 与文档一致的情况。

- 未提交行显示"未提交的更改"。
- 已提交行显示短 hash、作者、邮箱、完整日期时间，以及完整 commit message。message 通过 `git log -1 --format=%B <sha>` 懒加载，按 sha 缓存，关闭功能时清空；获取失败时回退为 summary。
- 作者、邮箱和 message 都是外部输入，一律用 `appendText` 追加（自动转义），`isTrusted` 保持 false。

副作用：悬停在代码本身第 0 列的字符上也会触发，与 GitLens 的行为一致。

### 3.8 错误处理

遇到错误时不弹窗打扰用户，只写入 "Lineage" 输出通道：

| 场景 | 处理 |
|---|---|
| 未安装 git（`ENOENT`） | warn 日志 + 负缓存 |
| 非 git 目录、未跟踪文件、仓库还没有提交（git exit 128） | warn 日志 + 负缓存 |
| 文件所在目录不存在 | 不启动 git，warn 日志 + 负缓存 |
| 输出超过 maxBuffer 或超时 | warn 日志 + 负缓存 |
| untitled、diff 视图等非 `file` scheme | 不调用 git，清空装饰 |
| 解析或渲染异常 | error 日志 |

**所有异步链路都必须自己 catch。** 新版 VSCode 中扩展宿主运行在 utility 进程里，未处理的 Promise rejection 会让整个扩展宿主 `abort()`，表现为窗口闪退。命令回调中的 `state.set(...)`、`startCompute` 中的计算与渲染、清理 inflight 的 `finally` 链都已经处理好，新增异步代码时请保持这一点。

### 3.9 工作区信任

`capabilities.untrustedWorkspaces.supported` 为 false：在不受信任的仓库中运行 git，可能执行该仓库 `.git/config` 中配置的命令。`virtualWorkspaces` 为 false：虚拟文件系统上没有可用的本地 git 仓库。

## 4. 资源生命周期

| 资源 | 创建 | 释放 |
|---|---|---|
| Logger、ToggleState、BlameController、HoverProvider 及其注册、两个命令 | `activate` | `context.subscriptions` |
| controller 和 hover 内部的事件订阅 | 构造函数 | 各自的 `dispose()` |
| DecorationType | 开启时 | 关闭时，以及 `controller.dispose()` |
| 防抖计时器 | 文档变化时 | 到期、关闭功能、文档关闭、dispose |
| cache / inflight 条目 | 计算时 | 文档关闭、关闭功能 |
| commit message 缓存 | 悬停时 | 关闭功能、dispose |

`deactivate()` 为空，因为所有资源都已在 `context.subscriptions` 中。

## 5. 已知限制

1. VSCode 没有开放在行号栏中绘制文本的 API，注释只能以 `before` 装饰插入到代码前面，代码因此整体右移。
2. 菜单的勾选效果由标题中的 `✓` 字符模拟，不是原生勾选框。
3. 开关状态在多个窗口之间不会实时同步，其他窗口重新加载后才会生效。
4. 在终端执行 commit 等外部 git 操作后，已缓存的注释不会自动更新；文档内容变化、重新打开文件或重新开关功能后才会刷新。
5. 东亚字符宽度是近似计算，在少数字体下列可能不完全对齐。
