import {installLocalization} from '../shared/localization';
import {DocumentNavigation} from './navigation';
import {popover} from './popover';
import {shortcutAria, shortcutLabel, modifierLabel, type ShortcutId} from './shortcuts';
import {codeNodeView,codeHighlightPlugin,indentCode,newlineCode} from './codeEditing';
import { iconButton,enhance,pdfDialog,setPdfDefaults,configureEnhancements } from './enhancements';
import { setDiagramRenderer, codeLanguages } from './diagrams';
import { EditorState, TextSelection,NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode, lift } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { splitListItem, liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import { inputRules, textblockTypeInputRule, wrappingInputRule, InputRule } from 'prosemirror-inputrules';
import { tableEditing, CellSelection,goToNextCell,isInTable,addRowAfter,addColumnAfter,deleteRow,deleteColumn,deleteTable } from 'prosemirror-tables';
import {createTableToolbar,pasteTSV,tableAsTSV,htmlTableMatrix} from './tableToolbar';
import {applyFindHighlights,clearFindHighlights} from './search';
import { parser, schema, serializer, markdownTokenizer } from './schema';
import type {Node as MarkdownNode} from 'prosemirror-model';
import { preserveEdges } from '../document/serializer';
import { collectAbbreviations, collectReferences, sanitizeHtmlFragment, type MarkdownEnv } from '../shared/markdown';
import { tocFromSegments } from '../shared/headings';
import { frontmatterHtml, isFrontmatter } from '../shared/frontmatter';
import type { Segment } from '../shared/types';
import {textMatches,type TextMatch} from '../shared/replacements';
import {visibleText} from '../shared/visibleText';
import {configureDrafts,trackDraft,pendingDrafts,restoredDrafts,discardDraft} from './drafts';

declare function acquireVsCodeApi(): {postMessage(message:unknown):void;getState():any;setState(state:unknown):void};
const vscode = acquireVsCodeApi();
const origin = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
const diagramRequests=new Map<string,{resolve:(svg:string)=>void;reject:(error:Error)=>void}>();
if(location.protocol!=='about:')setDiagramRenderer((code,dark,needed,priority)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const monitor=setInterval(()=>{if(!needed()){clearInterval(monitor);diagramRequests.delete(id);vscode.postMessage({type:'cancel-diagram',id});reject(new Error('Diagram request superseded.'));}},100);diagramRequests.set(id,{resolve:svg=>{clearInterval(monitor);resolve(svg);},reject:error=>{clearInterval(monitor);reject(error);}});vscode.postMessage({type:'render-diagram',id,code,dark,priority});}));
const root = document.querySelector<HTMLElement>('#document')!;
const status = document.querySelector<HTMLElement>('#status')!;
const statusbar = document.querySelector<HTMLElement>('#statusbar')!;
const readonlyBanner = document.querySelector<HTMLElement>('#readonly-banner')!;
const enableEditingButton = document.querySelector<HTMLButtonElement>('#enable-editing')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
let dirtyFiles: string[] = [];
let conflicts: {uri:string;deleted?:boolean}[] = [];
let lastConflictSignature = '';
let activeSearch: {query:string;matchCase:boolean;mode:string;sourceMode?:boolean;currentSegmentId?:string;currentRange?:TextMatch} | undefined;
let productVersion = '';
let productName = 'MarkYou';
let rootDocumentUri='';let rootDocumentVersion:number|undefined;
const display: {textSize:number;readingWidth:'narrow'|'standard'|'wide';readOnly:boolean;focusMode:boolean} = {textSize:16,readingWidth:'standard',readOnly:false,focusMode:false};
let segments = new Map<string,Segment>();
let ownership = new Map<string,Segment[]>();
const ownerKey = (segment:Segment) => `${segment.sourceUri}::${segment.pieceId}`;
let active: {segment:Segment;region?:Segment[];view?:EditorView;area?:HTMLTextAreaElement;element:HTMLElement;htmlEditor?:HTMLElement;htmlBaseline?:string;tableToolbar?:{update:()=>void;destroy:()=>void}} | undefined;
let readOnly = false; let userReadOnly=false; let documentTitle="";
let historyState={undo:0,redo:0};
let lastDirtyCount:number|undefined;
let longTasks:number[] = [];
try { new PerformanceObserver(list => { longTasks.push(...list.getEntries().map(entry => entry.duration)); }).observe({type:'longtask',buffered:false}); } catch { /* Optional in older Chromium. */ }
let lastThemeDark=document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
new MutationObserver(() => {
  const dark=document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
  if(dark===lastThemeDark)return;
  lastThemeDark=dark;
  window.dispatchEvent(new CustomEvent('theme-change'));
}).observe(document.body,{attributes:true,attributeFilter:['class']});
const elements = new Map<string,HTMLElement>();
// Theme changes are presentation-only. Re-rendering every mounted segment from
// a body class MutationObserver stalled large documents; diagrams subscribe to
// the theme through their own renderer instead.
const chunkData = new Map<HTMLElement,Segment[]>();
const segmentChunks = new Map<string,HTMLElement>();
let segmentOrder:Segment[]=[];const segmentIndices=new Map<string,number>();
const renderer = markdownTokenizer(true);
let resourceBase = '';
let markdownEnv: MarkdownEnv = {};
const anchorTargets = new Map<string, Segment>();
const headingSlugs = new Map<string, string>();
renderer.renderer.rules.image = (tokens,index) => {
  const token = tokens[index];
  const src = String(token.attrGet('src') ?? '');
  const alt = token.content;
  const title = String(token.attrGet('title') ?? '');
  const titleAttr = title ? ` title="${renderer.utils.escapeHtml(title)}"` : '';
  if (/^https?:\/\//i.test(src)) return `<img loading="lazy" src="${renderer.utils.escapeHtml(src)}" alt="${renderer.utils.escapeHtml(alt)}"${titleAttr}>`;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(src) && !src.startsWith('data:image/')) return `<span class="image-placeholder">🖼 ${renderer.utils.escapeHtml(alt || src)}</span>`;
  try { return `<img loading="lazy" src="${renderer.utils.escapeHtml(new URL(src,resourceBase + '/').href)}" alt="${renderer.utils.escapeHtml(alt)}"${titleAttr}>`; }
  catch { return renderer.utils.escapeHtml(alt); }
};
function send(message:unknown) { vscode.postMessage(message); }
window.addEventListener('diagram-rendered',()=>send({type:'metrics',phase:'diagram',timestamp:Date.now()}));
type ToastKind = 'success' | 'info' | 'error';
function dismissToast(item: HTMLElement) {
  item.remove();
  if (!notice.childElementCount) notice.hidden = true;
}
function toast(text: string, kind: ToastKind = 'info', options: {retry?: () => void; details?: string} = {}) {
  if (kind === 'error' && !options.details) options = {...options, details: text};
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const message = document.createElement('span');
  message.className = 'toast-message';
  message.textContent = text;
  item.append(message);
  if (kind === 'error' && options.details) {
    const details = document.createElement('button');
    details.type = 'button';
    details.textContent = 'Details';
    details.onclick = () => information('Error details', options.details!);
    item.append(details);
  }
  if (options.retry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.onclick = () => { dismissToast(item); options.retry?.(); };
    item.append(retry);
  }
  while (notice.childElementCount >= 4) notice.firstElementChild?.remove();
  notice.hidden = false;
  notice.append(item);
  setTimeout(() => dismissToast(item), kind === 'error' ? 8000 : 3000);
}
function error(text:string, retry?: () => void) { toast(text, 'error', {retry}); }
const requests=new Map<string,{resolve:(result:any)=>void;reject:(error:Error)=>void}>();
function request(type:string,payload:Record<string,unknown>={}){const id=origin+'-'+Math.random().toString(36).slice(2);return new Promise<any>((resolve,reject)=>{const timer=type==='document-markdown'?setTimeout(()=>{requests.delete(id);reject(new Error('Preparing complete Markdown timed out. Retry copying.'));},15000):undefined;requests.set(id,{resolve:value=>{if(timer)clearTimeout(timer);resolve(value);},reject:reason=>{if(timer)clearTimeout(timer);reject(reason);}});send({type,id,...payload});});}
function copyText(text:string){void request('copy',{text}).then(()=>toast('Copied to clipboard.','success'),reason=>toast(`Copy failed: ${String(reason)}`,'error'));}
const draftButton=document.createElement('button');draftButton.type='button';draftButton.hidden=true;statusbar.append(draftButton);
configureDrafts(draft=>{
  send({type:'draft',draft});
  vscode.setState({...vscode.getState(),drafts:pendingDrafts()});
},()=>{draftButton.hidden=!pendingDrafts().length;draftButton.textContent=`Unapplied drafts (${pendingDrafts().length})`;});
restoredDrafts(vscode.getState()?.drafts??[]);
draftButton.onclick=event=>{event.stopPropagation();
  const draft=pendingDrafts()[0];if(!draft)return;
  const segment=segmentOrder.find(segment=>segment.sourceUri===draft.uri&&segment.pieceId===draft.pieceId);
  if(!segment){information('Unapplied draft',`${fileLabel(draft.uri)}\n\n${draft.value}`);return;}
  const chunk=segmentChunks.get(segment.id);if(chunk)mountChunk(chunk);
  const element=elements.get(segment.id);if(element)openBlockEditor(element,segment,draft);
};
window.addEventListener('save-document',()=>send({type:'save'}));
window.addEventListener('pdf-preflight',()=>{
  const issues=segmentOrder.flatMap(segment=>segment.error?[`${segment.sourceFile}: ${segment.error}`]:segment.text.split('\n').some(line=>line.length>180)?[`${segment.sourceFile}: long lines may be clipped; check landscape or smaller font.`]:[]);
  if(pendingDrafts().length)issues.push(`${pendingDrafts().length} unapplied drafts are excluded. Apply them before export if needed.`);
  information('PDF preflight',issues.length?issues.join('\n'):'No Include errors or very long lines detected. Images and diagrams are validated during export. Applied unsaved edits are included.');
});
window.addEventListener('table-paste-limit',event=>{const size=(event as CustomEvent).detail;information('Large table paste',`${size.rows} rows (including header) × ${size.columns} columns. Inline tables support 200 data rows and 5000 cells. Nothing was pasted. Use Text Editor to paste the complete data, or paste a smaller range.`);});
window.addEventListener('table-paste-summary',event=>{const result=(event as CustomEvent).detail;toast(`${result.rows} × ${result.columns} pasted · ${result.overwritten} cells overwritten. Undo restores the whole paste.`,'info');});
configureEnhancements({canEdit:()=>!readOnly,copy:text=>request('copy',{text}),exportDiagram:(code,dark,format)=>request('export-diagram',{code,dark,format}),notify:(text,kind='info',retry)=>toast(text,kind,{retry})});
function fileLabel(uri:string){return uri.split(/[\\/]/).pop()??uri;}
function refreshSearchHighlights(){
  if(!activeSearch)return;
  const element=activeSearch.currentSegmentId?elements.get(activeSearch.currentSegmentId)??null:null;
  const current=activeSearch.currentSegmentId?segments.get(activeSearch.currentSegmentId):undefined;
  const ordinal=current&&activeSearch.currentRange?textMatches(activeSearch.sourceMode?current.text:visibleText(current.text),activeSearch.query,activeSearch.matchCase).findIndex(match=>match.start===activeSearch?.currentRange?.start):0;
  applyFindHighlights(root,activeSearch.query,element,activeSearch.matchCase,ordinal);
}
function sourceFeedback(){renderStatus();}
function renderStatus(){
  const source=active?.segment;
  const sourceLabel=source?`Editing ${source.sourceFile}`:(documentTitle||'Ready');
  const parts:string[]=[];
  if(conflicts.length)parts.push(`${conflicts.length} external conflict${conflicts.length===1?'':'s'}`);
  if(dirtyFiles.length)parts.push(`${dirtyFiles.length} file${dirtyFiles.length===1?'':'s'} unsaved`);
  if(readOnly)parts.push('Read-only');
  const state=parts.length?parts.join(' · '):'Saved';
  const text=`${sourceLabel} · ${state}`;
  if(status.textContent!==text)status.textContent=text;
  statusbar.dataset.state=conflicts.length?'conflict':dirtyFiles.length?'dirty':readOnly?'readonly':'saved';
  statusbar.title=[source?`Source: ${source.sourceUri}`:undefined,...dirtyFiles.map(uri=>`Unsaved: ${uri}`),...conflicts.map(item=>`External change: ${item.uri}`)].filter(Boolean).join('\n');
  statusbar.setAttribute('aria-label',`${text}. ${dirtyFiles.length?`Unsaved files: ${dirtyFiles.map(fileLabel).join(', ')}.`:'All changes saved.'}`);
  readonlyBanner.hidden=!readOnly;
  document.body.classList.toggle('read-only',readOnly);
  for(const item of root.querySelectorAll<HTMLElement>('li[data-checked]'))item.tabIndex=readOnly?-1:0;
}
function setMode(value:boolean,persist=true){deactivate();userReadOnly=value;readOnly=value;display.readOnly=value;send({type:'mode',readOnly:value});if(persist)send({type:'display-preference',patch:{readOnly:value}});for(const[id,element]of elements)render(element,segments.get(id)!);sourceFeedback();syncToolbar();}
enableEditingButton.onclick=()=>setMode(false);
statusbar.addEventListener('click',()=>showStatusDetails());
statusbar.tabIndex=0;
statusbar.setAttribute('role','button');
statusbar.setAttribute('aria-haspopup','dialog');
statusbar.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showStatusDetails();}});

