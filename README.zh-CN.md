<p align="center"><img src="media/markyou-logo.png" alt="MarkYou" width="104"></p>

<h1 align="center">MarkYou</h1>

<p align="center"><strong>像写文档一样写 Markdown，文件仍然是普通 <code>.md</code>。</strong><br>
面向 VS Code 的本地优先、点击即编辑 Markdown 编辑器：可编辑多文件文档、离线 PDF 导出，无需账号。</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://github.com/singerawei/markyou/releases"><img src="https://img.shields.io/github/v/release/singerawei/markyou?label=release&style=flat-square" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square" alt="Windows x64">
  <img src="https://img.shields.io/badge/VS%20Code-1.100%2B-007ACC?style=flat-square" alt="VS Code 1.100+">
  <img src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" alt="MIT">
</p>

<p align="center"><img src="media/markyou-hero.png" alt="MarkYou 正在编辑包含表格、Callout 与高亮代码块的 Markdown 文档" width="100%"></p>

MarkYou 把普通的 `.md` 文件变成 VS Code 中点击即可编辑的文档。每次保存都会把 Markdown 写回真正拥有该内容的文件，因此 Git、文本编辑器以及其它 Markdown 工具都能继续使用。没有私有格式、数据库或遥测。

## 为什么选择 MarkYou

- **Markdown 进，Markdown 出。** 渲染结果与源文件始终同步；不支持的语法会原样保留，而不是被压平。
- **Include 可直接编辑。** 用 `@import` 把多个文件组合成一篇文档，直接编辑被引入的章节，保存时只写回真正变化的文件。
- **保持渲染态。** 表格、代码、图表和复杂块在编辑时始终保持渲染效果。
- **本地优先。** 无登录、无账号、无云服务；唯一的网络请求来自文档中的远程图片。
- **离线 PDF。** 内置 Chromium 直接导出 PDF，无需安装 Chrome 或 Edge。
- **长文档依然从容。** 大文档分批加载、只在视口附近渲染；超大块回退到原生文本编辑器。

## 功能亮点

| | |
| --- | --- |
| **点击即编辑** | 段落、标题、列表、表格、任务列表、引用、代码块和链接都能原位编辑。 |
| **表格 2.0** | 10×10 尺寸选择、行列前后插入、整列对齐、从 Excel/飞书粘贴 TSV、复制 TSV/Markdown、超大表格只读预览。 |
| **连续写作** | 连续输入合并为一次撤销；连按两次 `Ctrl/Cmd+A` 全选文档；复制得到保留 `@import` 的纯 Markdown。 |
| **可信状态** | 常驻状态条显示当前文件与保存状态；只读横幅会禁用所有编辑入口。 |
| **复杂语法直达** | 通过表单插入数学公式、脚注、Callout、Admonition、定义列表、TOC、Wiki 链接和 Frontmatter，并实时渲染。 |
| **查找 2.0** | 搜索渲染后的可见文本（不含 `**` 等标记）、就地高亮全部命中、替换当前/全部并可撤销、大纲过滤。 |
| **丰富渲染** | GFM 表格、任务列表、KaTeX 数学公式、脚注、GitHub Alerts、Obsidian Callouts、定义列表、TOC、Wiki 链接、高亮、上下标、Emoji、Frontmatter 和安全 HTML。 |
| **Mermaid** | 本地渲染与缓存；复制、编辑、缩放、按行号提示错误并重试、导出 SVG/PNG、主题切换后自动重绘。 |
| **PDF 导出** | 纸张、边距、字号、页眉页脚、页码和 H1 分页；包含未保存的修改。 |
| **显示设置持久化** | 字号、窄/标准/宽阅读宽度、专注模式和只读状态在重启后保留。 |
| **键盘优先** | 常用操作都是 VS Code 命令，可在「键盘快捷方式」中重新映射。 |

## 1.1 更新

