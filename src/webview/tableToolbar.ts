import type {EditorView} from 'prosemirror-view';
import type {EditorState} from 'prosemirror-state';
import type {Node as PMNode} from 'prosemirror-model';
import {isInTable,selectedRect,CellSelection,addRowBefore,addRowAfter,addColumnBefore,addColumnAfter,deleteRow,deleteColumn,deleteTable} from 'prosemirror-tables';
import {schema,serializer} from './schema';

export interface TableToolbarOptions {
  canEdit: () => boolean;
  copy: (text: string) => void;
  notify: (text: string, kind?: 'success' | 'info' | 'error') => void;
}

interface CellShape {
  content: PMNode[];
  attrs: Record<string, unknown>;
  header: boolean;
}

/** Floating toolbar shown while the caret is inside a table. */
export function createTableToolbar(view: EditorView, options: TableToolbarOptions) {
  const toolbar = document.createElement('div');
  toolbar.className = 'table-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Table actions');
  document.body.append(toolbar);

  const size = document.createElement('span');
  size.className = 'table-toolbar-size';
  toolbar.append(size);

  const button = (label: string, title: string, run: () => void) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.title = title;
    item.setAttribute('aria-label', title);
    item.onmousedown = event => event.preventDefault();
    item.onclick = () => {
      if (!options.canEdit()) return;
      run();
      view.focus();
      update();
    };
    toolbar.append(item);
    return item;
  };
  const separator = () => {
    const span = document.createElement('span');
    span.className = 'table-toolbar-separator';
    span.setAttribute('aria-hidden', 'true');
    toolbar.append(span);
  };

  button('Row ↑', 'Insert row above', () => addRowBefore(view.state, view.dispatch));
  button('Row ↓', 'Insert row below', () => addRowAfter(view.state, view.dispatch));
  button('Col ←', 'Insert column left', () => addColumnBefore(view.state, view.dispatch));
  button('Col →', 'Insert column right', () => addColumnAfter(view.state, view.dispatch));
  button('Del row', 'Delete row', () => deleteRow(view.state, view.dispatch));
  button('Del col', 'Delete column', () => deleteColumn(view.state, view.dispatch));
  separator();
  button('Left', 'Align column left', () => alignColumn(view, 'left'));
  button('Center', 'Align column center', () => alignColumn(view, 'center'));
  button('Right', 'Align column right', () => alignColumn(view, 'right'));
  separator();
  const header = document.createElement('span');
  header.textContent = 'GFM header';
  header.title = 'GFM tables always include a header row. Row count includes the header.';
  toolbar.append(header);
  button('Delete', 'Delete table', () => deleteTable(view.state, view.dispatch));
  separator();
  button('Copy TSV', 'Copy table as tab-separated values', () => {
    const tsv = tableAsTSV(view.state);
    if (tsv) options.copy(tsv); else options.notify('Place the cursor inside a table first.', 'info');
  });
  button('Copy MD', 'Copy table as Markdown', () => {
    const markdown = tableAsMarkdown(view.state);
    if (markdown) options.copy(markdown); else options.notify('Place the cursor inside a table first.', 'info');
  });

  function update() {
    if (!options.canEdit() || !isInTable(view.state) || !view.dom.isConnected) {
      toolbar.hidden = true;
      return;
    }
    const rect = selectedRect(view.state);
    size.textContent = `${rect.map.height} × ${rect.map.width}`;
    const anchor = window.getSelection()?.anchorNode;
    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
    const table = anchorElement?.closest<HTMLElement>('table') ?? view.dom.querySelector<HTMLElement>('table');
    if (!table) { toolbar.hidden = true; return; }
    toolbar.hidden = false;
    const box = table.getBoundingClientRect();
    const height = toolbar.offsetHeight || 32;
    // Prefer the space below the table: placing it above covers the paragraph
    // that precedes the table and steals its clicks.
    const below = box.bottom + 6;
    const top = below + height <= innerHeight - 8 ? below : Math.max(8, box.top - height - 6);
    const scale = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const width = toolbar.offsetWidth / scale;
    toolbar.style.left = `${Math.max(8, Math.min(box.left / scale, innerWidth - width - 8))}px`;
    toolbar.style.top = `${Math.max(8, top / scale)}px`;
  }

  const onScroll = () => update();
  window.addEventListener('scroll', onScroll, {passive: true, capture: true});
  window.addEventListener('resize', onScroll);
  update();

  return {
    update,
    destroy() {
      window.removeEventListener('scroll', onScroll, {capture: true});
      window.removeEventListener('resize', onScroll);
      toolbar.remove();
    },
  };
}