function render(element:HTMLElement,segment:Segment) {
  if (active?.element === element) return;
  element.replaceChildren();
  element.className = 'segment';
  element.hidden=segment.text===''&&segmentOrder.some(item=>item.sourceUri===segment.sourceUri&&!!item.text.trim());
  delete element.dataset.large;
  const fenced=/^\s*(?:`{3,}|~{3,})/.test(segment.text);
  const tableLines=/^\s*\|/.test(segment.text)?segment.text.trimEnd().split(/\r?\n/):undefined;
  const tableDataRows=Math.max(0,(tableLines?.length??0)-2);
  const largeTable=!!tableLines&&(tableDataRows>200||(tableLines.length-1)*Math.max(1,(tableLines[0].match(/(?<!\\)\|/g)?.length??2)-1)>5000);
  const large=largeTable||segment.text.length>(fenced?128*1024:16*1024);
  element.dataset.large=String(large);
  if(largeTable){
    element.classList.add('large-table');
    resourceBase=(segment as any).resourceBase??'';
    const columns=Math.max(1,(tableLines![0].match(/\|/g)?.length??2)-1);
    const info=document.createElement('p');info.className='large-block-notice';
    info.textContent=`Large table: ${Math.max(0,tableLines!.length-2)} data rows × ${columns} columns. Read-only preview shows the first 50 data rows. All rows remain available below or in Text Editor. The 200-row limit excludes the header.`;
    const preview=document.createElement('div');preview.className='large-table-preview';
    try{preview.innerHTML=renderer.render(tableLines!.slice(0,52).join('\n')+'\n',markdownEnv);wrapTables(preview);}catch{preview.textContent=tableLines!.slice(0,52).join('\n');}
    const open=document.createElement('button');open.type='button';open.textContent='Edit in Text Editor';open.onclick=event=>{event.stopPropagation();send({type:'reveal',uri:segment.sourceUri,pieceId:segment.pieceId});};
    const all=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Browse / search all rows';const search=document.createElement('input');search.type='search';search.setAttribute('aria-label','Search all table rows');const content=document.createElement('pre');let page=0;const paint=()=>{const rows=tableLines!.slice(2).filter(row=>!search.value||row.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()));page=Math.min(page,Math.max(0,Math.ceil(rows.length/100)-1));content.textContent=`${rows.length} data rows ? ${page+1} / ${Math.max(1,Math.ceil(rows.length/100))}\n`+tableLines!.slice(0,2).concat(rows.slice(page*100,(page+1)*100)).join('\n');};const next=document.createElement('button');next.type='button';next.textContent='Next 100 rows';next.onclick=event=>{event.stopPropagation();page++;paint();};const prev=document.createElement('button');prev.type='button';prev.textContent='Previous 100 rows';prev.onclick=event=>{event.stopPropagation();page=Math.max(0,page-1);paint();};all.onclick=event=>event.stopPropagation();search.oninput=()=>{page=0;paint();};all.addEventListener('toggle',()=>{if(all.open)paint();});all.append(summary,search,prev,next,content);
    element.append(info,open,preview,all);element.dataset.rendered='true';return;
  }
  if(large){const label=document.createElement('p');label.className='large-block-notice';label.textContent='Large block: inline editing is limited to 128 KiB code or 16 KiB prose. Use Text Editor for responsive editing. The complete content is preserved.';const preview=document.createElement('pre');preview.textContent=segment.text.slice(0,4000)+'\n…';const open=document.createElement('button');open.textContent='Edit in Text Editor';open.onclick=event=>{event.stopPropagation();send({type:'reveal',uri:segment.sourceUri,pieceId:segment.pieceId});};element.append(label,open,preview);element.dataset.rendered='true';return;}
  if (segment.error) {
    element.classList.add('include-error');
    const message = document.createElement('p'); message.textContent = segment.error;
    const actions = document.createElement('div'); actions.className = 'include-error-actions';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
    retry.onclick = event => { event.stopPropagation(); void request('reload-document').then(() => toast('Reloaded.', 'success'), reason => error(String(reason))); };
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open source';
    open.onclick = event => { event.stopPropagation(); send({type: 'open-source', uri: segment.sourceUri}); };
    actions.append(retry, open); element.append(message, actions); element.dataset.rendered = 'true'; return;
  }
  if (isFrontmatter(segment.text)) {
    element.classList.add('frontmatter-block','source-backed');
    element.innerHTML = frontmatterHtml(segment.text);
    element.dataset.rendered = 'true';
    return;
  }
  if (!segment.text.trim()) {
    element.innerHTML = '<p class="empty">Start writing…</p>';
    element.dataset.rendered = 'true';
    return;
  }
  resourceBase = (segment as any).resourceBase ?? '';
  try {
    element.innerHTML = renderer.render(segment.text, markdownEnv);
  } catch {
    renderSourceCard(element,segment);
    element.dataset.rendered = 'true';
    return;
  }
  if (!segment.editable) element.classList.add('source-backed');
  wrapTables(element);
  for(const item of element.querySelectorAll<HTMLElement>('li[data-checked]')){item.setAttribute('role','checkbox');item.setAttribute('aria-checked',item.dataset.checked!);item.tabIndex=readOnly?-1:0;}
  enhance(element,segment,text=>update(segment,text));
  applyHeadingAnchors(element,segment);
  const visual = element.querySelector('img,svg,figure,table,pre,.md-toc,.md-comment-block,.frontmatter-card,.math-block,.admonition,.md-alert,.source-notice,.reference-defs,.abbreviation-defs');
  if (!element.textContent?.trim() && !visual) renderSourceCard(element,segment);
  element.dataset.rendered = 'true';
}
function wrapTables(container:HTMLElement) {
  for (const table of container.querySelectorAll<HTMLTableElement>('table')) {
    if (table.parentElement?.classList.contains('table-scroll')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}
function escapeText(value:string) {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderSourceCard(element:HTMLElement,segment:Segment) {
  element.classList.add('source-backed');
  const references = [...segment.text.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm)];
  if (references.length) {
    element.classList.add('reference-defs');
    element.innerHTML = `<div class="source-card"><div class="source-card-title">Link definitions</div><dl>${references.map(([,label,target])=>`<dt>${escapeText(label)}</dt><dd>${escapeText(target)}</dd>`).join('')}</dl><small>Click to edit</small></div>`;
    return;
  }
  const abbreviations = [...segment.text.matchAll(/^\*\[([^\]]+)\]:[ \t]*(.*)$/gm)];
  if (abbreviations.length) {
    element.classList.add('abbreviation-defs');
    element.innerHTML = `<div class="source-card"><div class="source-card-title">Abbreviations</div><dl>${abbreviations.map(([,label,title])=>`<dt>${escapeText(label)}</dt><dd>${escapeText(title)}</dd>`).join('')}</dl><small>Click to edit</small></div>`;
    return;
  }
  element.classList.add('source-notice');
  element.innerHTML = '<div class="source-card"><div class="source-card-title">Source-only block</div><small>This HTML or markup is kept safely out of the rendered layout. Click to edit with a live preview.</small></div>';
}
function applyHeadingAnchors(element:HTMLElement,segment:Segment) {
  const slug = headingSlugs.get(segment.id);
  if (!slug) return;
  element.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading,index) => {
    heading.id = index === 0 ? slug : `${slug}-${index + 1}`;
  });
  element.dataset.headingSlug = slug;
}
function refreshMarkdownContext() {
  const toc = tocFromSegments(segmentOrder);
  const abbreviations = collectAbbreviations(segmentOrder.map(segment => segment.text));
  markdownEnv = {references: collectReferences(segmentOrder.map(segment => segment.text)), toc, abbreviations};
  const abbrNames = Object.keys(abbreviations);
  const abbrPattern = abbrNames.length ? new RegExp(`\\b(?:${abbrNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`) : undefined;
  anchorTargets.clear();
  headingSlugs.clear();
  for (const entry of toc) {
    if (!entry.segmentId) continue;
    const segment = segments.get(entry.segmentId);
    if (!segment) continue;
    anchorTargets.set(entry.slug, segment);
    headingSlugs.set(entry.segmentId, entry.slug);
  }
  for (const [id, element] of elements) {
    const segment = segments.get(id);
    if (!segment || active?.element === element) continue;
    applyHeadingAnchors(element, segment);
    if (/\]\[|^\s*\[toc\]\s*$|^\*\[[^\]]+\]:/im.test(segment.text) || abbrPattern?.test(segment.text)) render(element, segment);
  }
}
function mountChunk(chunk:HTMLElement) {
  if (chunk.dataset.mounted) return;
  chunk.dataset.mounted = 'true'; chunk.style.minHeight = '';
  for (const segment of chunkData.get(chunk) ?? []) {
    chunk.append(makeSegment(segment));
  }
  if (activeSearch) requestAnimationFrame(refreshSearchHighlights);
  window.dispatchEvent(new CustomEvent('markyou-layout-change'));
}
function makeSegment(segment:Segment){const element=document.createElement('section');element.className='segment';element.dataset.id=segment.id;element.title=segment.sourceUri;element.tabIndex=0;element.dataset.vscodeContext=JSON.stringify({webviewSection:'markyou',sourceUri:segment.sourceUri,pieceId:segment.pieceId});elements.set(segment.id,element);render(element,segment);return element;}
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const chunk = entry.target as HTMLElement;
    if (entry.isIntersecting) mountChunk(chunk);
    else if (chunk.dataset.mounted && !chunk.contains(active?.element ?? null)) {
      chunk.style.minHeight = `${chunk.getBoundingClientRect().height}px`;
      for (const segment of chunkData.get(chunk) ?? []) elements.delete(segment.id);
      chunk.replaceChildren(); delete chunk.dataset.mounted;
    }
  }
},{rootMargin:'1000px'});

function update(segment:Segment,text:string, separateHistory = false) {
  if(readOnly)return;
  if (text === segment.text) return;
  const before = segment.text;
  for (const current of ownership.get(ownerKey(segment)) ?? []) {
    current.text = text;navigator.index(current);
    const element = elements.get(current.id)!;
    if (element && element !== active?.element) render(element,current);
  }
  if (needsContextRefresh(before, text)) contextPending = true;
  send({type:'edit',uri:segment.sourceUri,pieceId:segment.pieceId,before,text,origin,separateHistory});
}
let contextPending = false;
function needsContextRefresh(...values: string[]) {
  return values.some(value => /^ {0,3}#{1,6}\s|^ {0,3}\[[^\]]+\]:|^ {0,3}\*\[[^\]]+\]:|^ {0,3}\[toc\]\s*$|^[^\r\n]+\r?\n {0,3}(?:=+|-+)\s*$/im.test(value));
}
function deactivate() {
  if (!active) return;
  const previous = active;
  if (previous.htmlEditor) {
    const value = sanitizeHtmlFragment(previous.htmlEditor.innerHTML).trim();
    const changed = value !== (previous.htmlBaseline ?? '');
    active = undefined;
    previous.element.classList.remove('editing','html-editing');
    if (changed) update(previous.segment,value);
    else render(previous.element,previous.segment);
    syncToolbar();
    if (contextPending) {
      contextPending = false;
      refreshMarkdownContext();
    }
    return;
  }
  previous.tableToolbar?.destroy();
  active.view?.destroy(); active = undefined;
  previous.element.classList.remove('editing');
  render(previous.element,previous.segment);
  if(previous.region)for(const segment of previous.region.slice(1)){const element=elements.get(segment.id);if(element)render(element,segment);}
  syncToolbar();
  if (contextPending) {
    contextPending = false;
    refreshMarkdownContext();
  }
}
function canVisuallyEditHtml(element:HTMLElement,segment:Segment) {
  if (!/<[a-z][\s\S]*>/i.test(segment.text)) return false;
  if (element.querySelector('.source-card')) return false;
  if (/(?<!\\)\$[^$\r\n]+\$|\$\$|\[\^|\[\[|%%|\[toc\]|^\s*>\s*\[!|^\s*!!!|^\s*\*\[[^\]]+\]:|^[ \t]*:[ \t]+\S/mi.test(segment.text)) return false;
  return element.childElementCount > 0;
}
function activateHtmlEditor(element:HTMLElement,segment:Segment) {
  deactivate();
  const editor = document.createElement('div');
  editor.className = 'html-visual-editor';
  editor.contentEditable = 'true';
  editor.spellcheck = false;
  editor.setAttribute('role','textbox');
  editor.setAttribute('aria-multiline','true');
  editor.setAttribute('aria-label','Edit rendered HTML block');
  while (element.firstChild) editor.append(element.firstChild);
  const bar = document.createElement('div'); bar.className = 'html-edit-bar';
  const label = document.createElement('span'); label.textContent = 'Visual HTML editing';
  const done = document.createElement('button'); done.type = 'button'; done.textContent = 'Done';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  bar.append(label,done,cancel);
  element.replaceChildren(bar,editor);
  element.classList.add('editing','html-editing');
  active = {segment,element,htmlEditor:editor,htmlBaseline:sanitizeHtmlFragment(editor.innerHTML).trim()};
  const draft=trackDraft(segment,'html');
  editor.addEventListener('input',()=>draft.update(sanitizeHtmlFragment(editor.innerHTML).trim()));
  sourceFeedback();
  const finish = (save:boolean) => {
    if (active?.element !== element || active.htmlEditor !== editor) return;
    if (!save) active.htmlBaseline = sanitizeHtmlFragment(editor.innerHTML).trim();
    draft.clear();
    deactivate();
    element.focus({preventScroll:true});
  };
  done.onclick = () => finish(true);
  done.onmousedown = event => event.preventDefault();
  cancel.onclick = () => finish(false);
  cancel.onmousedown = event => event.preventDefault();
  editor.addEventListener('keydown',event => {
    if(event.isComposing)return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();finish(true);send({type:'save'});return;}
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(true); }
  });
  editor.focus();
}
function blockEditorTitle(segment:Segment) {
  if (isFrontmatter(segment.text)) return 'Edit frontmatter';
  if (/(^|[^\\])\$\$|\\\[/.test(segment.text)) return 'Edit math block';
  if (/\$[^$\r\n]+\$|\\\(/.test(segment.text)) return 'Edit inline math';
  if (/\[\^/.test(segment.text)) return 'Edit footnote';
  if (/^\s*>\s*\[!/mi.test(segment.text)) return 'Edit callout';
  if (/^\s*!!!/mi.test(segment.text)) return 'Edit admonition';
  if (/^\s*\[toc\]\s*$/mi.test(segment.text)) return 'Table of contents';
  if (/<[a-z]/i.test(segment.text)) return 'Edit HTML block';
  return 'Edit Markdown block';
}
function openBlockEditor(element:HTMLElement,segment:Segment,recovered?:import('../shared/draft').UnappliedDraft) {
  deactivate();
  const dialog = document.createElement('dialog');
  dialog.className = 'block-editor-dialog';
  dialog.setAttribute('aria-labelledby', 'block-editor-title');
  const title = document.createElement('h2');
  title.id = 'block-editor-title';
  title.textContent = blockEditorTitle(segment);
  const hint = document.createElement('p');
  hint.className = 'block-editor-hint';
  hint.textContent = 'The rendered block stays in the document. Edit the source here with a live preview, then apply.';
  const grid = document.createElement('div'); grid.className = 'block-editor-grid';
  const baseline=recovered?.baseline??segment.text;
  const draft=trackDraft({...segment,text:baseline},recovered?.kind??'markdown');
  const source = document.createElement('textarea'); source.className = 'block-editor-source'; source.value = recovered?.value??segment.text; source.spellcheck = false; source.setAttribute('aria-label','Block source');
  const preview = document.createElement('div'); preview.className = 'block-editor-preview'; preview.setAttribute('aria-label','Live preview');
  grid.append(source,preview);
  const actions = document.createElement('div'); actions.className = 'dialog-row';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply';
  const copy=document.createElement('button');copy.type='button';copy.textContent='Copy draft';copy.onclick=()=>copyText(source.value);
  const compare=document.createElement('button');compare.type='button';compare.textContent='Compare source';compare.onclick=()=>information('Current source',segment.text);
  actions.append(apply,cancel,copy,compare);
  dialog.append(title,hint,grid,actions);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = () => {
    try {
      preview.innerHTML = isFrontmatter(source.value) ? frontmatterHtml(source.value) : renderer.render(source.value,markdownEnv);
      wrapTables(preview);
    } catch (reason) { preview.textContent = String(reason); }
  };
  source.oninput = () => {draft.update(source.value); clearTimeout(timer); timer = setTimeout(paint,120); };
  const close = (accepted:boolean) => {
    if(accepted&&(readOnly||segment.text!==baseline)){error('Source changed or is read-only. Your draft is preserved. Copy it or compare with the current source.');return false;}
    clearTimeout(timer);
    const value = source.value;
    dialog.close();
    dialog.remove();
    if (accepted && value !== segment.text) update(segment,value,true);
    draft.clear();
    if(recovered)discardDraft(recovered.key);
    element.focus({preventScroll:true});
    return true;
  };
  apply.onclick = () => close(true);
  cancel.onclick = () => close(false);
  source.addEventListener('keydown',event => {
    if(event.isComposing)return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();if(close(true))send({type:'save'});return;}
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); close(true); }
  });
  dialog.addEventListener('cancel',event => { event.preventDefault(); close(false); });
  dialog.addEventListener('apply-draft-and-save',()=>{if(close(true))send({type:'save'});});
  document.body.append(dialog);
  paint();
  dialog.showModal();
  source.focus();
}
async function insertImageFiles(view:EditorView,files:File[],position?:number) {
  const target=active;
  if(!target||target.view!==view||readOnly)return;
  const owner=target.segment.sourceUri;
  let expected=view.state.doc;
  let insertAt=position;
  for(const file of files){
    try{
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(bytes.length>20*1024*1024)throw new Error('Image is larger than 20 MB.');
      if(readOnly||active!==target||view.isDestroyed||view.state.doc!==expected)throw new Error('Image target changed. Select an insertion position and retry.');
      let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
      const path=String(await request('save-image',{uri:owner,sourceVersion:target.segment.sourceVersion,name:file.name||'pasted.png',mime:file.type||'image/png',data:btoa(binary)}));
      if(readOnly||active!==target||view.isDestroyed||view.state.doc!==expected)throw new Error(`Image target changed. The resource was saved at ${path}; choose a position to insert it.`);
      const node=schema.nodes.image.create({src:path,alt:(file.name||'image').replace(/\.[^.]+$/,'')});
      const transaction=view.state.tr;
      if(insertAt!==undefined)transaction.insert(insertAt,node);else transaction.replaceSelectionWith(node);
      view.dispatch(transaction.setMeta('separateHistory',true).scrollIntoView());
      expected=view.state.doc;
      if(insertAt!==undefined)insertAt+=node.nodeSize;
    }catch(reason){error(String(reason));}
  }
  if(!view.isDestroyed&&active===target)view.focus();
}
async function insertImagesWithoutActive(files:File[]){
  if(readOnly)return;
  const source=segmentOrder[0];if(!source)return;
  const uri=rootDocumentUri||source.sourceUri,sourceVersion=rootDocumentVersion??source.sourceVersion,paths:string[]=[];
  toast('Preparing images for the root document…','info');
  try{
    for(const file of files){
      const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.length>20*1024*1024)throw new Error('Image is larger than 20 MB.');
      let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
      if(readOnly)throw new Error('The document is now read-only.');
      const path=String(await request('save-image',{uri,sourceVersion,data:btoa(binary),mime:file.type,name:file.name||'pasted.png'}));paths.push(path);
    }
    if(readOnly)throw new Error('The document is now read-only.');
    await request('insert-block',{uri,sourceVersion,position:'end',text:paths.map(path=>`![image](<${path}>)`).join('\n\n')});
  }catch(reason){error(`${String(reason)}${paths.length?' Saved resources: '+paths.join(', ')+'. Select a position to insert them.':''}`);}
}
document.addEventListener('paste',event=>{
  if(event.defaultPrevented||readOnly||active?.view||(event.target as HTMLElement).closest('dialog,input,textarea,[contenteditable=true]'))return;
  const files=[...(event.clipboardData?.files??[])].filter(file=>file.type.startsWith('image/'));if(!files.length)return;
  event.preventDefault();void insertImagesWithoutActive(files);
});
root.addEventListener('dragover',event=>{if(!readOnly&&!active?.view&&[...(event.dataTransfer?.items??[])].some(item=>item.kind==='file'))event.preventDefault();});
root.addEventListener('drop',event=>{if(event.defaultPrevented||readOnly||active?.view)return;const files=[...(event.dataTransfer?.files??[])].filter(file=>file.type.startsWith('image/'));if(files.length){event.preventDefault();void insertImagesWithoutActive(files);}});
function chooseTablePaste(view:EditorView,text:string,matrix?:string[][]){
  const target=active,expected=view.state.doc;
  const dialog=document.createElement('dialog');dialog.setAttribute('aria-labelledby','paste-table-title');
  const title=document.createElement('h2');title.id='paste-table-title';title.textContent='Paste table data';dialog.append(title);
  const close=()=>{dialog.close();dialog.remove();if(!view.isDestroyed)view.focus();};
  for(const [label,convert]of [['Convert to table',true],['Paste text only',false]]as const){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{
    if(readOnly||active!==target||view.isDestroyed||view.state.doc!==expected){error('Paste target changed. Select the insertion point again.');close();return;}
    if(convert)pasteTSV(view,text,matrix);else view.dispatch(view.state.tr.insertText(text).setMeta('paste',true));close();
  };dialog.append(button);}
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.onclick=close;dialog.append(cancel);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);dialog.showModal();
}
async function editLink(){
  const view=active?.view;if(!view||readOnly)return;
  let {from,to}=view.state.selection;
  const mark=view.state.doc.resolve(from).marks().find(item=>item.type===schema.marks.link);
  if(from===to&&mark){
    // A collapsed caret still needs the full span of the link text.
    const $from=view.state.doc.resolve(from);
    view.state.doc.nodesBetween($from.start(),$from.end(),(node,position)=>{
      if(!node.isText||!schema.marks.link.isInSet(node.marks))return;
      const end=position+node.nodeSize;
      if(position<=from&&from<=end){from=Math.min(from,position);to=Math.max(to,end);}
    });
  }
  const values=await ask('Edit link',[{name:'url',label:'URL / relative path',value:String(mark?.attrs.href??'')}],'Apply');
  if(!values)return;
  const href=values.url.trim();
  if(!href)view.dispatch(view.state.tr.removeMark(from,to,schema.marks.link));
  else view.dispatch(view.state.tr.addMark(from,to,schema.marks.link.create({href,title:null})));
  view.focus();
}
async function editImage(){
  const target=active,view=target?.view;if(!view||!target)return;
  const selection=view.state.selection;
  const node=selection instanceof NodeSelection&&selection.node.type===schema.nodes.image?selection.node:undefined;
  if(!node){toast('Select an image in the editable block first.','info');return;}
  const before=view.state.doc;
  const values=await ask('Image properties',[{name:'src',label:'Image address',value:String(node.attrs.src??'')},{name:'alt',label:'Alt text',value:String(node.attrs.alt??'')},{name:'title',label:'Title',value:String(node.attrs.title??'')}],'Apply');
  if(!values||readOnly)return;
  if(active!==target||view.state.doc!==before){error('Image target changed. Select it again.');return;}
  if(/^(?:javascript|vbscript|data):/i.test(values.src.trim())){error('Enter a safe image path or HTTP URL.');return;}
  view.dispatch(view.state.tr.setNodeMarkup(selection.from,undefined,{...node.attrs,src:values.src,alt:values.alt,title:values.title||null}).setMeta('separateHistory',true));view.focus();
}
function blockActions(segment:Segment|undefined){
  if(!segment||readOnly)return;
  const dialog=document.createElement('dialog');dialog.setAttribute('aria-labelledby','block-actions-title');
  const heading=document.createElement('h2');heading.id='block-actions-title';heading.textContent='Block actions';
  const source=document.createElement('p');source.textContent=segment.sourceFile;
  dialog.append(heading,source);
  let restoreFocus=true;
  const continuous=document.createElement('button');continuous.type='button';continuous.textContent='Edit continuous section';continuous.onclick=()=>{restoreFocus=false;dialog.close();const element=elements.get(segment.id);if(element&&active?.segment!==segment)activate(element,segment);editContinuousSection();};dialog.append(continuous);
  const image=document.createElement('button');image.type='button';image.textContent='Image properties…';image.onclick=()=>{restoreFocus=false;dialog.close();void editImage();};image.disabled=!active?.view;dialog.append(image);
  for(const [label,action]of [['Duplicate block','duplicate'],['Delete block','delete'],['Move block up','up'],['Move block down','down']]){
    const button=document.createElement('button');button.type='button';button.textContent=label;
    button.onclick=()=>{deactivate();void request('block-operation',{uri:segment.sourceUri,pieceId:segment.pieceId,sourceVersion:segment.sourceVersion,action}).then(()=>dialog.close(),reason=>error(String(reason)));};dialog.append(button);
  }
  const close=document.createElement('button');close.type='button';close.textContent='Cancel';close.onclick=()=>dialog.close();dialog.append(close);
  dialog.addEventListener('close',()=>{dialog.remove();if(restoreFocus)elements.get(segment.id)?.focus();});document.body.append(dialog);dialog.showModal();
}
/** A bounded same-source writing surface keeps native ProseMirror selections. */
function editContinuousSection(){
  const current=active?.segment;if(!current||readOnly)return;
  const center=segmentIndices.get(current.id)??0;
  let start=center,end=center+1,total=current.text.length;
  const allowed=(segment:Segment|undefined)=>!!segment&&segment.editable&&!segment.error&&segment.sourceUri===current.sourceUri&&segment.includeInstanceId===current.includeInstanceId&&segment.text.length<16000;
  while(start>0&&end-start<32&&allowed(segmentOrder[start-1])&&total+segmentOrder[start-1].text.length<32000){start--;total+=segmentOrder[start].text.length;}
  while(end<segmentOrder.length&&end-start<32&&allowed(segmentOrder[end])&&total+segmentOrder[end].text.length<32000){total+=segmentOrder[end].text.length;end++;}
  const region=segmentOrder.slice(start,end);
  if(region.length<2){toast('No adjacent editable blocks in the same source. Include boundaries remain separate.','info');return;}
  const originals=region.map(segment=>segment.text),parsed=originals.map(raw=>parser.parse(raw));
  const nodes=parsed.flatMap(doc=>[...doc.content.content]);
  const originalDoc=schema.nodes.doc.create(null,nodes);
  const first=region[0],chunk=segmentChunks.get(first.id);if(chunk)mountChunk(chunk);
  deactivate();
  const element=elements.get(first.id)!;element.replaceChildren();element.classList.add('editing','continuous-editing');
  for(const segment of region.slice(1)){const item=elements.get(segment.id);if(item)item.hidden=true;}
  active={segment:first,region,element};
  const compile=(doc:MarkdownNode)=>{
    const next=[...doc.content.content];let prefix=0,suffix=0;
    while(prefix<nodes.length&&prefix<next.length&&nodes[prefix].eq(next[prefix]))prefix++;
    while(suffix<nodes.length-prefix&&suffix<next.length-prefix&&nodes[nodes.length-1-suffix].eq(next[next.length-1-suffix]))suffix++;
    let left=0,leftNodes=0,right=parsed.length,rightNodes=0;
    while(left<parsed.length&&leftNodes+parsed[left].childCount<=prefix){leftNodes+=parsed[left].childCount;left++;}
    while(right>left&&rightNodes+parsed[right-1].childCount<=suffix){right--;rightNodes+=parsed[right].childCount;}
    const middle=schema.nodes.doc.create(null,next.slice(leftNodes,next.length-rightNodes));
    const changed=originals.slice(left,right).join('');
    let value=preserveEdges(changed,serializer.serialize(middle));
    if(left===right&&right<originals.length)value+='\n';
    return originals.slice(0,left).join('')+value+originals.slice(right).join('');
  };
  const view=new EditorView(element,{state:EditorState.create({schema,doc:originalDoc,plugins:[
    keymap({'Mod-b':toggleMark(schema.marks.strong),'Mod-i':toggleMark(schema.marks.em),'Shift-Enter':(state,dispatch)=>{dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()));return true;},Enter:chainCommands(newlineCode,splitListItem(schema.nodes.list_item)),Tab:chainCommands(indentCode(),goToNextCell(1),sinkListItem(schema.nodes.list_item)),'Shift-Tab':chainCommands(indentCode(true),goToNextCell(-1),liftListItem(schema.nodes.list_item))}),keymap(baseKeymap),tableEditing(),codeHighlightPlugin()
  ]}),
    handleKeyDown(_view,event){if(event.isComposing)return false;if(event.key==='Escape'){deactivate();return true;}return false;},
    dispatchTransaction(transaction){
      if(readOnly&&transaction.docChanged)return;
      view.updateState(view.state.apply(transaction));syncToolbar();active?.tableToolbar?.update();
      if(!transaction.docChanged)return;
      const text=compile(view.state.doc);
      const changes=region.map((segment,index)=>({uri:segment.sourceUri,pieceId:segment.pieceId,before:segment.text,after:index===0?text:''}));
      for(const change of changes)for(const owner of ownership.get(`${change.uri}::${change.pieceId}`)??[]){owner.text=change.after;navigator.index(owner);const item=elements.get(owner.id);if(item&&item!==element){item.hidden=!change.after;if(change.after)render(item,owner);}}
      send({type:'edit-region',uri:first.sourceUri,changes,origin,separateHistory:!!transaction.getMeta('paste')||!!transaction.getMeta('separateHistory')});
    },
    handlePaste(view,event){const text=event.clipboardData?.getData('text/plain');if(text===undefined)return false;view.dispatch(view.state.tr.insertText(text).setMeta('paste',true));return true;},
    nodeViews:{code_block:(node,view,getPos)=>codeNodeView(node,view,getPos,text=>request('copy',{text}))}
  });
  active.view=view;active.tableToolbar=createTableToolbar(view,{canEdit:()=>!readOnly,copy:copyText,notify:(text,kind)=>toast(text,kind)});view.focus();syncToolbar();
  toast('Continuous section: select, cut or delete across these blocks. Includes and other sources remain separate. Esc returns to reading.','info');
}
root.addEventListener('contextmenu',event=>{
  if(readOnly||(event.target as HTMLElement).closest('.ProseMirror,textarea,.html-visual-editor'))return;
  const element=(event.target as HTMLElement).closest<HTMLElement>('.segment');if(!element)return;
  event.preventDefault();blockActions(segments.get(element.dataset.id!));
});
function activate(element:HTMLElement,segment:Segment) {
  if (readOnly) { toast('This view is read-only. Choose Enable editing to make changes.', 'info'); return; }
  if (element.dataset.large==='true') return;
  if (segment.error || active?.element === element) return;
  deactivate();
  if (!segment.editable) {
    if (/^\s*\[toc\]\s*$/i.test(segment.text.trim())) { navigator.open('outline'); return; }
    if (canVisuallyEditHtml(element,segment)) activateHtmlEditor(element,segment);
    else openBlockEditor(element,segment);
    return;
  }
  element.replaceChildren(); element.classList.add('editing');
  active = {segment,element}; sourceFeedback();
  try {
    const state = EditorState.create({schema,doc:parser.parse(segment.text),plugins:[
      inputRules({rules:[textblockTypeInputRule(/^(#{1,6})\s$/,schema.nodes.heading,match => ({level:match[1].length})),
        textblockTypeInputRule(/^```([\w+#.-]*)\s$/,schema.nodes.code_block,match => ({params:match[1]})),
        new InputRule(/^---$/, (state,_match,start,end) => state.tr.replaceWith(start,end,schema.nodes.horizontal_rule.create())),
        wrappingInputRule(/^\s*>\s$/,schema.nodes.blockquote),wrappingInputRule(/^\s*([-+*])\s$/,schema.nodes.bullet_list),
        wrappingInputRule(/^(\d+)\.\s$/,schema.nodes.ordered_list,match => ({order:+match[1]}))]}),
      codeHighlightPlugin(),
      keymap({'Mod-b':toggleMark(schema.marks.strong),'Mod-i':toggleMark(schema.marks.em),'Mod-`':toggleMark(schema.marks.code),
        'Mod-Home':(state,dispatch)=>{dispatch?.(state.tr.setSelection(TextSelection.atStart(state.doc)));return true;},'Mod-End':(state,dispatch)=>{dispatch?.(state.tr.setSelection(TextSelection.atEnd(state.doc)));return true;},
        Enter:chainCommands(newlineCode,splitListItem(schema.nodes.list_item)),'Mod-Enter':exitCode,
        'Shift-Enter':(state,dispatch)=>{dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());return true;},
        Tab:chainCommands(indentCode(),goToNextCell(1),sinkListItem(schema.nodes.list_item)),
        'Shift-Tab':chainCommands(indentCode(true),goToNextCell(-1),liftListItem(schema.nodes.list_item))}),
      keymap(baseKeymap),tableEditing()
    ]});
    const view = new EditorView(element,{state,
      handleKeyDown(view,event){
        if (event.isComposing || view.composing) return false;
        if(event.key==='Escape'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
          // Let overlays consume the first Escape; the second returns to the block.
          if(document.querySelector('#navigation:not([hidden]),.insert-menu:not([hidden]),dialog[open]'))return false;
          event.preventDefault();deactivate();element.focus({preventScroll:true});return true;
        }
        if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='a'){
          const {from,to}=view.state.selection;
          if(from===0&&to===view.state.doc.content.size){event.preventDefault();selectAllDocument();return true;}
        }
        if(readOnly||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!view.state.selection.empty)return false;
        const atStart=view.state.selection.from===TextSelection.atStart(view.state.doc).from,atEnd=view.state.selection.from===TextSelection.atEnd(view.state.doc).from;
        const direction=(atStart&&['ArrowUp','ArrowLeft','Backspace'].includes(event.key))?-1:(atEnd&&['ArrowDown','ArrowRight','Delete'].includes(event.key))?1:0;if(!direction)return false;
        const neighbor=segmentOrder[(segmentIndices.get(segment.id)??0)+direction];if(!neighbor)return false;
        if(['Backspace','Delete'].includes(event.key)){
          const reason = segment.sourceUri!==neighbor.sourceUri
            ? `${segment.sourceFile} and ${neighbor.sourceFile} are separate files. Open each source to restructure across files.`
            : segment.includeInstanceId!==neighbor.includeInstanceId
              ? 'These blocks come from different @import instances. Edit the included file directly to merge them.'
              : segment.blockType!=='paragraph_open'||neighbor.blockType!=='paragraph_open'
                ? 'Only adjacent paragraphs can be merged. Headings, lists, tables and code keep their structure.'
                : undefined;
          if(reason){error(`Cannot merge blocks: ${reason}`);return true;}
          const first=direction<0?neighbor:segment,second=direction<0?segment:neighbor;const merged=first.text.trimEnd()+second.text.trimStart();joinRestoration={uri:first.sourceUri,pieceId:first.pieceId,id:first.id,text:merged,top:element.getBoundingClientRect().top,position:parser.parse(first.text).content.size-1,focus:true};void request('join-blocks',{uri:segment.sourceUri,first:first.pieceId,second:second.pieceId}).catch(reason=>{joinRestoration=undefined;error(String(reason));});return true;
        }
        mountChunk(segmentChunks.get(neighbor.id)!);const target=elements.get(neighbor.id)!;activate(target,neighbor);if(active?.view){active.view.dispatch(active.view.state.tr.setSelection(direction>0?TextSelection.atStart(active.view.state.doc):TextSelection.atEnd(active.view.state.doc)).scrollIntoView());}return true;
      },
      dispatchTransaction(transaction) {
        if(transaction.docChanged && readOnly)return;
        view.updateState(view.state.apply(transaction));
        if(!transaction.docChanged&&transaction.selectionSet)send({type:'seal-history'});
        syncToolbar();
        active?.tableToolbar?.update();
        if (transaction.docChanged) update(segment,preserveEdges(segment.text,serializer.serialize(view.state.doc)), !!transaction.getMeta('paste') || !!transaction.getMeta('separateHistory'));
      },
      handlePaste(view,event){
        if(readOnly)return true;
        if(view.state.selection.$from.parent.type === schema.nodes.code_block)return false;
        const images=[...(event.clipboardData?.files??[])].filter(file=>file.type.startsWith('image/'));
        if(images.length){event.preventDefault();void insertImageFiles(view,images);return true;}
        const text=event.clipboardData?.getData('text/plain')??'';
        const matrix=htmlTableMatrix(event.clipboardData?.getData('text/html')??'');
        if(isInTable(view.state) && (matrix || text.includes('\t') || text.includes('\n') || view.state.selection instanceof CellSelection)) {
          return pasteTSV(view,text,matrix);
        }
        if(!isInTable(view.state)&&(matrix||text.includes('\t'))){chooseTablePaste(view,text,matrix);return true;}
        if(!text)return false;
        // Plain text remains literal, including Markdown punctuation.
        view.dispatch(view.state.tr.insertText(text).setMeta('paste',true).scrollIntoView());
        return true;
      },
      handleDrop(view,event){
        const images=[...(event.dataTransfer?.files??[])].filter(file=>file.type.startsWith('image/'));
        if(!images.length)return false;
        event.preventDefault();
        const position=view.posAtCoords({left:event.clientX,top:event.clientY})?.pos;
        void insertImageFiles(view,images,position);
        return true;
      },
      handleDOMEvents:{
        copy(view,event){
          if(!(view.state.selection instanceof CellSelection)||!isInTable(view.state))return false;
          const tsv=tableAsTSV(view.state,true);
          if(!tsv)return false;
          (event as ClipboardEvent).clipboardData?.setData('text/plain',tsv);
          event.preventDefault();
          return true;
        },
      },
      clipboardTextSerializer(slice,view){
        const tsv=view.state.selection instanceof CellSelection?tableAsTSV(view.state,true):undefined;
        if(tsv!==undefined)return tsv;
        return slice.content.textBetween(0,slice.content.size,'\n\n');
      },
      nodeViews:{code_block:(node,view,getPos)=>codeNodeView(node,view,getPos,text=>request('copy',{text})),image(node) {
        const image = document.createElement('img'); const src = String(node.attrs.src);
        image.alt = node.attrs.alt ?? '';
        if (/^https?:\/\//i.test(src)) image.src = src;
        if (node.attrs.title) image.title = String(node.attrs.title);
        if (!/^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(src)) image.src = new URL(src,((segment as any).resourceBase ?? '') + '/').href;
        return {dom:image};
      }},
      handleClick(view,pos,event) {
        const target = (event.target as HTMLElement).closest('li[data-checked]');
        if (!target || event.clientX > target.getBoundingClientRect().left + 2) return false;
        const resolved = view.state.doc.resolve(pos);
        for (let depth = resolved.depth; depth > 0; depth--) if (resolved.node(depth).type === schema.nodes.list_item) {
          const node = resolved.node(depth);
          view.dispatch(view.state.tr.setNodeMarkup(resolved.before(depth),undefined,{...node.attrs,checked:!node.attrs.checked})); return true;
        }
        return false;
      }
    });
    active.view = view;
    active.tableToolbar = createTableToolbar(view,{canEdit:()=>!readOnly,copy:text=>copyText(text),notify:(text,kind)=>toast(text,kind??'info')});
    view.focus();syncToolbar();
  } catch (reason) {
    active = undefined; error(`This block needs the visual block editor: ${String(reason)}`);
    openBlockEditor(element,segment);
  }
}
function scrollElementToToolbar(element: HTMLElement) {
  const align = () => {
    const delta = element.getBoundingClientRect().top - toolbarBottom();
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  };
  align();
  requestAnimationFrame(() => { align(); requestAnimationFrame(align); });
  setTimeout(align, 120);
}
let pendingAnchor='';
function scrollToHash(hash: string) {
  let id = hash.replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch { /* Keep the raw fragment. */ }
  const heading = anchorTargets.get(id);
  if (heading) { jump(heading, undefined, true); return; }
  const target = document.getElementById(id);
  if (target) { scrollElementToToolbar(target); return; }
  const footnote = /^fn-(.+)$/.exec(id);
  if (footnote) {
    const label = footnote[1];
    const segment = segmentOrder.find(item => item.text.includes(`[^${label}]:`) || item.text.includes(`[^${label}]`));
    if (segment) jump(segment, undefined, true);
  }
}
root.addEventListener('click',event => {
  const target = event.target as HTMLElement;
  if (active?.htmlEditor && active.element.contains(target)) return;
  const wikilink = target.closest<HTMLElement>('[data-wikilink]');
  if (wikilink) {
    event.preventDefault();
    const element = wikilink.closest<HTMLElement>('.segment');
    const source = element ? segments.get(element.dataset.id!) : undefined;
    if (source) send({type:'wikilink',target:wikilink.dataset.wikilink,uri:source.sourceUri});
    return;
  }
  const toc = target.closest<HTMLElement>('[data-toc-segment]');
  if (toc) {
    event.preventDefault();
    const segment = segments.get(toc.dataset.tocSegment!);
    if (segment) jump(segment, undefined, true);
    return;
  }
  const link = target.closest('a');
  if (link) {
    const href = link.getAttribute('href') ?? '';
    const element = link.closest<HTMLElement>('.segment');
    const segment = element ? segments.get(element.dataset.id!) : undefined;
    if (link.closest('.ProseMirror')) {
      event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && !href.startsWith('#')) {
        if (segment) send({type:'link',href,uri:segment.sourceUri});
      }
      return;
    }
    event.preventDefault();
    if (href.startsWith('#')) { scrollToHash(href); return; }
    if (readOnly || event.ctrlKey || event.metaKey || !segment?.editable) {
      if (segment) send({type:'link',href,uri:segment.sourceUri});
      return;
    }
    const isNew = active?.element !== element;
    activate(element!,segment);
    if (isNew && active?.view) {
      const position = active.view.posAtCoords({left:event.clientX,top:event.clientY});
      if (position) active.view.dispatch(active.view.state.tr.setSelection(TextSelection.near(active.view.state.doc.resolve(position.pos))));
    }
    return;
  }
  const element = target.closest<HTMLElement>('.segment');
  if (element) {
    const isNew = active?.element !== element;
    const task = target.closest<HTMLElement>('li[data-checked]');
    const taskIndex = task && event.clientX < task.getBoundingClientRect().left + 2 ? [...element.querySelectorAll('li[data-checked]')].indexOf(task) : -1;
    activate(element,segments.get(element.dataset.id!)!);
    if (isNew && active?.view) {
      if (taskIndex >= 0) {
        const view = active.view; let index = 0;
        view.state.doc.descendants((node,pos) => {
          if (node.type === schema.nodes.list_item && node.attrs.checked !== null && index++ === taskIndex) view.dispatch(view.state.tr.setNodeMarkup(pos,undefined,{...node.attrs,checked:!node.attrs.checked}));
        });
        return;
      }
      const position = active.view.posAtCoords({left:event.clientX,top:event.clientY});
      if (position) active.view.dispatch(active.view.state.tr.setSelection(TextSelection.near(active.view.state.doc.resolve(position.pos))));
    }
  }
});
root.dataset.vscodeContext=JSON.stringify({webviewSection:'markyou'});
root.addEventListener('keydown',event=>{const task=(event.target as HTMLElement).closest<HTMLElement>('li[role=checkbox]');if(!task||![' ','Enter'].includes(event.key)||readOnly)return;event.preventDefault();event.stopPropagation();const element=task.closest<HTMLElement>('.segment')!;const index=[...element.querySelectorAll('li[data-checked]')].indexOf(task);activate(element,segments.get(element.dataset.id!)!);const view=active?.view;if(view){let current=0;view.state.doc.descendants((node,pos)=>{if(node.type===schema.nodes.list_item&&node.attrs.checked!==null&&current++===index)view.dispatch(view.state.tr.setNodeMarkup(pos,undefined,{...node.attrs,checked:!node.attrs.checked}));});}},true);
root.addEventListener('keydown',event => {
  if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.classList.contains('segment')) activate(event.target,segments.get(event.target.dataset.id!)!);
});
document.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
  const key=event.key.toLowerCase();const target=event.target as HTMLElement;const local=!!target.closest('input,textarea,select,dialog');
  if(key==='s'){event.preventDefault();event.stopPropagation();if(event.shiftKey)saveAsCopy();else commandRegistry.save();return;}
  if(['z','y'].includes(key)){if(local){event.stopPropagation();return;}event.preventDefault();event.stopPropagation();if(!readOnly)send({type:key==='y'||event.shiftKey?'redo':'undo'});}
},true);
document.querySelector('header')?.remove(); document.querySelector('footer')?.remove();
const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
toolbar.setAttribute('aria-label','Document toolbar');
toolbar.replaceChildren();
let toolbarHidden = false;
let focusMode = false;
const toolbarButtons = new Map<string, HTMLButtonElement>();

