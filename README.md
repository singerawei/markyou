<p align="center"><img src="media/markyou-logo.png" alt="MarkYou" width="104"></p>

<h1 align="center">MarkYou</h1>

<p align="center"><strong>Write Markdown like a document. Keep plain <code>.md</code> files.</strong><br>
A local-first, click-to-edit Markdown editor for VS Code — with editable multi-file documents, offline PDF export and no account.</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a> ·
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

<p align="center"><img src="media/markyou-hero.png" alt="MarkYou editing a Markdown document with a table, callout and syntax-highlighted code block" width="100%"></p>

MarkYou turns ordinary `.md` files into a click-to-edit document inside VS Code. Every save writes Markdown back to the file that owns the content, so Git, your text editor and every other Markdown tool keep working. No proprietary format, no database, no telemetry.

## Why MarkYou

- **Markdown in, Markdown out.** The rendered document and the source file stay in sync. Unsupported syntax is preserved, never flattened.
- **Editable includes.** Compose one document from many files with `@import`; edit any included section in place, and save only the files that changed.
- **Rendered, not replaced.** Tables, code, diagrams and complex blocks stay rendered while you edit them.
- **Local-first.** No login, account or cloud. The only network traffic comes from remote images in your document.
- **Offline PDF.** A bundled Chromium renders PDFs without installing Chrome or Edge.
- **Comfortable at scale.** Large documents are streamed and rendered near the viewport, with a native-editor fallback for oversized blocks.

## Highlights

| | |
| --- | --- |
| **Click-to-edit** | Paragraphs, headings, lists, tables, task lists, quotes, code blocks and links edit in place. |
| **Tables 2.0** | 10×10 size picker, rows/columns before or after, whole-column alignment, TSV paste from Excel/Feishu, TSV or Markdown copy, and a read-only preview for huge tables. |
| **Continuous writing** | Typing bursts undo as one step; press `Ctrl/Cmd+A` twice to select the document; copy plain Markdown with `@import` directives preserved. |
| **Trustworthy status** | A persistent strip shows the active file and save state; read-only mode is a visible banner that disables every editing path. |
| **Create complex Markdown** | Insert math, footnotes, callouts, admonitions, definition lists, TOC, wiki links and frontmatter from a form with live rendering. |
| **Find 2.0** | Search rendered text instead of `**` markers, highlight every hit, replace one/all with undo, and filter the outline. |
| **Rich rendering** | GFM tables, task lists, KaTeX math, footnotes, GitHub alerts, Obsidian callouts, definition lists, TOC, wiki links, highlights, sub/superscript, emoji, frontmatter and safe HTML. |
| **Mermaid** | Local rendering and caching; copy, edit, zoom, retry errors with line numbers, export SVG/PNG, and repaint on theme changes. |
| **PDF export** | Paper size, margins, font size, headers, footers, page numbers and H1 page breaks; unsaved edits are included. |
| **Display that sticks** | Text size, narrow/standard/wide reading width, focus mode and read-only state persist across restarts. |
| **Keyboard-first** | Every common action is a VS Code command and can be remapped in Keyboard Shortcuts. |

## Install

**Requirements:** Windows x64 and VS Code 1.100 or newer. No separate Chrome or Edge installation is needed.

1. Download `markyou-win32-x64-1.0.0.vsix` from [GitHub Releases](https://github.com/singerawei/markyou/releases).
2. In VS Code, open **Extensions**, click **… → Install from VSIX…**, and select the file.
3. Reload VS Code.
4. Right-click any `.md` file and choose **Open With… → MarkYou**.

<details>
<summary>Build from source</summary>

```sh
git clone https://github.com/singerawei/markyou.git
cd markyou
npm ci
npx playwright install chromium-headless-shell
npm run package
```

Requires Node.js 20.19+ (22 recommended). The generated VSIX is ready to install.
</details>

## Quick start

1. **Open** a `.md` file with **Open With… → MarkYou**.
2. **Edit** by clicking any block. Press `Ctrl/Cmd+S` to save, or `Ctrl/Cmd+Shift+S` for **Save As Copy**.
3. **Compose** several files into one view:

   ```markdown
   # System design

   @import "./product/overview.md"
   @import "./architecture/system.md"
   @import "./features/payment.md"
   ```

   Edit the rendered sections directly; saving writes only the changed source files.
4. **Navigate** with `Ctrl/Cmd+Shift+O`, insert blocks with `Ctrl/Cmd+Alt+I`, and export with **More → Export PDF**.

## Markdown support

| Syntax | Editing |
| --- | --- |
| CommonMark headings, paragraphs, emphasis, code, quotes, lists, rules | ✅ In place |
| GFM tables, alignment, task lists, strikethrough, autolinks | ✅ In place |
| Highlight `==text==`, subscript, superscript, emoji | ✅ In place |
| Safe HTML (`kbd`, `mark`, `details`, `sub`, `sup`, …) | ✅ Rendered contenteditable, sanitized |
| Math `$...$`, `$$...$$` | ✅ KaTeX, block editor with live preview |
| Footnotes, reference links, definition lists, abbreviations | ✅ Rendered, block editor with live preview |
| GitHub alerts, Obsidian callouts, admonitions | ✅ Rendered, custom titles, foldable |
| TOC, wiki links, Obsidian comments, frontmatter | ✅ Rendered |
| Mermaid | ✅ Rendered locally |
| Remote images | ✅ Loaded on open; downloaded for PDF |

## Keyboard shortcuts

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Save / Save As Copy | `Ctrl+S` / `Ctrl+Shift+S` | `Cmd+S` / `Cmd+Shift+S` |
| Find | `Ctrl+F` | `Cmd+F` |
| Outline / Navigate | `Ctrl+Shift+O` | `Cmd+Shift+O` |
| Insert | `Ctrl+Alt+I` | `Cmd+Alt+I` |
| Focus mode | `Ctrl+Alt+F` | `Cmd+Alt+F` |
| Hide toolbar | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| Help | `?` or `Ctrl+Alt+H` | `?` or `Cmd+Alt+H` |

All shortcuts are VS Code commands and can be remapped. See [docs/KEYBINDINGS.md](https://github.com/singerawei/markyou/blob/main/docs/KEYBINDINGS.md) for the full list and host conflicts.

## Good to know

- Local `.md` files only. Remote and virtual file systems, cloud sync and accounts are out of scope.
- **Save As Copy** writes a copy of the root file and keeps you on the current document. The copy must stay in the same folder so relative `@import` paths keep working.
- Oversized blocks fall back to the Text Editor: code over 128 KiB, prose over 16 KiB, or tables over 200 rows. Large tables keep a read-only preview with an explicit **Edit in Text Editor** action.
- Wiki embeds (`![[Page]]`) open as clickable cards rather than full transclusions.
- 1.0.0 targets Windows x64. macOS/Linux builds are not included in this release.

## Development

```sh
npm ci
npm run check        # lint, typecheck, core tests, build
npx playwright install chromium
npm run test:ui      # UI tests
npm run test:host    # real VS Code host tests
npm run package      # build the VSIX
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## License

MIT. Third-party dependencies and Chromium licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