/** Apply an alignment to every cell in the caret's column. */
export function alignColumn(view: EditorView, align: 'left' | 'center' | 'right') {
  const state = view.state;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const transaction = state.tr;
  for (let row = 0; row < rect.map.height; row++) {
    const offset = rect.map.map[row * rect.map.width + rect.left];
    if (offset === undefined || offset === null) continue;
    const position = rect.tableStart + offset;
    const node = transaction.doc.nodeAt(position);
    if (!node) continue;
    transaction.setNodeMarkup(position, undefined, {...node.attrs, align});
  }
  view.dispatch(transaction);
  return true;
}

export function parseTSV(text: string): string[][] {
  if (!text) return [];
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const value = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"' && (quoted || cell === '')) {
      if (quoted && value[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === '\t' || char === '\n')) {
      row.push(cell); cell = '';
      if (char === '\n') { rows.push(row); row = []; }
    } else cell += char;
  }
  // A terminal newline terminates a record; a second one is an empty record.
  if (row.length || cell || !value.endsWith('\n')) { row.push(cell); rows.push(row); }
  if(quoted)return value.split('\n').map(row=>row.split('\t'));
  return rows;
}

export function encodeTSV(rows: string[][]): string {
  return rows.map(row => row.map(value => /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join('\t')).join('\n');
}

/** Read only cell text, ignoring clipboard styles and executable markup. */
export function htmlTableMatrix(html: string): string[][] | undefined {
  if (!/<table\b/i.test(html)) return undefined;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table'); if (!table) return undefined;
  for (const node of table.querySelectorAll('script,style,noscript')) node.remove();
  for (const br of table.querySelectorAll('br')) br.replaceWith('\n');
  return [...table.rows].map(row => [...row.cells].map(cell => cell.textContent ?? ''));
}

/** Paste TSV into the current table, expanding rows and columns as needed. */
export function pasteTSV(view: EditorView, text: string, matrixInput?: string[][]): boolean {
  let rows = matrixInput ?? parseTSV(text);
  if (!rows.length) return false;
  const inputWidth=Math.max(...rows.map(row=>row.length));
  rows=rows.map(row=>Array.from({length:inputWidth},(_,i)=>row[i]??''));
  if(rows.length-1>200||rows.length*inputWidth>5000){
    window.dispatchEvent(new CustomEvent('table-paste-limit',{detail:{rows:rows.length,columns:inputWidth}}));
    return true;
  }
  const wide = rows.some(row => row.length > 1);
  const tall = rows.length > 1;
  const state = view.state;
  if (!isInTable(state)) {
    if (!wide && !tall) return false;
    const node = tableNodeFromMatrix(rows.map((row, index) => row.map(value => inlineCell(value, index === 0))), true);
    view.dispatch(state.tr.replaceSelectionWith(node).setMeta('paste',true).scrollIntoView());
    return true;
  }
  const rect = selectedRect(state);
  if (state.selection instanceof CellSelection && rows.length === 1 && rows[0].length === 1) {
    rows = Array.from({length: rect.bottom - rect.top}, () => Array.from({length: rect.right - rect.left}, () => rows[0][0]));
  }
  const matrix = tableToMatrix(rect.table);
  const header = isHeaderTable(rect.table);
  const height = Math.max(matrix.length, rect.top + rows.length);
  const width = Math.max(matrix[0]?.length ?? 0, rect.left + Math.max(...rows.map(row => row.length)));
  if(height-1>200||height*width>5000){window.dispatchEvent(new CustomEvent('table-paste-limit',{detail:{rows:height,columns:width}}));return true;}
  while (matrix.length < height) matrix.push([]);
  for (const row of matrix) while (row.length < width) row.push({content: [], attrs: {}, header: false});
  let overwritten=0;
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      const target = matrix[rect.top + rowIndex]?.[rect.left + columnIndex];
      if (!target) return;
      if(target.content.some(node=>!!node.textContent||node.type.name==='hard_break'))overwritten++;
      target.content = inlineFromText(value);
      target.header = header && rect.top + rowIndex === 0;
    });
  });
  const node = tableNodeFromMatrix(matrix, header);
  const tablePos = rect.tableStart - 1;
  view.dispatch(state.tr.replaceWith(tablePos, tablePos + rect.table.nodeSize, node).setMeta('paste',true).scrollIntoView());
  window.dispatchEvent(new CustomEvent('table-paste-summary',{detail:{overwritten,rows:rows.length,columns:inputWidth}}));
  return true;
}