function toolbarBottom() {
  const candidates = [toolbar, statusbar, readonlyBanner]
    .filter(element => !element.hidden && getComputedStyle(element).display !== 'none')
    .map(element => element.getBoundingClientRect().bottom)
    .filter(bottom => bottom > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}
function chromeHeight() {
  return [toolbar, statusbar, readonlyBanner]
    .filter(element => !element.hidden && getComputedStyle(element).display !== 'none')
    .reduce((sum, element) => sum + element.offsetHeight, 0);
}
function editorTarget(): HTMLElement | undefined {
  if (active?.view?.dom.isConnected) return active.view.dom;
  if (active?.area?.isConnected) return active.area;
  if (active?.element.isConnected) return active.element;
  return undefined;
}
function focusEditor() { editorTarget()?.focus({preventScroll: true}); }

const style = document.createElement('select');
style.className = 'block-style';
style.setAttribute('aria-label', 'Paragraph style');
for (const [value, label] of [['paragraph', 'Paragraph'], ['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3'], ['4', 'Heading 4'], ['5', 'Heading 5'], ['6', 'Heading 6'], ['quote', 'Quote'], ['bullet', 'Bullet list'], ['ordered', 'Ordered list']]) {
  const option = document.createElement('option'); option.value = value; option.textContent = label; style.append(option);
}
toolbar.append(style);

function toolbarButton(label: string, run: () => void, shortcut?: ShortcutId, shortcutText?: string) {
  const element = iconButton(label, run);
  toolbar.append(element);
  const hint = shortcutText ?? (shortcut ? shortcutLabel(shortcut) : '');
  element.title = hint ? `${label} (${hint})` : label;
  if (shortcut) element.setAttribute('aria-keyshortcuts', shortcutAria(shortcut));
  toolbarButtons.set(label, element);
  return element;
}
function command(run: any) {
  if (readOnly || !active?.view) return false;
  run(active.view.state, (transaction:import('prosemirror-state').Transaction)=>active?.view?.dispatch(transaction.setMeta('separateHistory',true)), active.view);
  active.view.focus();
  syncToolbar();
  return true;
}
function toggleContainer(type: typeof schema.nodes.bullet_list) {
  const view = active?.view; if (!view || readOnly) return;
  const inside = Array.from({length: view.state.selection.$from.depth}, (_, i) => view.state.selection.$from.node(i + 1)).some(node => node.type === type);
  command(inside ? (type === schema.nodes.blockquote ? lift : liftListItem(schema.nodes.list_item)) : (type === schema.nodes.blockquote ? wrapIn(type) : wrapInList(type)));
}
function currentBlockStyle(view: EditorView | undefined) {
  if (!view) return 'paragraph';
  const selection = view.state.selection;
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type === schema.nodes.heading) return String(Math.min(6, node.attrs.level));
    if (node.type === schema.nodes.blockquote) return 'quote';
    if (node.type === schema.nodes.bullet_list) return 'bullet';
    if (node.type === schema.nodes.ordered_list) return 'ordered';
  }
  return 'paragraph';
}
style.onchange = () => {
  const value = style.value;
  if (value === 'paragraph') command(setBlockType(schema.nodes.paragraph));
  else if (/^[1-6]$/.test(value)) command(setBlockType(schema.nodes.heading, {level: Number(value)}));
  else if (value === 'quote') toggleContainer(schema.nodes.blockquote);
  else if (value === 'bullet') toggleContainer(schema.nodes.bullet_list);
  else if (value === 'ordered') toggleContainer(schema.nodes.ordered_list);
  syncToolbar();
};

