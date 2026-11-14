import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import process from 'node:process';

// The audit fails closed: every user-visible artifact, source string, script,
// test and packaged file must be free of the previous product names. The only
// exemptions are internal documentation (never packaged), third-party license
// text, and the single migration module marked with `brand-audit-allow`.
const FORBIDDEN = new RegExp([['mark', 'weave'].join(''), ['markdown', 'up'].join('')].join('|'), 'i');
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'docs', 'bench/results', 'test-results', 'playwright-report', '.vscode-test']);
const SKIP_FILES = new Set(['docs/CHANGELOG_HISTORY.md']);
const ALLOWLIST = new Set(['src/extension/legacyBrand.ts']);
const TEXT = /\.(?:md|ts|tsx|js|mjs|cjs|json|jsonc|css|html|yml|yaml|txt|svg|xml|sh|ps1)$/i;

function trackedFiles() {
  try {
    const list = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
    return [...new Set([...list(['ls-files', '-z']), ...list(['ls-files', '-z', '--others', '--exclude-standard'])])]
      .filter(file => !file.startsWith('docs/') && !file.startsWith('bench/results/') && !file.startsWith('test-results/') && !file.startsWith('playwright-report/'));
  } catch {
    return [];
  }
}

async function walk(directory, root = directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const rel = relative(root, path).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(rel) || entry.name.startsWith('.git')) continue;
      await walk(path, root, files);
    } else files.push(path);
  }
  return files;
}

function report(label, matches) {
  if (!matches.length) return false;
  console.error(`Brand audit failed: ${matches.length} occurrence(s) of a previous product name.`);
  for (const match of matches.slice(0, 200)) console.error(`  ${match}`);
  if (matches.length > 200) console.error(`  … ${matches.length - 200} more`);
  console.error(`Audited artifact: ${label}`);
  return true;
}

async function auditDirectory() {
  const files = trackedFiles();
  const candidates = files.length ? files : (await walk('.')).map(path => relative('.', path).replaceAll('\\', '/'));
  const matches = [];
  for (const file of candidates) {
    if (SKIP_FILES.has(file) || ALLOWLIST.has(file)) continue;
    if (FORBIDDEN.test(file)) { matches.push(`${file} (filename)`); continue; }
    if (!TEXT.test(file)) continue;
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    if (!FORBIDDEN.test(text)) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line) && !line.includes('brand-audit-allow')) matches.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  return matches;
}

async function auditVsix(path) {
  const require = createRequire(import.meta.url);
  const yauzl = require('yauzl');
  const matches = [];
  await new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      zip.on('entry', entry => {
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
        if (FORBIDDEN.test(entry.fileName)) matches.push(`${entry.fileName} (packaged filename)`);
        if (!TEXT.test(entry.fileName) || entry.uncompressedSize > 8 * 1024 * 1024) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { reject(streamError); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (FORBIDDEN.test(text)) {
              const lines = text.split(/\r?\n/);
              lines.forEach((line, index) => {
                if (FORBIDDEN.test(line) && !line.includes('brand-audit-allow')) matches.push(`${entry.fileName}:${index + 1}: ${line.trim().slice(0, 160)}`);
              });
            }
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
  return matches;
}

const vsixIndex = process.argv.indexOf('--vsix');
const vsix = vsixIndex >= 0 ? process.argv[vsixIndex + 1] : undefined;
if (vsix) {
  try { await stat(vsix); } catch { console.error(`Brand audit failed: VSIX not found: ${vsix}`); process.exit(1); }
  if (report(vsix, await auditVsix(vsix))) process.exit(1);
  console.log(`Brand audit passed: ${vsix}`);
} else {
  if (report('repository', await auditDirectory())) process.exit(1);
  console.log('Brand audit passed: repository');
}
