import * as vscode from 'vscode';
import { join } from 'node:path';
import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { EditorProvider } from './editorProvider';
import { legacyBrand } from './legacyBrand';

const SETTING_KEYS = ['defaultNavigationMode','showToolbar'] as const;
const MIGRATED_FLAG = 'markyou.legacyMigrationCompleted';

export function activate(context: vscode.ExtensionContext) {
  const provider = new EditorProvider(context);
  const actions: Record<string, string> = {
    save: 'save',
    saveAs: 'save-as',
    bold: 'bold',
    italic: 'italic',
    inlineCode: 'inlineCode',
    undo: 'undo',
    redo: 'redo',
    find: 'find',
    outline: 'outline',
    navigate: 'navigate',
    pinNavigation: 'pinNavigation',
    toggleToolbar: 'toggleToolbar',
    focusMode: 'focusMode',
    help: 'help',
    manageIncludes: 'manageIncludes',
    insert: 'insert',
    revealSource: 'reveal',
    selectAllDocument: 'select-all-document',
    copyDocument: 'copy-document',
    format: 'format',
    exportMarkdown:'export-markdown',
  };
  for (const [name, action] of Object.entries(actions)) {
    context.subscriptions.push(vscode.commands.registerCommand(`markyou.${name}`, (item?: unknown) => provider.dispatch(action, item)));
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('markyou.exportPdf', () => provider.openExport()),
    vscode.commands.registerCommand('markyou.open', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, EditorProvider.viewType);
    }),
    vscode.commands.registerCommand('markyou.importLegacySettings', () => migrateLegacySettings(context, true)),
    vscode.commands.registerCommand('markyou.importLegacyKeybindings', () => importLegacyKeybindings()),
    provider,
    vscode.window.registerCustomEditorProvider(EditorProvider.viewType, provider, {
      webviewOptions: {retainContextWhenHidden: true},
      supportsMultipleEditorsPerDocument: true,
    }),
  );
  void migrateLegacySettings(context, false);
  return {provider};
}

/**
 * Move user and workspace settings from the previous extension identities.
 * Old keys are retained so users can roll back; the operation never overwrites
 * a value the user has already set under the new identity. Per-document Memento
 * state belongs to the old extension ID and is not readable from the new one,
 * so only configuration settings can be imported.
 */
async function migrateLegacySettings(context: vscode.ExtensionContext, manual: boolean) {
  let settings = 0;
  const sections = [...new Set([legacyBrand.settingSection, ...legacyBrand.aliases.map(alias => alias.replace(/\.$/, ''))])];
  const targets = [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder] as const;
  for (const key of SETTING_KEYS) {
    const current = vscode.workspace.getConfiguration('markyou');
    const next = current.inspect<(string | boolean)>(key);
    for (const section of sections) {
      const previous = vscode.workspace.getConfiguration(section).inspect<(string | boolean)>(key);
      if (!previous) continue;
      for (const target of targets) {
        const field = target === vscode.ConfigurationTarget.Global ? 'globalValue' : target === vscode.ConfigurationTarget.Workspace ? 'workspaceValue' : 'workspaceFolderValue';
        const value = previous[field];
        const already = next?.[field];
        if (value === undefined || already !== undefined) continue;
        try { await current.update(key, value, target); settings++; } catch { /* Keep the old value for a manual retry. */ }
      }
    }
  }
  if (settings && (manual || !context.globalState.get(MIGRATED_FLAG))) {
    await context.globalState.update(MIGRATED_FLAG, true);
    void vscode.window.showInformationMessage('Settings imported.');
  } else if (manual) {
    void vscode.window.showInformationMessage('No settings needed to be imported.');
  }
}

function keybindingCandidates() {
  const home = homedir();
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join(roaming, 'Code', 'User', 'keybindings.json'), join(roaming, 'Code - Insiders', 'User', 'keybindings.json')];
  }
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json')];
  return [join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Code', 'User', 'keybindings.json')];
}

async function importLegacyKeybindings() {
  let file: string | undefined;
  for (const candidate of keybindingCandidates()) {
    try { await access(candidate); file = candidate; break; } catch { /* Try the next known profile. */ }
  }
  if (!file) {
    const picked = await vscode.window.showOpenDialog({canSelectMany:false, filters:{JSON:['json']}, title:'Choose keybindings.json'});
    if (!picked?.[0]) return;
    file = picked[0].fsPath;
  }
  const text = await readFile(file, 'utf8');
  let rewritten = text;
  let count = 0;
  for (const alias of legacyBrand.aliases) {
    const pattern = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    count += (rewritten.match(pattern) ?? []).length;
    rewritten = rewritten.replace(pattern, 'markyou.');
  }
  if (!count) {
    void vscode.window.showInformationMessage('No previous keybindings were found.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(`Rewrite ${count} keybinding command ID${count === 1 ? '' : 's'}? A backup of keybindings.json will be created first.`, {modal:true}, 'Rewrite');
  if (choice !== 'Rewrite') return;
  const backup = `${file}.markyou-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await copyFile(file, backup);
  await writeFile(file, rewritten, 'utf8');
  void vscode.window.showInformationMessage(`Keybindings imported. Backup: ${backup.split(/[\\/]/).pop()}`);
}