function syncToolbar() {
  const view = readOnly ? undefined : active?.view;
  style.disabled = !view;
  style.title = view ? 'Paragraph style' : 'Paragraph style — click a text block first';
  if (view) style.value = currentBlockStyle(view);
  const marks = view ? (view.state.storedMarks ?? view.state.selection.$from.marks()) : [];
  const setMark = (label: string, markName: string) => {
    const element = toolbarButtons.get(label); if (!element) return;
    element.disabled = !view;
    element.setAttribute('aria-pressed', String(marks.some(mark => mark.type.name === markName)));
    element.title = `${label} (${shortcutLabel(label === 'Bold' ? 'bold' : 'italic')})${view ? '' : ' — click a text block first'}`;
  };
  setMark('Bold', 'strong');
  setMark('Italic', 'em');
  const format = toolbarButtons.get('Format');
  if (format) {
    format.disabled = readOnly;
    format.title = readOnly ? 'Formatting — read-only' : view ? 'Formatting' : 'Formatting — click a text block first';
  }
  const insert = toolbarButtons.get('Insert');
  if (insert) {
    insert.disabled = readOnly;
    insert.title = `Insert (${shortcutLabel('insert')})${readOnly ? ' — read-only' : ''}`;
  }
}
document.addEventListener('selectionchange', syncToolbar);
toolbarButton('Bold', () => command(toggleMark(schema.marks.strong)), 'bold');
toolbarButton('Italic', () => command(toggleMark(schema.marks.em)), 'italic');

