# Changelog

## 1.0.0 — 2026-11-14

The first public release of **MarkYou**, a local-first Markdown editor for VS Code.

- **Plain Markdown, editable in place** — click any paragraph, heading, list, table, task list, quote, code block or link and edit the rendered document. Files remain ordinary `.md` on disk.
- **Editable multi-file documents** — compose a document with `@import`, edit included sections in place, and save only the files that changed. Nested and repeated includes are supported.
- **Tables 2.0** — insert any size from a 10×10 grid, add or delete rows and columns on either side, align whole columns, paste TSV from Excel or Feishu, copy back as TSV or Markdown, and use a read-only preview for oversized tables.
- **Continuous writing** — typing bursts undo as one step, `Ctrl/Cmd+A` twice selects the whole document, and copying produces plain Markdown with `@import` directives intact.
- **Status you can trust** — a persistent status strip names the active source file and save state; the read-only banner disables every editing entry point.
- **Create complex Markdown** — math, footnotes, callouts, admonitions, definition lists, TOC, wiki links and frontmatter are available from Insert with a form and live rendering.
- **Find 2.0** — searches rendered text rather than Markdown markers, highlights every hit in place, and supports replace one/all with undo plus an outline filter.
- **Rich rendering** — GFM tables, task lists, KaTeX math, footnotes, GitHub alerts, Obsidian callouts, admonitions, definition lists, TOC, wiki links, highlights, sub/superscript, emoji, frontmatter and a safe HTML subset.
- **Mermaid and PDF** — diagrams render locally with copy/edit/zoom/export; PDF export supports paper size, margins, font size, headers, footers, page numbers and H1 page breaks, and includes unsaved edits.
- **Local-first** — no account, database or telemetry. The only network requests come from remote images in your document.
- **Large documents** — progressive loading, viewport rendering and native-editor fallback for oversized blocks.
- **Display that sticks** — text size, narrow/standard/wide reading width, focus mode and read-only state persist across restarts.

