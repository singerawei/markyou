# Changelog

## 1.1.0 — 2026-11-15

- Publish as `singeraw.markyou` through GitHub OIDC Trusted Publishing; upgrade the pinned publishing tool to vsce 4.1.1 (Node.js 22+), and mark preview packages before installed-VSIX tests.
- Focus Find synchronously so reopening navigation cannot redirect replacement typing into the query on a delayed animation frame.

- Preserve quoted TSV cells, whitespace, paths, empty cells and GFM hard breaks across paste/save/reopen; keep the GFM header mandatory.
- Navigate individual search occurrences and validate source URI, version and range before replacement. Preview and deduplicate multi-file replacement.
- Copy complete root Markdown through the confirmed host clipboard, including complex blocks and empty documents.
- Persist unapplied Markdown, Mermaid and HTML drafts in local workspace state and backups; apply drafts before Ctrl+S.
- Snapshot image insertion targets, restore remote image URLs, edit image properties, and explicitly copy external images into a configurable resource directory.
- Open local attachments and preserve heading fragments; keep read-only state per document.
- Export complete Markdown with expanded Includes, source-relative resources and current unsaved model contents.
- Insert footnotes atomically with Unicode labels; target new frontmatter at the root. Add source-scoped block operations and full paginated large-table browsing.
- Show cancellable PDF progress during resource preparation; add Chinese interface and command resources.
- Test and package in GitHub Actions, publish the tested VSIX to GitHub Releases and Marketplace, and exclude local artifacts and credentials from source releases. Stable releases retain manual acceptance gates.

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