const formatMenu = document.createElement('div');
formatMenu.className = 'insert-menu format-menu';
formatMenu.hidden = true;
document.body.append(formatMenu);
const formatEntries: [string, 'strike' | 'code' | 'highlight' | 'sup' | 'sub'][] = [
  ['Strikethrough', 'strike'],
  ['Inline code', 'code'],
  ['Highlight', 'highlight'],
  ['Superscript', 'sup'],
  ['Subscript', 'sub'],
];
const formatButtons = new Map<string, HTMLButtonElement>();
for (const [label, mark] of formatEntries) {
  const item = document.createElement('button');
  item.type = 'button'; item.textContent = label;
  item.onclick = () => command(toggleMark(schema.marks[mark]));
  formatMenu.append(item);
  formatButtons.set(mark, item);
}
const clearFormat = document.createElement('button');
clearFormat.type = 'button'; clearFormat.textContent = 'Clear formatting';
clearFormat.onclick = () => {
  const view = active?.view; if (!view || readOnly) return;
  const {from, to} = view.state.selection;
  view.dispatch(view.state.tr.removeMark(from, to)); view.focus(); syncToolbar();
};
formatMenu.append(clearFormat);
const formatButton = iconButton('Format', () => {});
toolbar.append(formatButton);
toolbarButtons.set('Format', formatButton);
formatButton.title = 'Formatting';
popover(formatButton, formatMenu, {
  onOpen: () => {
    const view = readOnly ? undefined : active?.view;
    const marks = view ? (view.state.storedMarks ?? view.state.selection.$from.marks()) : [];
    for (const [mark, button] of formatButtons) {
      button.disabled = !view;
      button.setAttribute('aria-pressed', String(marks.some(item => item.type.name === mark)));
    }
    clearFormat.disabled = !view;
  },
  restoreFocus: editorTarget,
});
function openFormatMenu() {
  if (readOnly || !active?.view) { toast('Click a text block first to use formatting.', 'info'); return; }
  formatButton.click();
}

async function ask(title:string,fields:{name:string;label:string;value?:string}[],submitLabel='Insert') {
  const dialog = document.createElement('dialog'); const form = document.createElement('form'); form.method = 'dialog';
  dialog.setAttribute('aria-labelledby','inline-form-title');
  const heading = document.createElement('h3'); heading.id = 'inline-form-title'; heading.textContent = title; form.append(heading);
  for (const field of fields) {
    const label = document.createElement('label'); label.textContent = field.label;
    const input = document.createElement('input'); input.name = field.name; input.value = field.value ?? ''; input.required = true; label.append(input); form.append(label);
  }
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close('cancel');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = submitLabel; form.append(cancel,submit); dialog.append(form); document.body.append(dialog);
  form.onsubmit = () => dialog.returnValue = 'insert';
  return new Promise<Record<string,string> | undefined>(resolve => {
    dialog.addEventListener('close',() => { const values = Object.fromEntries(new FormData(form).entries()) as Record<string,string>; const accepted = dialog.returnValue === 'insert'; dialog.remove(); resolve(accepted ? values : undefined); });
    dialog.showModal();
  });
}
interface Field {
  name: string;
  label: string;
  value?: string;
  kind?: 'text' | 'textarea' | 'select' | 'checkbox';
  options?: {value: string; label: string}[];
  list?: string[];
  required?: boolean;
  placeholder?: string;
}
async function formDialog(title: string, fields: Field[], submitLabel = 'Insert') {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'form-dialog-title');
  const form = document.createElement('form'); form.method = 'dialog';
  const heading = document.createElement('h2'); heading.id = 'form-dialog-title'; heading.textContent = title; form.append(heading);
  for (const field of fields) {
    const label = document.createElement('label'); label.textContent = field.label;
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (field.kind === 'textarea') { input = document.createElement('textarea'); input.rows = 4; input.value = field.value ?? ''; }
    else if (field.kind === 'select') {
      input = document.createElement('select');
      for (const option of field.options ?? []) { const item = document.createElement('option'); item.value = option.value; item.textContent = option.label; input.append(item); }
      input.value = field.value ?? field.options?.[0]?.value ?? '';
    } else if (field.kind === 'checkbox') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = field.value === 'true';
    } else {
      input = document.createElement('input'); input.type = 'text'; input.value = field.value ?? '';
      if (field.placeholder) input.placeholder = field.placeholder;
    }
    input.name = field.name;
    input.required = Boolean(field.required) && field.kind !== 'checkbox';
    if (field.kind === 'textarea') input.className = 'form-textarea';
    if (field.list?.length && input instanceof HTMLInputElement) {
      const list = document.createElement('datalist'); list.id = `list-${field.name}-${Math.random().toString(36).slice(2)}`;
      for (const value of field.list) { const option = document.createElement('option'); option.value = value; list.append(option); }
      input.setAttribute('list', list.id); label.append(list);
    }
    label.append(input); form.append(label);
  }
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close('cancel');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = submitLabel; form.append(cancel, submit);
  dialog.append(form); document.body.append(dialog);
  form.onsubmit = () => { dialog.returnValue = 'insert'; };
  return new Promise<Record<string, string> | undefined>(resolve => {
    dialog.addEventListener('close', () => {
      const data = new FormData(form);
      const values: Record<string, string> = {};
      for (const field of fields) values[field.name] = field.kind === 'checkbox' ? String(data.has(field.name)) : String(data.get(field.name) ?? '');
      const accepted = dialog.returnValue === 'insert';
      dialog.remove();
      resolve(accepted ? values : undefined);
    });
    dialog.showModal();
    const first = form.querySelector<HTMLElement>('input,textarea,select'); first?.focus();
  });
}
interface InsertEntry {
  button: HTMLButtonElement;
  group?: string;
  context?: 'table' | 'list';
  check?: (state: any) => boolean;
  requiresView?: boolean;
}
const insertMenu = document.createElement('div');
insertMenu.className = 'insert-menu';
insertMenu.hidden = true;
document.body.append(insertMenu);
const insertEntries: InsertEntry[] = [];
let currentInsertGroup: HTMLElement = insertMenu;
function addGroup(label: string) {
  const group = document.createElement('div');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const heading = document.createElement('div');
  heading.className = 'insert-group';
  heading.setAttribute('aria-hidden', 'true');
  heading.textContent = label;
  group.append(heading);
  insertMenu.append(group);
  currentInsertGroup = group;
}
function addInsert(label: string, run: () => void, options: {context?: 'table' | 'list'; check?: (state: any) => boolean; requiresView?: boolean} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = run;
  currentInsertGroup.append(button);
  insertEntries.push({button, ...options});
  return button;
}
function insertBlock(factory: (view: EditorView) => unknown) {
  const view = active?.view;
  if (!view || readOnly) return;
  factory(view);
  view.focus();
  syncToolbar();
}
function insertMarkdownBlock(text: string, position: 'before' | 'after' | 'start' | 'end' = 'after') {
  if (readOnly) { toast('This view is read-only.', 'info'); return; }
  const current = active?.segment;
  deactivate();
  void request('insert-block', {uri: current?.sourceUri, after: current?.pieceId, position, text}).then(
    () => toast('Inserted.', 'success'),
    reason => error(String(reason)),
  );
}
function insertInlineMarkdown(text: string) {
  const view = active?.view;
  if (!view || readOnly) {
    insertMarkdownBlock(text);
    return;
  }
  view.dispatch(view.state.tr.insertText(text)); view.focus(); syncToolbar();
}
function insertTable(rows: number, columns: number) {
  insertMarkdownBlock(tableMarkdownFor(rows, columns));
}
function tableMarkdownFor(rows: number, columns: number) {
  const header = Array.from({length: columns}, (_, index) => `Column ${index + 1}`);
  const lines = [`| ${header.join(' | ')} |`, `| ${Array.from({length: columns}, () => '---').join(' | ')} |`];
  for (let row = 1; row < rows; row++) lines.push(`| ${Array.from({length: columns}, () => ' ').join(' | ')} |`);
  return lines.join('\n');
}
function tableSizeDialog() {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'table-size-title');
  const h = document.createElement('h2'); h.id = 'table-size-title'; h.textContent = 'Insert table';
  const hint = document.createElement('p'); hint.className = 'dialog-hint'; hint.textContent = 'Choose the number of rows and columns. The first row is the header.';
  const grid = document.createElement('div'); grid.className = 'table-size-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Table size');
  for (let row = 1; row <= 10; row++) for (let column = 1; column <= 10; column++) {
    const cell = document.createElement('button'); cell.type = 'button';
    cell.setAttribute('aria-label', `${row} rows by ${column} columns`); cell.title = `${row} × ${column}`;
    cell.onclick = () => { dialog.close(); insertTable(row, column); };
    grid.append(cell);
  }
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(h, hint, grid, cancel); document.body.append(dialog); dialog.showModal(); grid.querySelector('button')?.focus();
}
async function insertCodeBlock() {
  const values = await formDialog('Insert code block', [
    {name: 'language', label: 'Language', kind: 'select', options: codeLanguages.map(value => ({value, label: value === 'plaintext' ? 'Plain text' : value}))},
    {name: 'content', label: 'Code', kind: 'textarea', value: ''},
  ]);
  if (!values || readOnly) return;
  insertMarkdownBlock('```' + values.language + '\n' + values.content + '\n```');
}
async function insertLinkOrImage(choice: 'link' | 'image') {
  const view = active?.view;
  const selectedText = view ? view.state.doc.textBetween(view.state.selection.from, view.state.selection.to) : '';
  let path = '';
  if (choice === 'image' && view) {
    try { path = await request('pick-image', {uri: active!.segment.sourceUri}) ?? ''; }
    catch (reason) { error(String(reason)); return; }
  }
  const values = await ask(choice === 'link' ? 'Insert link' : 'Insert image', [
    {name: 'text', label: choice === 'link' ? 'Link text' : 'Alt text', value: selectedText || (path ? path.split('/').pop() : '')},
    {name: 'url', label: 'URL / relative path', value: path}
  ]);
  if (!values || readOnly) return;
  if (/^(?:javascript|vbscript|data):/i.test(values.url.trim())) { error('Enter a safe link or local image path.'); return; }
  if (!view) { insertMarkdownBlock(choice === 'image' ? `![${values.text}](${values.url})` : `[${values.text}](${values.url})`); return; }
  const node = choice === 'image' ? schema.nodes.image.create({src: values.url, alt: values.text}) : schema.text(values.text, [schema.marks.link.create({href: values.url})]);
  view.dispatch(view.state.tr.replaceSelectionWith(node, false)); view.focus();
}
async function insertMath(inline: boolean) {
  const values = await formDialog(inline ? 'Insert inline math' : 'Insert math block', [
    {name: 'latex', label: 'LaTeX', kind: 'textarea', value: inline ? 'e^{i\\pi}+1=0' : '\\int_0^1 x^2\\,dx', placeholder: '\\frac{a}{b}'},
  ]);
  if (!values || readOnly) return;
  const latex = values.latex.trim();
  if (!latex) return;
  if (inline) insertInlineMarkdown(`$${latex}$`);
  else insertMarkdownBlock(`$$\n${latex}\n$$`);
}
async function insertFootnote() {
  const target=active,view=target?.view;
  if(!target||!view||readOnly){toast('Choose the reference insertion point in a text block first.','info');return;}
  const before=target.segment.text,expected=view.state.doc,selection=view.state.selection;
  const existing=segmentOrder.filter(segment=>segment.sourceUri===target.segment.sourceUri).map(segment=>segment.text).join('');
  let number=1;while(existing.includes(`[^${number}]`))number++;
  const values=await formDialog('Insert footnote',[
    {name:'label',label:'Label',value:String(number),required:true},
    {name:'body',label:'Footnote text',kind:'textarea',value:'',required:true}
  ]);
  if(!values||readOnly)return;
  const label=values.label;
  if(!label||/[\s[\]:]/u.test(label)){error('Use a label without whitespace, brackets or colons. Chinese labels are supported.');return;}
  if(active!==target||view.state.doc!==expected){error('The insertion point changed. Select it again.');return;}
  const marker='MARKYOUFOOTNOTE'+crypto.randomUUID().replace(/-/g,'');
  const draft=view.state.tr.setSelection(selection).replaceSelectionWith(schema.text(marker));
  const text=preserveEdges(before,serializer.serialize(draft.doc).replace(marker,`[^${label}]`));
  deactivate();
  try{await request('insert-footnote',{uri:target.segment.sourceUri,pieceId:target.segment.pieceId,sourceVersion:target.segment.sourceVersion,before,text,label,body:values.body});}
  catch(reason){error(String(reason));}
}
async function insertCallout() {
  const values = await formDialog('Insert callout', [
    {name: 'type', label: 'Type', kind: 'select', options: ['note','tip','warning','important','caution','info','success','danger','bug','example','quote'].map(value => ({value, label: value[0].toUpperCase() + value.slice(1)}))},
    {name: 'title', label: 'Title (optional)', value: ''},
    {name: 'fold', label: 'Collapsed', kind: 'select', options: [{value: '', label: 'Expanded'}, {value: '-', label: 'Collapsed'}, {value: '+', label: 'Expanded by default'}]},
    {name: 'body', label: 'Body', kind: 'textarea', value: ''},
  ]);
  if (!values || readOnly) return;
  const type = values.type || 'note';
  const title = values.title.trim() || type[0].toUpperCase() + type.slice(1);
  const quote = (line: string) => `> ${line}`;
  const body = values.body.split(/\r?\n/).map(quote).join('\n');
  insertMarkdownBlock(`${quote(`[!${type.toUpperCase()}]${values.fold} ${title}`)}${body ? `\n${body}` : ''}`);
}
async function insertAdmonition() {
  const values = await formDialog('Insert admonition', [
    {name: 'type', label: 'Type', value: 'note'},
    {name: 'title', label: 'Title', value: 'Note'},
    {name: 'body', label: 'Body', kind: 'textarea', value: ''},
  ]);
  if (!values || readOnly) return;
  const body = values.body.split(/\r?\n/).map(line => '    ' + line).join('\n');
  insertMarkdownBlock(`!!! ${values.type || 'note'} "${values.title || 'Note'}"${body ? `\n${body}` : ''}`);
}
async function insertDefinitionList() {
  const values = await formDialog('Insert definition list', [
    {name: 'term', label: 'Term', value: '', required: true},
    {name: 'definition', label: 'Definition', kind: 'textarea', value: '', required: true},
  ]);
  if (!values || readOnly) return;
  insertMarkdownBlock(`${values.term}\n: ${values.definition.replace(/\r?\n/g, '\n: ')}`);
}
async function insertWikiLink() {
  let files: string[] = [];
  try { files = (await request('workspace-files')) ?? []; } catch { /* Offline or unreadable workspace. */ }
  const values = await formDialog('Insert wiki link', [
    {name: 'target', label: 'Page', value: '', list: files, placeholder: 'Page or Page#Heading', required: true},
    {name: 'label', label: 'Label (optional)', value: ''},
  ]);
  if (!values || readOnly) return;
  const target = values.target.trim();
  if (!target) return;
  insertInlineMarkdown(values.label.trim() ? `[[${target}|${values.label.trim()}]]` : `[[${target}]]`);
}
async function insertFrontmatter() {
  if (isFrontmatter(segmentOrder[0]?.text ?? '')) {
    toast('Frontmatter already exists. Click the metadata card to edit it.', 'info');
    return;
  }
  const values = await formDialog('Insert frontmatter', [
    {name: 'yaml', label: 'YAML', kind: 'textarea', value: 'title: \ntags: []', required: true},
  ]);
  if (!values || readOnly) return;
  deactivate();void request('insert-block',{position:'start',text:`---\n${values.yaml.trim()}\n---`}).catch(reason=>error(String(reason)));
}