export function tableAsTSV(state: EditorState, selectionOnly = false): string | undefined {
  if (!isInTable(state)) return undefined;
  const rect = selectedRect(state);
  let rows = tableToMatrix(rect.table);
  if (selectionOnly) rows = rows.slice(rect.top, rect.bottom).map(row => row.slice(rect.left, rect.right));
  return encodeTSV(rows.map(row => row.map(cell => cell.content.map(node => node.type.name === 'hard_break' ? '\n' : node.textContent).join(''))));
}

export function tableAsMarkdown(state: EditorState): string | undefined {
  if (!isInTable(state)) return undefined;
  const table = selectedRect(state).table;
  return serializer.serialize(schema.nodes.doc.create(null, table)).trimEnd();
}

function isHeaderTable(table: PMNode) {
  const first = table.firstChild;
  return !!first?.firstChild && first.firstChild.type.name === 'table_header';
}

function tableToMatrix(table: PMNode): CellShape[][] {
  const matrix: CellShape[][] = [];
  table.forEach(row => {
    const cells: CellShape[] = [];
    row.forEach(cell => cells.push({content: [...cell.content.content], attrs: cell.attrs, header: cell.type.name === 'table_header'}));
    matrix.push(cells);
  });
  return matrix;
}

function inlineFromText(value: string) {
  if (!value) return [];
  const nodes: PMNode[] = [];
  value.split('\n').forEach((part, index) => {
    if (index > 0) nodes.push(schema.nodes.hard_break.create());
    if (part) nodes.push(schema.text(part));
  });
  return nodes;
}

function inlineCell(value: string, header: boolean): CellShape {
  return {content: inlineFromText(value), attrs: {}, header};
}

function tableNodeFromMatrix(matrix: CellShape[][], header: boolean) {
  const rows = matrix.map((cells, rowIndex) => {
    const isHeader = header && rowIndex === 0;
    const cellNodes = cells.map(cell => {
      const type = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
      return type.create(cell.attrs, cell.content);
    });
    return schema.nodes.table_row.create(null, cellNodes);
  });
  return schema.nodes.table.create(null, rows);
}

/** Convert plain Markdown table source to GFM text (used for the size picker). */
export function tableMarkdown(rows: number, columns: number) {
  const header = Array.from({length: columns}, (_, index) => `Column ${index + 1}`);
  const lines = [`| ${header.join(' | ')} |`, `| ${Array.from({length: columns}, () => '---').join(' | ')} |`];
  for (let row = 1; row < rows; row++) lines.push(`| ${Array.from({length: columns}, () => ' ').join(' | ')} |`);
  return lines.join('\n');
}
