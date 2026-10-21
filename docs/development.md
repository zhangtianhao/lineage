# Lineage 开发指南

本文说明如何在本地构建、调试、测试和打包 Lineage，以及修改代码时需要遵守的约定。模块结构和设计原因见 [architecture.md](./architecture.md)。

## 1. 环境

- Node.js：已用 Node 22 验证。
- 系统 git：位于 PATH 中，扩展运行和 git 相关测试都依赖它。
- VSCode：任意不低于 1.74 的版本，或基于 VSCode 的编辑器（例如 Trae）。

```bash
npm ci
```

## 2. 常用命令

| 命令 | 作用 |
|---|---|
| `npm run compile` | 用 `tsc` 编译到 `out/` |
| `npm run watch` | 监听模式编译，F5 调试时会自动启动 |
| `npm run lint` | ESLint 检查 `src/` |
| `npm test` | 先编译和 lint，再用 mocha 运行 `out/test/unit/**/*.test.js` |
| `npm run package` | 用 vsce 打包出 `lineage-<version>.vsix` |

## 3. 调试（F5）

1. 用 VSCode 打开本仓库，按 F5 选择 "Run Extension"，会先启动 `watch` 任务，再打开一个 Extension Development Host 窗口。
2. 在该窗口中打开任意 git 仓库里的文件，并信任该工作区（受限模式下扩展不加载）。
3. 在行号上右键，点击 `Annotate with Git Blame`。
4. 查看日志：输出面板中选择 **Lineage** 通道。默认只显示 Info 及以上级别；要观察每次 git 调用（例如确认防抖是否生效），点击面板右上角的"设置日志级别"按钮，选择 **Debug**。

修改代码后，在 Extension Development Host 中执行 `Developer: Reload Window` 即可加载新代码。

## 4. 测试

`npm test` 只运行单元测试，不会下载 VSCode 实例：

| 文件 | 覆盖内容 |
|---|---|
| `src/test/unit/blameParser.test.ts` | porcelain 解析：连续行、未提交行、`previous`/`boundary`、源码内容形似头行、64 位 sha、空 summary、格式错误和输出截断 |
| `src/test/unit/format.test.ts` | 日期与时区、显示宽度、截断、注释总宽度固定为 50、NBSP |
| `src/test/unit/git.test.ts` | 在临时目录中真实运行 git：`--contents` 下的未提交行、非 git 目录、cwd 不存在 |

`git.test.ts` 会自行 `git init` 临时仓库，提交时带 `-c commit.gpgsign=false` 和 `--no-verify`，不受开发者全局 git 配置（提交签名、全局钩子）的影响。修改该测试后，可以用一份"有问题"的全局配置检验它是否仍然独立：

```bash
GIT_CONFIG_GLOBAL=/path/to/hostile-gitconfig node node_modules/mocha/bin/mocha.js
```

菜单、渲染和悬停等交互行为没有自动化测试，发布前按 §7 的清单手工验收。

## 5. 打包

```bash
npm run package
npx vsce ls      # 确认包内容
```

- 包中只应包含 `package.json`、`README.md`、`CHANGELOG.md`、`icon.png` 和 `out/` 下的运行时 JS；`src/`、`docs/`、测试、source map 都由 `.vscodeignore` 排除。
- 打包参数 `--allow-missing-repository --skip-license` 是因为目前没有配置 `repository` 字段和 LICENSE 文件。如果以后添加了这两项，可以去掉对应参数。
- 本扩展不发布到 Marketplace。安装方式：在 VSCode 扩展视图中选择"从 VSIX 安装…"，或执行 `code --install-extension lineage-<version>.vsix`。

## 6. 图标

`icon.svg` 是源文件，`icon.png` 由它生成。vsce 不允许扩展图标使用 SVG，所以 `package.json` 中引用的是 PNG，`icon.svg` 不会进入 vsix。

修改 SVG 后，用 Chrome 无头模式按 2 倍分辨率重新生成 256×256、背景透明的 PNG：

```bash
{ echo '<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:128px;height:128px}</style>'; cat icon.svg; } > /tmp/icon.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=2 --default-background-color=00000000 \
  --window-size=128,128 --screenshot="$PWD/icon.png" file:///tmp/icon.html
```

Chrome 运行时可能输出若干 `task_policy_set` 错误日志，不影响结果。

## 7. 发布前的手工验收清单

- [ ] 在 git 仓库文件中右键行号，出现 `Annotate with Git Blame`；点击后行首出现"作者 / 日期 / 摘要"，各列对齐，过长内容以 `…` 结尾。
- [ ] 再次右键显示 `✓ Annotate with Git Blame`；点击后注释消失。
- [ ] 开启状态下执行 `Developer: Reload Window`，注释和 ✓ 自动恢复。
- [ ] 悬停在行首注释上，显示短 hash、作者、完整日期时间和完整 commit message；未提交行显示"未提交的更改"。
- [ ] 编辑但不保存，修改的行约 300ms 后显示"未提交"，不报错；Debug 日志中 git blame 的调用次数远少于按键次数。
- [ ] 打开非 git 目录中的文件和 untitled 文件：没有注释、没有弹窗，日志中有记录。
- [ ] `npm test` 和 `npm run package` 通过。

## 8. 代码约定

- **不引入运行时依赖**：`package.json` 中不应出现 `dependencies`。
- **不弹窗**：不调用 `show*Message`，错误只写日志。
- **只用 `execFile` 调用 git**，参数以数组传入，禁止拼接 shell 字符串。
- **纯逻辑与 `vscode` 隔离**：`blameParser.ts`、`format.ts` 不得 import `vscode`。
- **异步链路必须自行 catch**，原因见 architecture.md §3.8。
- **API 兼容性**：`engines.vscode` 为 `^1.74.0`，以便 Trae 等基于旧版 VSCode 的编辑器也能安装。因此 `@types/vscode` 固定为 `1.74.0`、`@types/node` 为 `16.x`（与 VSCode 1.74 自带的 Node 版本一致），这样误用新版 API 时编译就会报错。不要升级这两个类型包，除非同时提高 `engines.vscode`。
- **注释与文档**：使用中文；代码注释只解释 WHY，不复述代码在做什么。