addGroup('Text');
for (const [label, side] of [['Insert paragraph before', 'before'], ['Insert paragraph after', 'after']] as const) {
  addInsert(label, () => insertBlock(view => {
    const position = side === 'before' ? 0 : view.state.doc.content.size;
    view.dispatch(view.state.tr.insert(position, schema.nodes.paragraph.create()));
  }), {requiresView: true});
}
addInsert('Link', () => { void insertLinkOrImage('link'); });
addInsert('Image', () => { void insertLinkOrImage('image'); });
addInsert('Horizontal rule', () => {
  const view = active?.view;
  if (!view) { insertMarkdownBlock('---'); return; }
  insertBlock(current => current.dispatch(current.state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()).scrollIntoView()));
});
addGroup('Lists');
addInsert('Bullet list', () => {
  const view = active?.view;
  if (!view) { insertMarkdownBlock('- Item'); return; }
  command(wrapInList(schema.nodes.bullet_list));
});
addInsert('Ordered list', () => {
  const view = active?.view;
  if (!view) { insertMarkdownBlock('1. Item'); return; }
  command(wrapInList(schema.nodes.ordered_list));
});
addInsert('Task list', () => {
  const view = active?.view;
  if (!view) { insertMarkdownBlock('- [ ] Task'); return; }
  insertBlock(current => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('Task'));
    current.dispatch(current.state.tr.replaceSelectionWith(schema.nodes.bullet_list.create(null, schema.nodes.list_item.create({checked: false}, paragraph))).scrollIntoView());
  });
});
addInsert('Blockquote', () => {
  const view = active?.view;
  if (!view) { insertMarkdownBlock('> Quote'); return; }
  command(wrapIn(schema.nodes.blockquote));
});
addGroup('Blocks');
addInsert('Code block', () => { void insertCodeBlock(); });
addInsert('Table size…', () => tableSizeDialog());
addInsert('Mermaid diagram', () => insertMarkdownBlock('```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```'));
addInsert('Math block', () => { void insertMath(false); });
addGroup('Inline');
addInsert('Inline code', () => command(toggleMark(schema.marks.code)), {requiresView: true});
addInsert('Strikethrough', () => command(toggleMark(schema.marks.strike)), {requiresView: true});
addInsert('Highlight', () => command(toggleMark(schema.marks.highlight)), {requiresView: true});
addInsert('Superscript', () => command(toggleMark(schema.marks.sup)), {requiresView: true});
addInsert('Subscript', () => command(toggleMark(schema.marks.sub)), {requiresView: true});
addInsert('Inline math', () => { void insertMath(true); });
addGroup('Advanced');
addInsert('Callout', () => { void insertCallout(); });
addInsert('Admonition', () => { void insertAdmonition(); });
addInsert('Definition list', () => { void insertDefinitionList(); });
addInsert('Footnote', () => { void insertFootnote(); });
addInsert('Table of contents', () => insertMarkdownBlock('[TOC]'));
addInsert('Wiki link', () => { void insertWikiLink(); });
addInsert('Frontmatter', () => { void insertFrontmatter(); });
const contextual: [string, any, 'table' | 'list'][] = [
  ['Indent', sinkListItem(schema.nodes.list_item), 'list'],
  ['Outdent', liftListItem(schema.nodes.list_item), 'list'],
  ['Add table row', addRowAfter, 'table'],
  ['Add table column', addColumnAfter, 'table'],
  ['Delete table row', deleteRow, 'table'],
  ['Delete table column', deleteColumn, 'table'],
  ['Delete table', deleteTable, 'table'],
];
for (const [label, action, context] of contextual) addInsert(label, () => command(action), {context, check: action, requiresView: true});

function configureInsert() {
  const view = readOnly ? undefined : active?.view;
  const ancestors = view ? Array.from({length: view.state.selection.$from.depth}, (_, i) => view.state.selection.$from.node(i + 1).type.name) : [];
  for (const entry of insertEntries) {
    const inContext = entry.context === 'table' ? ancestors.some(name => name.startsWith('table'))
      : entry.context === 'list' ? ancestors.includes('list_item') : true;
    entry.button.hidden = !inContext;
    entry.button.disabled = readOnly || (!!entry.requiresView && !view) || (!!entry.check && !safeCheck(entry.check, view?.state));
  }
}
function safeCheck(check: (state: any) => boolean, state: any) {
  try { return check(state); } catch { return false; }
}

const insertButton = iconButton('Insert', () => {});
toolbar.append(insertButton);
toolbarButtons.set('Insert', insertButton);
insertButton.setAttribute('aria-keyshortcuts', shortcutAria('insert'));
insertButton.title = `Insert (${shortcutLabel('insert')})`;
popover(insertButton, insertMenu, {
  onOpen: configureInsert,
  restoreFocus: editorTarget,
  onClose: reason => { if (reason === 'escape') focusEditor(); },
});

const jumpAlignTimers: ReturnType<typeof setTimeout>[] = [];
let jumpAlignScrolling = false;
let jumpAlignedScrollY=0;
function cancelJumpAligns() {
  for (const timer of jumpAlignTimers.splice(0)) clearTimeout(timer);
}
window.addEventListener('scroll', () => { if (!jumpAlignScrolling&&Math.abs(window.scrollY-jumpAlignedScrollY)>80) cancelJumpAligns(); }, {passive:true});
for(const event of ['wheel','touchstart','pointerdown'])window.addEventListener(event,cancelJumpAligns,{passive:true});
function jump(segment: Segment, query?: string, alignTop = true) {
  const chunk = segmentChunks.get(segment.id);
  if (!chunk) return;
  mountChunk(chunk);
  const element = elements.get(segment.id);
  if (!element) return;
  cancelJumpAligns();
  jumpAlignedScrollY=window.scrollY;
  const align = () => {
    const target = element.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? element;
    if (alignTop) {
      const delta = target.getBoundingClientRect().top - toolbarBottom();
      if (Math.abs(delta) > 1) {
        jumpAlignScrolling = true;
        window.scrollBy(0, delta);
        jumpAlignedScrollY=window.scrollY;
        setTimeout(() => { jumpAlignScrolling = false; }, 50);
      }
    } else target.scrollIntoView({block: 'center'});
  };
  align();
  requestAnimationFrame(() => { align(); requestAnimationFrame(align); });
  // Content-visibility and lazy chunk mounting can settle after the first two
  // frames. Re-align briefly; any user scroll cancels the pending corrections.
  for (const delay of [80, 160, 260, 380, 520, 680,720]) jumpAlignTimers.push(setTimeout(align, delay));
  element.focus({preventScroll: true});
  root.querySelector('.search-hit')?.classList.remove('search-hit');
  element.classList.add('search-hit');
  if (query) element.setAttribute('aria-label', 'Search match: ' + query);
}

const navigator = new DocumentNavigation({
  jump,
  getEditorTarget: editorTarget,
  getToolbarBottom: toolbarBottom,
  getDocumentRoot: () => root,
  isTrigger: target => target instanceof Element && !!target.closest('[data-navigation-trigger]'),
  onPreferenceChange: patch => {
    if (typeof patch.pinned === 'boolean') send({type: 'preference', key: 'navigationPinned', value: patch.pinned});
    if (patch.mode) send({type: 'preference', key: 'navigationMode', value: patch.mode});
  },
  onVisibilityChange: open => navigateButton.setAttribute('aria-expanded', String(open)),
  onSearch: state => {
    clearFindHighlights();
    activeSearch = state.mode === 'find' && state.query.trim() ? state : undefined;
    if (!activeSearch) return;
    const current = state.currentSegmentId ? segments.get(state.currentSegmentId) : undefined;
    if (current) {
      const chunk = segmentChunks.get(current.id);
      if (chunk) mountChunk(chunk);
    }
    const element = state.currentSegmentId ? elements.get(state.currentSegmentId) ?? null : null;
    const ordinal=current&&state.currentRange?textMatches(state.sourceMode?current.text:visibleText(current.text),state.query,state.matchCase).findIndex(match=>match.start===state.currentRange?.start):0;
    applyFindHighlights(root, state.query, element, state.matchCase,ordinal);
  },
  onReplace: (query, replacement, all, matchCase, current, sourceMode) => {
    if (readOnly) { toast('This view is read-only.', 'info'); return; }
    if (!query.trim()) { toast('Type text to find before replacing.', 'info'); return; }
    const payload={query,replacement,all,matchCase,sourceMode,uri:current?.sourceUri,pieceId:current?.pieceId,sourceVersion:current?.sourceVersion,range:current?.range};
    void (async()=>{
      if(!all)return request('replace',payload);
      const preview=await request('preview-replace',payload);
      if(!preview.count)return {count:0};
      if(preview.files.length>1){
        const accepted=await ask('Review replacements',[{name:'confirm',label:`${preview.count} matches in ${preview.files.length} unique files:\n${preview.files.map((uri:string)=>fileLabel(uri)).join('\n')}\nType REPLACE to confirm.`,value:''}],'Replace all');
        if(accepted?.confirm!=='REPLACE')return {cancelled:true};
      }
      return request('replace',{...payload,plan:preview.plan});
    })().then((result: any) => {
      if(result.cancelled)return;
      if (!result.count && result.visibleOnly) toast('Matches span Markdown syntax. Enable Search source and replace the exact source text.', 'info');
      else if (!result.count && result.skipped) toast(`${result.skipped} match${result.skipped === 1 ? '' : 'es'} sit inside Markdown syntax. Enable Search source to replace them.`, 'info');
      else if (result.skipped) toast(`${result.count} replaced · ${result.skipped} hidden match${result.skipped === 1 ? '' : 'es'} skipped.`, 'success');
      else toast(`${result.count} replacement${result.count === 1 ? '' : 's'} made.`, result.count ? 'success' : 'info');
      navigator.refresh();
    }, reason => error(String(reason)));
  },
});
const navigateButton = toolbarButton('Navigate', () => navigator.toggle(navigator.currentMode, navigateButton), undefined, `${shortcutLabel('find')} / ${shortcutLabel('outline')}`);
navigateButton.setAttribute('data-navigation-trigger', 'true');
navigateButton.setAttribute('aria-keyshortcuts', `${shortcutAria('find')} ${shortcutAria('outline')}`);
navigateButton.setAttribute('aria-expanded', 'false');