- TSV 支持带引号的换行单元格，保留空格、前导零和反斜杠；支持 HTML 表格粘贴，单元格换行保存重开后继续按 GFM 编辑。首行为固定表头。
- 替换按来源、块、命中范围和版本校验，可逐次命中导航；多文件全部替换先审查范围。
- 全文复制等待完整根文件模型，保留公式、注释、元数据和 `@import`；只读也可复制。
- 未应用的复杂块、Mermaid、HTML 草稿持久化恢复；Ctrl+S 应用并保存，不直接覆盖磁盘。
- “更多 → 导出完整 Markdown…”展开 Include 并复制本地资源；右键阅读块可复制、删除、上下移动。
- 只读状态按文档保存；新增默认只读、资源目录设置及中文主要界面控件。

## 安装

**要求：** Windows x64，VS Code 1.100 或更高版本。无需单独安装 Chrome 或 Edge。

1. 从 [GitHub Releases](https://github.com/singerawei/markyou/releases) 下载 `markyou-win32-x64-1.1.0.vsix`。
2. 在 VS Code 中打开「扩展」，点击 **… → 从 VSIX 安装…**，选择该文件。
3. 重新加载 VS Code。
4. 右键任意 `.md` 文件，选择 **打开方式… → MarkYou**。

<details>
<summary>从源码构建</summary>

```sh
git clone https://github.com/singerawei/markyou.git
cd markyou
npm ci
npx playwright install chromium-headless-shell
npm run package
```

发布工具需要 Node.js 22 或更新版本。生成的 VSIX 可直接安装。
</details>

## 快速开始

1. 用 **打开方式… → MarkYou** 打开 `.md` 文件。
2. 点击任意块进行编辑。`Ctrl/Cmd+S` 保存，`Ctrl/Cmd+Shift+S` 执行 **另存为副本**。
3. 把多个文件组合成一篇文档：

   ```markdown
   # 系统设计

   @import "./product/overview.md"
   @import "./architecture/system.md"
   @import "./features/payment.md"
   ```

   直接编辑渲染后的章节；保存时只会写回发生变化的源文件。
4. 用 `Ctrl/Cmd+Shift+O` 导航，用 `Ctrl/Cmd+Alt+I` 插入块，通过 **More → Export PDF** 导出。

## Markdown 支持

| 语法 | 编辑方式 |
| --- | --- |
| CommonMark 标题、段落、强调、代码、引用、列表、分隔线 | ✅ 原位编辑 |
| GFM 表格、对齐、任务列表、删除线、自动链接 | ✅ 原位编辑 |
| 高亮 `==文本==`、上下标、Emoji | ✅ 原位编辑 |
| 安全 HTML（`kbd`、`mark`、`details`、`sub`、`sup` 等） | ✅ 渲染态 contenteditable，已净化 |
| 数学 `$...$`、`$$...$$` | ✅ KaTeX，块编辑器带实时预览 |
| 脚注、引用式链接、定义列表、缩写 | ✅ 富渲染，块编辑器带实时预览 |
| GitHub Alerts、Obsidian Callouts、Admonitions | ✅ 富渲染，支持自定义标题与折叠 |
| TOC、Wiki 链接、Obsidian 注释、Frontmatter | ✅ 富渲染 |
| Mermaid | ✅ 本地渲染 |
| 远程图片 | ✅ 打开即加载；导出 PDF 时下载并内嵌 |

## 快捷键

| 操作 | Windows / Linux | macOS |
| --- | --- | --- |
| 保存 / 另存为副本 | `Ctrl+S` / `Ctrl+Shift+S` | `Cmd+S` / `Cmd+Shift+S` |
| 查找 | `Ctrl+F` | `Cmd+F` |
| 大纲 / 导航 | `Ctrl+Shift+O` | `Cmd+Shift+O` |
| 插入 | `Ctrl+Alt+I` | `Cmd+Alt+I` |
| 专注模式 | `Ctrl+Alt+F` | `Cmd+Alt+F` |
| 隐藏工具栏 | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| 帮助 | `?` 或 `Ctrl+Alt+H` | `?` 或 `Cmd+Alt+H` |

所有快捷键都是 VS Code 命令，可重新映射。完整列表与宿主冲突说明见 **MarkYou: Help**。

## 注意事项

- 仅支持本地 `.md` 文件。远程/虚拟文件系统、云同步和账号功能不在当前范围内。
- **另存为副本** 会写出根文件的副本，并继续保持编辑当前文档；副本必须位于同一目录，以维持相对 `@import` 路径。
- 超出编辑上限的块会回退到文本编辑器：代码 128 KiB、正文 16 KiB、表格 200 行。超大表格会保留只读预览，并提供明确的「在文本编辑器中编辑」操作。
- Wiki 嵌入 `![[Page]]` 以可点击卡片呈现，而不是完整的全文转嵌。
- 1.1.0 面向 Windows x64，暂不包含 macOS/Linux 构建。

## 开发

```sh
npm ci
npm run check        # lint、类型检查、核心测试、构建
npx playwright install chromium
npm run test:ui      # UI 测试
npm run test:host    # 真实 VS Code 宿主测试
npm run package      # 构建 VSIX
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 自动发布

Marketplace 插件身份为 `singeraw.markyou`。只有成功发布到 Marketplace 后，VS Code 才会通过正常扩展更新机制更新已安装插件；仅上传 GitHub 不会同步 Marketplace。之前以 `markyou.markyou` 标识安装的本地测试包属于另一扩展，安装当前发布者的版本时应先卸载旧测试包。

1. 在 `singeraw` 发布者的 **Trusted Publishing** 中创建策略：Repository owner 为 `singerawei`、Repository 为 `markyou`、Workflow 为 `ci.yml`、Environment 为 `marketplace`。Actions 通过 `id-token: write` 申请 OIDC 身份，执行 `vsce publish --oidc`；无需保存发布令牌。
2. 同步更新版本、锁文件、README 和更新日志。推送 `v1.1.0-preview.1` 将数字版本 `1.1.0` 发布到预览通道。后续稳定版须使用不同的数字版本，例如 `1.2.0`，并推送匹配的稳定标签；不能将已经发布的预览版本号直接复用为稳定版。预览 VSIX 在测试前即写入预览标记。
3. Actions 执行 Linux/Windows 检查、UI 测试、Windows 打包、品牌审计和真实 VS Code 安装包测试，再将同一份 VSIX 发布到 GitHub Release 和 Marketplace。Release 只附带 VSIX、README；测试报告仅保留为短期 Actions 产物。
4. 稳定版保留真人输入法、用户任务、PDF、恢复和性能验收门禁。下载 `markyou-vsix` 产物实测，把匹配包哈希的 `acceptance.json` 附到该标签的草稿 Release，然后只重跑失败的 acceptance 作业。证据缺失或过期时禁止稳定发布。
5. Marketplace 步骤失败时，检查发布者策略中的仓库、工作流和环境名称是否完全一致，再重跑失败作业。`.gitignore` 排除了 VSIX、Chromium、依赖、评审记录、测试报告和凭据；VSIX 作为 Release 附件提供。

若预览 Release 已成功生成，但 Marketplace 作业被跳过，可手动运行 `ci.yml`，把 `publish_preview_run` 设为原成功发布流程的数字运行 ID。流程核对仓库、预览标签、测试提交及 Linux／Windows／Release 成功状态，再校验并发布原始产物；该恢复入口不能发布稳定版。

“更多 → 块操作 → 编辑同源连续章节”支持相邻同源块之间的原生选区、剪切／删除和撤销；每个写作区域最多 32 块／32 KiB。Include 和需源码编辑的复杂块是明确边界，跨来源的破坏性操作继续阻止。自动化通过不代表真人输入法、读屏与用户任务验收完成，预览发布也不代表已满足稳定版门禁。

## 许可证

MIT。第三方依赖与 Chromium 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