function find() { navigator.toggle('find', navigateButton); }
function outline() { navigator.toggle('outline', navigateButton); }
function navigateWithLastMode() { navigator.toggle(navigator.currentMode, navigateButton); }
function toggleInsertMenu() {
  if (readOnly) { toast('This view is read-only.', 'info'); return; }
  insertButton.click();
}
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
  const target = event.target as HTMLElement;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    find();
    return;
  }
  if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    outline();
    return;
  }
  if (mod && event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === 'p') { event.preventDefault(); togglePinnedNavigation(); return; }
    if (key === 't') { event.preventDefault(); toggleToolbarVisibility(); return; }
    if (key === 'i') { event.preventDefault(); toggleInsertMenu(); return; }
    if (key === 'f') { event.preventDefault(); toggleFocusMode(); return; }
    if (key === 'o') { event.preventDefault(); outline(); return; }
    if (key === 'h') { event.preventDefault(); showHelp(); return; }
    if (key === 'e') { event.preventDefault(); pdfDialog(send); return; }
  }
  if (event.key === '?' && !mod && !event.altKey && !target.closest('input,textarea,select,[contenteditable="true"]')) {
    event.preventDefault();
    showHelp();
  }
});
const more = document.createElement('div');
more.className = 'insert-menu more-menu';
more.hidden = true;
document.body.append(more);
const moreButton = iconButton('More', () => {});
toolbar.append(moreButton);
toolbarButtons.set('More', moreButton);
moreButton.title = 'More actions';
const moreItems = new Map<string, HTMLButtonElement>();
function moreItem(label: string, run: () => void, options: {key?: string; shortcut?: ShortcutId; editable?: boolean} = {}) {
  const item = document.createElement('button');
  item.type = 'button';
  item.textContent = label;
  item.onclick = run;
  if (options.shortcut) {
    item.title = `${label} (${shortcutLabel(options.shortcut)})`;
    item.setAttribute('aria-keyshortcuts', shortcutAria(options.shortcut));
  }
  if (options.editable) item.dataset.editable = 'true';
  more.append(item);
  if (options.key) moreItems.set(options.key, item);
  return item;
}
const undoItem = moreItem('Undo', () => { if (!readOnly) send({type: 'undo'}); }, {key: 'undo', shortcut: 'undo'});
const redoItem = moreItem('Redo', () => { if (!readOnly) send({type: 'redo'}); }, {key: 'redo', shortcut: 'redo'});
moreItem('Export PDF', () => pdfDialog(send), {shortcut: 'exportPdf'});
moreItem('Manage includes', () => { void manageIncludes(); });
const readingWidthItem = moreItem('Reading width: Standard', () => cycleReadingWidth());
readingWidthItem.setAttribute('aria-pressed', 'false');
const focusItem = moreItem('Focus mode', () => toggleFocusMode(), {key: 'focusMode', shortcut: 'focusMode'});
moreItem('Text size', () => textSizeDialog());
moreItem('Select all document', () => selectAllDocument());
moreItem('Copy document as Markdown', () => copyDocument());
const readOnlyItem = moreItem('Read-only preview', () => setMode(!userReadOnly), {key: 'readOnly'});
moreItem('Save as copy…', () => saveAsCopy());
moreItem('Edit link…', () => { void editLink(); }, {key: 'editLink', editable: true});
moreItem('Block actions',()=>blockActions(active?.segment),{editable:true});
moreItem('Reveal source', () => {
  if (active) send({type: 'reveal', uri: active.segment.sourceUri, pieceId: active.segment.pieceId});
}, {key: 'reveal', editable: true});
moreItem('Help', () => showHelp(), {shortcut: 'help'});
moreItem('Export complete Markdown…',()=>{void request('export-markdown').then(done=>toast(done?'Complete Markdown exported.':'Export cancelled.',done?'success':'info'),reason=>error(String(reason)));});
moreItem('About', () => information(productName, `${productVersion || '1.0.0'} · Local-first Markdown with editable includes.`));
moreItem('Hide toolbar', () => setToolbarHidden(true), {shortcut: 'toggleToolbar'});
popover(moreButton, more, {
  onOpen: () => {
    undoItem.disabled = readOnly || historyState.undo === 0;
    redoItem.disabled = readOnly || historyState.redo === 0;
    focusItem.textContent = focusMode ? 'Exit focus mode' : 'Focus mode';
    focusItem.title = `${focusItem.textContent} (${shortcutLabel('focusMode')})`;
    readOnlyItem.textContent = userReadOnly ? 'Enable editing' : 'Read-only preview';
    const reveal = moreItems.get('reveal');
    if (reveal) {
      reveal.disabled = !active;
      reveal.title = active ? 'Reveal the active block in its source file' : 'Click a text block first';
    }
    const editLinkItem = moreItems.get('editLink');
    if (editLinkItem) {
      editLinkItem.disabled = !active?.view || readOnly;
      editLinkItem.title = editLinkItem.disabled ? 'Click a text block first' : 'Edit the link at the cursor';
    }
  },
});
async function manageIncludes(){
  const dialog=document.createElement('dialog');
  dialog.setAttribute('aria-labelledby','includes-title');
  const title=document.createElement('h2');title.id='includes-title';title.textContent='Manage includes';
  const hint=document.createElement('p');hint.className='dialog-hint';hint.textContent='Each @import combines another Markdown file into this view. Edits are saved back to the file that owns the block.';
  const source=document.createElement('select');source.setAttribute('aria-label','Include source file');
  const openSource=document.createElement('button');openSource.type='button';openSource.textContent='Open source';openSource.onclick=()=>{if(source.value)send({type:'open-source',uri:source.value});};
  const rows=document.createElement('div');rows.className='include-rows';
  const position=document.createElement('select');position.setAttribute('aria-label','New Include position');
  const path=document.createElement('input');path.placeholder='./chapter.md';path.setAttribute('aria-label','Include path');
  const create=document.createElement('input');create.type='checkbox';create.id='include-create';
  const createLabel=document.createElement('label');createLabel.className='inline-check';createLabel.append(create,document.createTextNode('Create immediately if missing; undo removes the reference, not the file'));
  const add=document.createElement('button');add.textContent='Add include';add.type='button';
  const close=document.createElement('button');close.textContent='Close';close.type='button';close.onclick=()=>dialog.close();
  const actions=document.createElement('div');actions.className='dialog-row';actions.append(add,close);
  let sources:any[]=[];
  const refresh=async()=>{
    sources=await request('includes');
    const selected=source.value;
    source.replaceChildren();
    for(const item of sources){
      const option=document.createElement('option');
      option.value=item.uri;
      let label=fileLabel(item.uri);
      try{label=decodeURIComponent(new URL(item.uri).pathname).split('/').filter(Boolean).slice(-2).join('/');}catch{/* Keep the basename. */}
      option.textContent=`${'  '.repeat(item.depth??0)}${label}${item.repeated?' · repeated':''}${item.dirty?' · unsaved':''}${item.conflict?' · conflict':''}`;option.title=item.uri;source.append(option);
    }
    source.value=sources.some(item=>item.uri===selected)?selected:(active?.segment.sourceUri??source.options[0]?.value);
    paint();
  };
  const paint=()=>{
    rows.replaceChildren();
    const imports=sources.find(item=>item.uri===source.value)?.imports??[];
    position.replaceChildren();const end=document.createElement('option');end.value='end';end.textContent='At end of selected source';position.append(end);
    for(const item of imports)for(const side of ['before','after']){const option=document.createElement('option');option.value=side+':'+item.id;option.textContent=`${side} ${item.path}`;position.append(option);}
    if(!imports.length){const empty=document.createElement('p');empty.className='dialog-hint';empty.textContent='No includes yet. Add a relative .md path below.';rows.append(empty);}
    for(const item of imports){
      const row=document.createElement('div');row.className='include-row';
      const label=document.createElement('span');label.textContent=item.path+(item.repeated?' · repeated':'')+(item.error?' · '+item.error:'');label.title=item.path;
      const open=document.createElement('button');open.type='button';open.textContent='Open';
      open.onclick=()=>send({type:'open-include',uri:source.value,path:item.path});
      const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.disabled=readOnly;
      const version=sources.find(entry=>entry.uri===source.value)?.version;
      remove.title='Remove reference only; the source file remains on disk';
      remove.onclick=()=>{if(!readOnly)void request('include-edit',{action:'remove',uri:source.value,pieceId:item.id,sourceVersion:version}).then(refresh,reason=>error(String(reason)));};
      const locate=document.createElement('button');locate.type='button';locate.textContent='Locate';locate.onclick=()=>{const segment=segmentOrder.find(segment=>segment.sourceUri===item.target);if(segment){dialog.close();jump(segment);}};
      row.append(label,locate,open,remove);
      for(const [label,action]of [['Edit path','edit'],['Move up','up'],['Move down','down']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=readOnly;button.onclick=async()=>{let path=item.path;if(action==='edit'){const values=await ask('Edit Include path',[{name:'path',label:'Include path',value:path}],'Apply');if(!values)return;path=values.path;}void request('include-edit',{action,uri:source.value,pieceId:item.id,sourceVersion:version,path}).then(refresh,reason=>error(String(reason)));};row.append(button);}
      rows.append(row);
    }
    add.disabled=readOnly||!source.value;path.disabled=readOnly||!source.value;create.disabled=readOnly||!source.value;openSource.disabled=!source.value;
  };
  source.onchange=paint;
  add.onclick=()=>{
    if(readOnly||!path.value.trim()||add.disabled)return;
    add.disabled=true;
    const [side,id]=position.value.split(':');
    void request('include-edit',{action:'add',create:create.checked,uri:source.value,sourceVersion:sources.find(item=>item.uri===source.value)?.version,path:path.value,after:id,position:side}).then(()=>{path.value='';create.checked=false;void refresh();},reason=>{error(String(reason));add.disabled=false;});
  };
  dialog.addEventListener('close',()=>dialog.remove());
  dialog.append(title,hint,source,openSource,rows,path,position,createLabel,actions);
  document.body.append(dialog);dialog.showModal();
  try{await refresh();}catch(reason){error(String(reason));dialog.close();}
}
const showToolbarButton = document.createElement('button');
showToolbarButton.type = 'button';
showToolbarButton.className = 'floating-chrome show-toolbar';
showToolbarButton.textContent = 'Show toolbar';
showToolbarButton.hidden = true;
showToolbarButton.setAttribute('aria-keyshortcuts', shortcutAria('toggleToolbar'));
showToolbarButton.title = `Show toolbar (${shortcutLabel('toggleToolbar')})`;
showToolbarButton.onclick = () => setToolbarHidden(false);
document.body.append(showToolbarButton);

const focusExitButton = document.createElement('button');
focusExitButton.type = 'button';
focusExitButton.className = 'floating-chrome exit-focus';
focusExitButton.textContent = 'Exit focus mode';
focusExitButton.hidden = true;
focusExitButton.setAttribute('aria-keyshortcuts', shortcutAria('focusMode'));
focusExitButton.title = `Exit focus mode (${shortcutLabel('focusMode')})`;
focusExitButton.onclick = () => toggleFocusMode();
document.body.append(focusExitButton);

function updateChrome() {
  showToolbarButton.hidden = !toolbarHidden || focusMode;
  focusExitButton.hidden = !focusMode;
}
function applyChromeClass(name: string, enabled: boolean) {
  const before = chromeHeight();
  document.body.classList.toggle(name, enabled);
  const after = chromeHeight();
  // Removing persistent chrome must not move the reader's text.
  if (before !== after && window.scrollY > 0) window.scrollBy(0, after - before);
}
function setToolbarHidden(hidden: boolean, persist = true) {
  toolbarHidden = hidden;
  applyChromeClass('toolbar-hidden', hidden);
  if (hidden) focusEditor();
  else {
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || focused === showToolbarButton || focused === document.body) focusEditor();
  }
  updateChrome();
  if (persist) send({type: 'preference', key: 'toolbarHidden', value: hidden});
}
function toggleToolbarVisibility() { setToolbarHidden(!toolbarHidden); }
function setFocusMode(value: boolean, persist = true) {
  focusMode = value; display.focusMode = value;
  applyChromeClass('focus-mode', value);
  if (value) {
    const focused = document.activeElement as HTMLElement | null;
    if (focused && (toolbar.contains(focused) || navigator.element.contains(focused))) focusEditor();
  } else {
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || focused === focusExitButton || focused === showToolbarButton || focused === document.body) focusEditor();
  }
  updateChrome();
  if (persist) send({type:'display-preference',patch:{focusMode:value}});
}
function toggleFocusMode() { setFocusMode(!focusMode); }
function applyReadingWidth(value: 'narrow'|'standard'|'wide') {
  display.readingWidth = value;
  root.classList.toggle('reading-narrow', value === 'narrow');
  root.classList.toggle('reading-wide', value === 'wide');
  const label = value[0].toUpperCase() + value.slice(1);
  readingWidthItem.textContent = `Reading width: ${label}`;
  readingWidthItem.setAttribute('aria-pressed', String(value !== 'standard'));
  readingWidthItem.title = `Reading width: ${label}`;
}
function cycleReadingWidth(persist = true) {
  const order = ['narrow', 'standard', 'wide'] as const;
  const next = order[(order.indexOf(display.readingWidth) + 1) % order.length];
  applyReadingWidth(next);
  if (persist) send({type:'display-preference',patch:{readingWidth:next}});
}
function applyTextSize(size: number, persist = true) {
  const next = Math.max(12, Math.min(28, Math.round(size)));
  display.textSize = next;
  root.style.fontSize = `${next}px`;
  if (persist) send({type:'display-preference',patch:{textSize:next}});
}
function togglePinnedNavigation() {
  if (navigator.element.hidden) navigator.open(navigator.currentMode, navigateButton);
  navigator.togglePinned();
}
function textSizeDialog() {
  const dialog = document.createElement('dialog');
  const heading = document.createElement('h2');
  heading.textContent = 'Text size';
  const output = document.createElement('output');
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'Close'; close.onclick = () => dialog.close();
  const apply = (size: number) => {
    applyTextSize(size);
    output.textContent = `${display.textSize}px`;
  };
  const row = document.createElement('div');
  row.className = 'dialog-row';
  const smaller = document.createElement('button'); smaller.textContent = 'Smaller'; smaller.onclick = () => apply(display.textSize - 1);
  const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.onclick = () => apply(16);
  const larger = document.createElement('button'); larger.textContent = 'Larger'; larger.onclick = () => apply(display.textSize + 1);
  row.append(smaller, output, larger, reset);
  dialog.setAttribute('aria-labelledby', 'text-size-title');
  heading.id = 'text-size-title';
  dialog.append(heading, row, close);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  output.textContent = `${display.textSize}px`;
  dialog.showModal();
}
function showHelp() {
  const lines = [
    `Save: ${shortcutLabel('save')}`,
    `Save As: ${shortcutLabel('saveAs')}`,
    `Find: ${shortcutLabel('find')} · Outline: ${shortcutLabel('outline')}`,
    `Insert: ${shortcutLabel('insert')} · Pin navigation: ${shortcutLabel('pinNavigation')}`,
    `Toggle toolbar: ${shortcutLabel('toggleToolbar')} · Focus mode: ${shortcutLabel('focusMode')}`,
    `Bold: ${shortcutLabel('bold')} · Italic: ${shortcutLabel('italic')} · Inline code: ${modifierLabel()}+\``,
    `Undo: ${shortcutLabel('undo')} · Redo: ${shortcutLabel('redo')}`,
    `Export PDF: ${shortcutLabel('exportPdf')}`,
    '',
    `Code blocks: Tab / Shift+Tab indent · ${modifierLabel()}+Enter exit the block`,
    'Tables: Tab / Shift+Tab move between cells · Shift+Enter adds a line break in a cell',
    'Task lists: Space or Enter toggles the focused checkbox',
    `${modifierLabel()}+A twice selects the whole document · More → Copy document as Markdown`,
    '',
    'Help is also available from the Command Palette (MarkYou: Help) and the ? key when you are not typing in the document.',
    'Esc closes navigation when it is not pinned. Fixed navigation stays open until you close it or unpin it.',
    'Text fields keep their native undo history. Large blocks open in the native Text Editor.',
  ];
  information('Keyboard shortcuts', lines.join('\n'));
}
function information(title: string, text: string) {
  const dialog = document.createElement('dialog');
  const id = `dialog-title-${Math.random().toString(36).slice(2)}`;
  dialog.setAttribute('aria-labelledby', id);
  const h = document.createElement('h2'); h.id = id; h.textContent = title;
  const p = document.createElement('p'); p.textContent = text; p.className = 'dialog-text';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(h, p, close);
  document.body.append(dialog);
  dialog.showModal();
}
function saveAsCopy() {
  if (document.querySelector('dialog[open]')) return;
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'save-copy-title');
  const h = document.createElement('h2'); h.id = 'save-copy-title'; h.textContent = 'Save As Copy';
  const p = document.createElement('p'); p.className = 'dialog-text';
  p.textContent = 'Writes a copy of the root Markdown file and keeps this editor on the current file.\n\nThe copy must stay in the same folder so relative @import paths keep working. The original file is not changed.';
  const row = document.createElement('div'); row.className = 'dialog-row';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Choose destination…';
  go.onclick = () => { dialog.close(); send({type: 'save-as'}); };
  row.append(cancel, go);
  dialog.append(h, p, row);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  go.focus();
}
function showStatusDetails() {
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'status-details-title');
  const h = document.createElement('h2'); h.id = 'status-details-title'; h.textContent = 'Document status';
  const p = document.createElement('p'); p.className = 'dialog-text';
  const lines: string[] = [];
  if (conflicts.length) lines.push(`${conflicts.length} file${conflicts.length === 1 ? '' : 's'} changed externally. Use the conflict panel to reload, keep, or compare.`);
  if (dirtyFiles.length) {
    lines.push(`Unsaved files (${dirtyFiles.length}):`);
    for (const uri of dirtyFiles) lines.push(`• ${fileLabel(uri)} — ${uri}`);
  }
  if (!lines.length) lines.push(readOnly ? 'This view is read-only. Choose Enable editing to continue.' : 'All changes are saved.');
  p.textContent = lines.join('\n');
  const row = document.createElement('div'); row.className = 'dialog-row';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => dialog.close();
  row.append(close);
  if (dirtyFiles.length && !readOnly) {
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save now';
    save.onclick = () => { dialog.close(); send({type: 'save'}); };
    row.append(save);
  }
  dialog.append(h, p, row);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let documentSelected = false;
function clearDocumentSelection() {
  if (!documentSelected) return;
  documentSelected = false;
  document.body.classList.remove('document-selected');
  for (const element of root.querySelectorAll('.segment.selected')) element.classList.remove('selected');
}
function selectAllDocument() {
  deactivate();
  sourceFeedback();
  documentSelected = true;
  document.body.classList.add('document-selected');
  for (const element of root.querySelectorAll<HTMLElement>('.segment')) element.classList.add('selected');
  toast('Whole document selected for copying. Ctrl+C copies the complete root Markdown, preserving @import.', 'info');
}
function copyDocument() {
  void request('document-markdown').then(text => request('copy', {text: String(text)})).then(() => toast('Document copied as Markdown.', 'success'), reason => toast(`Copy failed: ${String(reason)}`, 'error'));
}
document.addEventListener('copy', event => {
  if (!documentSelected) return;
  event.preventDefault();
  toast('Preparing complete Markdown for copying…', 'info');
  copyDocument();
});
function selectedSourceBoundary(){
  const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;
  const start=selection.anchorNode?.parentElement?.closest<HTMLElement>('.segment'),end=selection.focusNode?.parentElement?.closest<HTMLElement>('.segment');
  const a=start?segments.get(start.dataset.id!):undefined,b=end?segments.get(end.dataset.id!):undefined;
  if(a&&b&&a.sourceUri!==b.sourceUri)return `${a.sourceFile} / ${b.sourceFile}`;
}
document.addEventListener('cut',event=>{const boundary=selectedSourceBoundary();if(!boundary)return;event.preventDefault();event.clipboardData?.setData('text/plain',window.getSelection()?.toString()??'');toast(`Copied selection. Cutting across separate sources is blocked: ${boundary}`,'info');},true);
document.addEventListener('keydown',event=>{if(!event.isComposing&&['Backspace','Delete'].includes(event.key)){const boundary=selectedSourceBoundary();if(boundary){event.preventDefault();event.stopImmediatePropagation();error(`Cannot delete across separate sources: ${boundary}`);}}},true);
document.addEventListener('pointerdown', event => { if (documentSelected && !statusbar.contains(event.target as Node)) clearDocumentSelection(); }, true);
document.addEventListener('keydown', event => { if (documentSelected && event.key === 'Escape') clearDocumentSelection(); }, true);

const commandRegistry: Record<string, () => void> = {
  save: () => {const dialog=document.querySelector('dialog[open]');if(dialog){dialog.dispatchEvent(new Event('apply-draft-and-save'));return;}if(active?.htmlEditor)deactivate();send({type:'save'});},
  'save-as': saveAsCopy,
  bold: () => { command(toggleMark(schema.marks.strong)); },
  italic: () => { command(toggleMark(schema.marks.em)); },
  inlineCode: () => { command(toggleMark(schema.marks.code)); },
  undo: () => { if (!readOnly) send({type: 'undo'}); },
  redo: () => { if (!readOnly) send({type: 'redo'}); },
  find,
  outline,
  navigate: navigateWithLastMode,
  pinNavigation: togglePinnedNavigation,
  toggleToolbar: toggleToolbarVisibility,
  insert: toggleInsertMenu,
  focusMode: toggleFocusMode,
  help: showHelp,
  exportPdf: () => pdfDialog(send),
  manageIncludes: () => { void manageIncludes(); },
  textSize: textSizeDialog,
  readingWidth: cycleReadingWidth,
  readOnly: () => setMode(!userReadOnly),
  hideToolbar: () => setToolbarHidden(true),
  about: () => information(productName, `${productVersion || '1.0.0'} · Local-first Markdown with editable includes.`),
  'select-all-document': () => selectAllDocument(),
  'copy-document': () => copyDocument(),
  'export-markdown':()=>{void request('export-markdown').then(done=>toast(done?'Complete Markdown exported.':'Export cancelled.',done?'success':'info'),reason=>error(String(reason)));},
  format: () => openFormatMenu(),
};

function applyPreferences(preferences: any) {
  if (!preferences || typeof preferences !== 'object') return;
  navigator.setPreferences({
    pinned: typeof preferences.navigationPinned === 'boolean' ? preferences.navigationPinned : undefined,
    mode: preferences.navigationMode === 'outline' || preferences.navigationMode === 'find' ? preferences.navigationMode : undefined,
  });
  if (typeof preferences.toolbarHidden === 'boolean') setToolbarHidden(preferences.toolbarHidden, false);
  if (typeof preferences.version === 'string') productVersion = preferences.version;
  if (typeof preferences.productName === 'string') productName = preferences.productName;
  if(typeof preferences.rootUri==='string')rootDocumentUri=preferences.rootUri;
  if(typeof preferences.rootVersion==='number')rootDocumentVersion=preferences.rootVersion;
  if (preferences.display && typeof preferences.display === 'object') {
    const value = preferences.display;
    if (typeof value.textSize === 'number') applyTextSize(value.textSize, false);
    if (value.readingWidth === 'narrow' || value.readingWidth === 'standard' || value.readingWidth === 'wide') applyReadingWidth(value.readingWidth);
    if (typeof value.focusMode === 'boolean' && value.focusMode !== focusMode) setFocusMode(value.focusMode, false);
    if (typeof value.readOnly === 'boolean' && value.readOnly !== userReadOnly) setMode(value.readOnly, false);
  }
}
syncToolbar();
sourceFeedback();
updateChrome();

let generation:string | undefined;
let restoration:{uri:string;pieceId:string;id:string;text:string;top:number;position:number;areaStart?:number;focus:boolean}|undefined;
let joinRestoration:typeof restoration;
function restorePosition(){
  if(!restoration)return;const saved=restoration;restoration=undefined;
  const candidates=[...segments.values()].filter(segment=>segment.sourceUri===saved.uri);const segment=candidates.find(segment=>segment.id===saved.id&&segment.text===saved.text)??candidates.find(segment=>segment.text===saved.text)??candidates.find(segment=>segment.pieceId===saved.pieceId);if(!segment)return;
  mountChunk(segmentChunks.get(segment.id)!);const element=elements.get(segment.id)!;
  if(saved.focus&&!readOnly){activate(element,segment);if(active?.view){const view=active.view;view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(saved.position,view.state.doc.content.size)))));}else if(active?.area){active.area.setSelectionRange(saved.areaStart??0,saved.areaStart??0);}}
  const align=()=>window.scrollBy(0,element.getBoundingClientRect().top-saved.top);align();requestAnimationFrame(()=>{align();requestAnimationFrame(align);});
}
function appendSegments(batch:Segment[]) {
  const fragment = document.createDocumentFragment();
  let chunk:HTMLElement, group:Segment[] = [];
  const added:HTMLElement[] = [];
  for (const segment of batch) {
    segments.set(segment.id,segment);
    segmentIndices.set(segment.id,segmentOrder.length);segmentOrder.push(segment);
    const key = ownerKey(segment); const owners = ownership.get(key) ?? []; owners.push(segment); ownership.set(key,owners);
    if (group.length === 0 || group.length === 32) {
      chunk = document.createElement('div'); chunk.className = 'chunk'; group = [];
      chunkData.set(chunk,group); fragment.append(chunk); observer.observe(chunk); added.push(chunk);
    }
    group.push(segment); segmentChunks.set(segment.id,chunk!);
  }
  for (const chunk of added) chunk.style.minHeight = `${chunkData.get(chunk)!.reduce((sum,segment) => sum + Math.max(40,segment.text.split('\n').length*24),0)}px`;
  root.append(fragment);
  navigator.add(batch);
}
window.addEventListener('message',event => {
  const message = event.data;
  if(message.type==='navigate-hash'){pendingAnchor=message.hash;scrollToHash(message.hash);return;}
  if(message.type==='drafts'){restoredDrafts(message.drafts??[]);return;}
  if(message.type==='result'){const pending=requests.get(message.id);requests.delete(message.id);if(message.error)pending?.reject(new Error(message.error));else pending?.resolve(message.result);return;}
  if(message.type==='command'){
    const label=message.command;
    if(label==='reveal'){
      const source=message.context?.sourceUri?{uri:message.context.sourceUri,pieceId:message.context.pieceId}:active?{uri:active.segment.sourceUri,pieceId:active.segment.pieceId}:undefined;
      if(source)send({type:'reveal',...source});
      return;
    }
    const action=({Bold:'bold',Italic:'italic',Code:'inlineCode',Insert:'insert'} as Record<string,string>)[label]??label;
    const run=commandRegistry[action];
    if(run)run();
    else toast(`Unknown command: ${label}`,'error');
    return;
  }
  if(message.type==='preferences'){applyPreferences(message.preferences);return;}
  if(message.type==='pdf-options'){setPdfDefaults(message.options);return;}
  if(message.type==='diagram-result'){const pending=diagramRequests.get(message.id);diagramRequests.delete(message.id);if(message.error)pending?.reject(new Error(message.error));else pending?.resolve(message.svg);return;}
  if(message.type==='open-export'){pdfDialog(send);return;}
  if (message.type === 'document') {
    if(joinRestoration){restoration=joinRestoration;joinRestoration=undefined;}else if(!message.readOnly){const item=active??[...elements].map(([id,element])=>({segment:segments.get(id)!,element})).find(item=>item.element.getBoundingClientRect().bottom>45&&item.element.getBoundingClientRect().top<innerHeight);if(item)restoration={uri:item.segment.sourceUri,pieceId:item.segment.pieceId,id:item.segment.id,text:item.segment.text,top:item.element.getBoundingClientRect().top,position:active?.view?.state.selection.from??1,areaStart:active?.area?.selectionStart,focus:!!active};}
    const scroll = window.scrollY; const focus = active?.segment.id;
    const savedDraft = active?.area?.value;
    generation = message.generation;
    readOnly = !!message.readOnly || userReadOnly;documentTitle=message.title;sourceFeedback();
    deactivate(); contextPending=false; observer.disconnect(); segments = new Map();segmentOrder=[];segmentIndices.clear(); navigator.reset(); ownership = new Map(); elements.clear(); chunkData.clear(); segmentChunks.clear(); root.replaceChildren(); markdownEnv={};anchorTargets.clear();headingSlugs.clear();clearFindHighlights();activeSearch=undefined;
    document.title = message.title;
    appendSegments(message.segments);
    refreshMarkdownContext();
    // Paint the first screen synchronously; parse the rest only near the viewport.
    const firstChunk = chunkData.keys().next().value;
    if (firstChunk) mountChunk(firstChunk);
    if (!restoration && focus && segments.has(focus)) { mountChunk(segmentChunks.get(focus)!); activate(elements.get(focus)!,segments.get(focus)!); if (savedDraft && active?.area) active.area.value = savedDraft; }
    window.scrollTo(0,scroll || vscode.getState()?.scroll || 0);
    status.textContent = readOnly ? 'Read-only preview' : 'Ready';
    renderStatus();
    performance.mark('markyou-first-screen');
    const phase = readOnly ? 'readable' : 'editable';
    requestAnimationFrame(() => send({type:'metrics',phase,timestamp:Date.now()}));
  } else if (message.type === 'append') {
    if (message.generation === generation) {
      appendSegments(message.segments);
    }
  } else if(message.type==='index-complete'&&message.generation===generation){refreshMarkdownContext();restorePosition();if(pendingAnchor){scrollToHash(pendingAnchor);pendingAnchor='';}
  } else if(message.type==='pieces'){
    const affected=new Set([...message.removed,...message.updated.map((piece:any)=>piece.id)]);
    if(active&&active.segment.sourceUri===message.uri&&affected.has(active.segment.pieceId)){restoration=joinRestoration??{uri:active.segment.sourceUri,pieceId:active.segment.pieceId,id:active.segment.id,text:active.segment.text,top:active.element.getBoundingClientRect().top,position:active.view?.state.selection.from??1,focus:true};deactivate();}joinRestoration=undefined;
    for(const segment of [...segmentOrder]){if(segment.sourceUri!==message.uri)continue;const chunk=segmentChunks.get(segment.id)!;const list=chunkData.get(chunk)!;
      if(message.removed.includes(segment.pieceId)){elements.get(segment.id)?.remove();elements.delete(segment.id);segments.delete(segment.id);navigator.remove(segment.id);list.splice(list.indexOf(segment),1);continue;}
      const update=message.updated.find((piece:any)=>piece.id===segment.pieceId);if(update){segment.text=update.raw;segment.sourceVersion=message.version;navigator.index(segment);const element=elements.get(segment.id);if(element)render(element,segment);}
      for(const item of message.added.filter((item:any)=>item.after===segment.pieceId)){const addition:Segment={...segment,id:segment.includeInstanceId+':'+item.piece.id,pieceId:item.piece.id,text:item.piece.raw,editable:item.piece.editable,blockType:item.piece.blockType};segments.set(addition.id,addition);segmentChunks.set(addition.id,chunk);list.splice(list.indexOf(segment)+1,0,addition);segmentOrder.splice(segmentOrder.indexOf(segment)+1,0,addition);const element=elements.get(segment.id);if(element)element.after(makeSegment(addition));navigator.index(addition);}
    }
    segmentOrder=segmentOrder.filter(segment=>segments.has(segment.id));segmentIndices.clear();segmentOrder.forEach((segment,index)=>segmentIndices.set(segment.id,index));ownership=new Map();for(const segment of segmentOrder){const key=ownerKey(segment);const entries=ownership.get(key)??[];entries.push(segment);ownership.set(key,entries);}navigator.reorder(segmentOrder.map(segment=>segment.id));refreshMarkdownContext();restorePosition();
  } else if (message.type === 'patch') {
    if(message.uri===rootDocumentUri)rootDocumentVersion=message.version;
    for(const segment of segmentOrder)if(segment.sourceUri===message.uri){segment.sourceVersion=message.version;}
    if (message.origin === origin) return;
    for (const segment of ownership.get(`${message.uri}::${message.pieceId}`) ?? []) {
      if (segment.text === message.text) continue;
      segment.text = message.text; segment.sourceVersion = message.version;navigator.index(segment);
      const element = elements.get(segment.id);
      if (!element) continue;
      if (active?.element === element && !active.region) {
        if (active.area) active.area.value = message.text;
        if (active.view) {
          const selection = Math.min(active.view.state.selection.from,parser.parse(message.text).content.size);
          let state = EditorState.create({schema,doc:parser.parse(message.text),plugins:active.view.state.plugins});
          state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(selection))));
          active.view.updateState(state);
        }
      } else render(element,segment);
    }
    if(active?.region&&active.view&&active.segment.sourceUri===message.uri){
      const view=active.view,doc=parser.parse(active.region.map(segment=>segment.text).join(''));
      let state=EditorState.create({schema,doc,plugins:view.state.plugins});state=state.apply(state.tr.setSelection(TextSelection.near(doc.resolve(Math.min(view.state.selection.from,doc.content.size)))));view.updateState(state);
    }
    if (activeSearch) requestAnimationFrame(refreshSearchHighlights);
    refreshMarkdownContext();
  } else if (message.type === 'status') {
    if(message.history){historyState=message.history;syncToolbar();}
    dirtyFiles=Array.isArray(message.dirty)?message.dirty:[];
    conflicts=Array.isArray(message.conflicts)?message.conflicts:[];
    if(lastDirtyCount!==undefined&&lastDirtyCount>0&&!dirtyFiles.length&&!conflicts.length)toast('All changes saved','success');
    lastDirtyCount=dirtyFiles.length;
    renderStatus();
    const signature = JSON.stringify(conflicts.map(item => [item.uri, !!item.deleted]));
    if (signature !== lastConflictSignature) {
      lastConflictSignature = signature;
      const container = document.querySelector('#conflicts')!; container.replaceChildren();
      for (const conflict of conflicts) {
        const row = document.createElement('div'); const label = document.createElement('span');
        label.textContent = `${fileLabel(conflict.uri)} ${conflict.deleted ? 'was deleted' : 'changed externally'}. Choose an action:`; row.append(label);
        for (const [choice,text] of [['reload','Reload external version'],['keep','Keep editor version'],['diff','View diff']]) {
          const button = document.createElement('button'); button.textContent = text;
          button.onclick = () => send({type:'conflict',uri:conflict.uri,choice}); row.append(button);
        }
        container.append(row);
      }
    }
  } else if (message.type === 'benchmark') {
    const percentile = (values:number[]) => values.sort((a,b) => a-b)[Math.floor(values.length*.95)];
    void (async () => {
      try {
        const first = [...segments.values()].find(segment => segment.editable && !segment.error && segment.text.trim());
        if (!first) throw new Error('No editable block for benchmark.');
        mountChunk(segmentChunks.get(first.id)!); activate(elements.get(first.id)!,first);
        longTasks = [];
        const input:number[] = [], scroll:number[] = [];
        for (let i=0;i<40;i++) {
          const start = performance.now(); document.execCommand('insertText',false,'a');
          await new Promise(requestAnimationFrame); input.push(performance.now()-start);
        }
        for (let i=0;i<40;i++) {
          const start = performance.now(); window.scrollBy(0,Math.min(innerHeight,700));
          await new Promise(requestAnimationFrame); scroll.push(performance.now()-start);
        }
        send({type:'benchmark-result',result:{inputP95Ms:percentile(input),scrollP95Ms:percentile(scroll),maxLongTaskMs:Math.max(0,...longTasks)}});
      } catch (reason) {
        send({type:'benchmark-result',result:{inputP95Ms:0,scrollP95Ms:0,maxLongTaskMs:0,error:String(reason)}});
      }
    })();
  } else if (message.type === 'error') error(message.message);
});
let scrollTimer:ReturnType<typeof setTimeout>;
window.addEventListener('scroll',() => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => vscode.setState({...vscode.getState(),scroll:window.scrollY}),150); },{passive:true});
send({type:'ready'});

installLocalization();
