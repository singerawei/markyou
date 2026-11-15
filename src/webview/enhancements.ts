import {diagram,highlight,codeLanguages}from './diagrams';
import {popover} from './popover';
import {trackDraft} from './drafts';
import {createElement,Bold,Italic,Strikethrough,Code,Text,List,Quote,Undo,Redo,FileCode,Plus,Download,Search,ListTree,Maximize,Copy,WrapText,Pencil,ZoomIn,ZoomOut,Expand,MoreHorizontal}from'lucide';
import type{Segment}from'../shared/types';
const icons:Record<string,any>={Bold,Italic,Strikethrough,Code,Paragraph:Text,Format:Text,List,Quote,Undo,Redo,'Reveal source':FileCode,Insert:Plus,'Export PDF':Download,Find:Search,Navigate:ListTree,Outline:ListTree,'Focus mode':Maximize,'Copy source':Copy,Copy,'Wrap lines':WrapText,Edit:Pencil,'Zoom in':ZoomIn,'Zoom out':ZoomOut,'Fit diagram':Expand,'View diagram':Expand,More:MoreHorizontal,'Diagram actions':MoreHorizontal,'Code actions':MoreHorizontal,'Hide toolbar':MoreHorizontal,'Show toolbar':MoreHorizontal,'Exit focus mode':Maximize};
export function iconButton(label:string,run:()=>void){const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.append(createElement(icons[label]??MoreHorizontal,{width:17,height:17,'stroke-width':1.7}));button.onmousedown=event=>event.preventDefault();button.onclick=event=>{event.stopPropagation();run();};return button;}
export type NotifyKind='success'|'info'|'error';
type Hooks={canEdit:()=>boolean;copy:(text:string)=>Promise<unknown>;exportDiagram:(code:string,dark:boolean,format:'svg'|'png')=>Promise<unknown>;notify:(text:string,kind?:NotifyKind,retry?:()=>void)=>void};
let hooks:Hooks={canEdit:()=>true,copy:async text=>navigator.clipboard.writeText(text),exportDiagram:async()=>{throw new Error('Diagram export requires the VS Code host.');},notify:text=>{document.querySelector('#notice')!.textContent=text;}};
export function configureEnhancements(value:Hooks){hooks=value;}
function cleanDialog(dialog:HTMLDialogElement,opener:HTMLElement|null=document.activeElement as HTMLElement|null,cleanup=()=>{}){let finished=false;const finish=()=>{if(finished)return;finished=true;cleanup();dialog.remove();if(opener?.isConnected)opener.focus();};const close=dialog.close.bind(dialog);dialog.close=value=>{close(value);finish();};dialog.addEventListener('close',finish,{once:true});}
// Menus live in the body so `content-visibility` on segments cannot clip them.
// A rendered block owns one menu; stale menus are pruned on the next render.
const blockMenus:{container:HTMLElement;trigger:HTMLElement;dispose:()=>void}[]=[];
function attachMenu(trigger:HTMLElement,container:HTMLElement,dispose:()=>void){
  for(let index=blockMenus.length-1;index>=0;index--){if(!blockMenus[index].trigger.isConnected){blockMenus[index].dispose();blockMenus.splice(index,1);}}
  document.body.append(container);blockMenus.push({container,trigger,dispose});
}
function copyAction(source:string):()=>void{
  const run=()=>{void hooks.copy(source).then(()=>hooks.notify('Copied to clipboard.','success'),reason=>hooks.notify(`Copy failed: ${String(reason)}`,'error',run));};
  return run;
}
export function enhance(element:HTMLElement,segment:Segment,edit:(text:string)=>void){
  const code=element.querySelector<HTMLElement>('pre > code');if(!code)return;
  const language=[...code.classList].find(name=>name.startsWith('language-'))?.slice(9)??'',source=code.textContent??'',pre=code.parentElement!;
  const tools=document.createElement('div');tools.className='block-tools';tools.onclick=event=>event.stopPropagation();
  if(language!=='mermaid'){
    const label=document.createElement('select');label.setAttribute('aria-label','Code language');for(const value of new Set([language,...codeLanguages])){const option=document.createElement('option');option.value=value;option.textContent=value||'plain text';label.append(option);}label.value=language;label.disabled=!hooks.canEdit();label.onchange=()=>{if(!hooks.canEdit())return;edit(segment.text.replace(/^(\s*(?:`{3,}|~{3,}))[^\r\n]*/,`$1${label.value}`));};
    const actions=iconButton('Code actions',()=>{});
    actions.setAttribute('aria-haspopup','menu');
    tools.append(label,actions);pre.prepend(tools);
    const wrapItem=()=>{const item=document.createElement('button');item.type='button';item.textContent='Wrap lines';item.setAttribute('aria-pressed',String(pre.classList.contains('wrap-code')));item.onclick=()=>{pre.classList.toggle('wrap-code');};return item;};
    const wrap=wrapItem();
    const container=document.createElement('div');container.className='insert-menu block-menu';container.hidden=true;
    const copy=document.createElement('button');copy.type='button';copy.textContent='Copy code';copy.onclick=copyAction(source);
    container.append(copy,wrap);
    const api=popover(actions,container,{onOpen:()=>{wrap.setAttribute('aria-pressed',String(pre.classList.contains('wrap-code')));}});
    attachMenu(actions,container,api.dispose);
    const apply=()=>{if(element.contains(code))code.innerHTML=highlight(source,language);};if(source.length<16000)apply();else if(source.length<=128*1024)setTimeout(()=>{if(code.isConnected)apply();},0);return;
  }
  const actions=iconButton('Diagram actions',()=>{});
  actions.setAttribute('aria-haspopup','menu');
  const label=document.createElement('small');label.textContent='mermaid';
  const zoomLabel=document.createElement('span');zoomLabel.className='diagram-zoom';zoomLabel.textContent='100%';
  tools.append(label,zoomLabel,actions);
  const figure=document.createElement('figure');figure.className='diagram-figure';figure.onclick=event=>event.stopPropagation();const canvas=document.createElement('div');canvas.className='diagram-canvas';canvas.textContent='Rendering diagram…';figure.append(tools,canvas);pre.replaceWith(figure);
  const isDark=()=>document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
  let dark=isDark();let scale=1;
  const applyZoom=()=>{zoomLabel.textContent=`${Math.round(scale*100)}%`;const svg=canvas.querySelector('svg');if(svg){svg.style.maxWidth='none';svg.style.width=`${scale*100}%`;}};
  const zoom=(value:number)=>{scale=Math.max(.25,Math.min(4,value));applyZoom();};
  const editing=()=>{
    if(!hooks.canEdit())return;const original=segment.text;const draft=trackDraft(segment,'mermaid');const dialog=document.createElement('dialog');dialog.className='diagram-editor';dialog.setAttribute('aria-labelledby','diagram-editor-title');const title=document.createElement('h2');title.id='diagram-editor-title';title.textContent='Edit Mermaid diagram';
    const area=document.createElement('textarea');area.value=source;area.setAttribute('aria-label','Mermaid source');const preview=document.createElement('div');preview.className='diagram-canvas';let timer:ReturnType<typeof setTimeout>;let revision=0;
    area.oninput=()=>{draft.update(original.replace(source.trimEnd(),area.value.trimEnd()));clearTimeout(timer);const current=++revision;timer=setTimeout(()=>{void diagram(area.value,isDark(),()=>dialog.isConnected&&current===revision).then(svg=>{if(current===revision)preview.innerHTML=svg;},error=>{if(current===revision)preview.textContent=String(error);});},300);};
    const apply=document.createElement('button');apply.textContent='Apply';apply.onclick=()=>{if(!hooks.canEdit()){preview.textContent='Read-only mode: changes were not applied.';return;}if(segment.text!==original){preview.textContent='Source changed while editing. Copy your draft before closing.';return;}edit(original.replace(source.trimEnd(),area.value.trimEnd()));draft.clear();dialog.close();};
    const saveDraft=()=>{apply.click();if(!dialog.open)window.dispatchEvent(new Event('save-document'));};dialog.addEventListener('apply-draft-and-save',saveDraft);area.addEventListener('keydown',event=>{if(!event.isComposing&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();saveDraft();}});
    const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.onclick=()=>{draft.clear();dialog.close();};cleanDialog(dialog,document.activeElement as HTMLElement,()=>{revision++;clearTimeout(timer);});dialog.append(title,area,preview,apply,cancel);document.body.append(dialog);dialog.showModal();area.focus();area.oninput(new Event('input')as any);
  };
  const view=()=>{const dialog=document.createElement('dialog');dialog.className='diagram-editor';dialog.setAttribute('aria-labelledby','diagram-view-title');const title=document.createElement('h2');title.id='diagram-view-title';title.textContent='Diagram';const image=canvas.cloneNode(true);const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.close();cleanDialog(dialog);dialog.append(title,close,image);document.body.append(dialog);dialog.showModal();};
  const exportDiagram=(format:'svg'|'png')=>()=>{const run=()=>{hooks.notify(`Exporting ${format.toUpperCase()}…`,'info');void hooks.exportDiagram(source,dark,format).then(result=>hooks.notify(result===false?'Export cancelled.':'Diagram exported.',result===false?'info':'success'),reason=>hooks.notify(`Export failed: ${String(reason)}`,'error',run));};run();};
  const menuButton=(labelText:string,run:()=>void,allowed=()=>true)=>{const item=document.createElement('button');item.type='button';item.textContent=labelText;item.onclick=run;item.dataset.check='true';item.dataset.allowed=String(allowed());return item;};
  const container=document.createElement('div');container.className='insert-menu block-menu';container.hidden=true;
  const editItem=menuButton('Edit',editing,()=>hooks.canEdit());
  container.append(
    menuButton('Copy source',copyAction(source)),
    editItem,
    menuButton('Zoom in',()=>zoom(scale+.25)),
    menuButton('Zoom out',()=>zoom(scale-.25)),
    menuButton('Fit',()=>zoom(1)),
    menuButton('View',view),
    menuButton('Export SVG',exportDiagram('svg')),
    menuButton('Export PNG',exportDiagram('png')),
  );
  const api=popover(actions,container,{onOpen:()=>{editItem.disabled=!hooks.canEdit();editItem.dataset.allowed=String(hooks.canEdit());}});
  attachMenu(actions,container,api.dispose);
  const renderDiagram=()=>{
    canvas.replaceChildren();
    const loading=document.createElement('p');loading.className='diagram-loading';loading.textContent='Rendering diagram…';canvas.append(loading);
    void diagram(source,dark,()=>figure.isConnected,Math.max(0,figure.getBoundingClientRect().top-innerHeight)).then(svg=>{if(!figure.isConnected)return;canvas.innerHTML=svg;applyZoom();requestAnimationFrame(()=>window.dispatchEvent(new Event('diagram-rendered')));},error=>{
      if(!figure.isConnected)return;
      canvas.replaceChildren();
      const notice=document.createElement('p');notice.className='diagram-error';notice.textContent=`Diagram error: ${String(error)}`;
      const hint=document.createElement('p');hint.className='diagram-error-hint';hint.textContent='Check the Mermaid syntax near the line shown below, then retry.';
      const retry=document.createElement('button');retry.type='button';retry.textContent='Retry';retry.onclick=()=>renderDiagram();
      const raw=document.createElement('pre');raw.className='diagram-source';raw.textContent=source.split('\n').map((line,index)=>`${String(index+1).padStart(3,' ')}  ${line}`).join('\n');
      canvas.append(notice,hint,retry,raw);
    });
  };
  const themeController=new AbortController();
  window.addEventListener('theme-change',()=>{if(!figure.isConnected){themeController.abort();return;}dark=isDark();renderDiagram();},{signal:themeController.signal});
  renderDiagram();
}
let defaults:Record<string,any>={};export function setPdfDefaults(value:Record<string,any>){defaults=value;}
export function pdfDialog(send:(message:unknown)=>void){
  const dialog=document.createElement('dialog');dialog.setAttribute('aria-labelledby','pdf-dialog-title');dialog.innerHTML='<h2 id="pdf-dialog-title">Export PDF</h2><form method="dialog"><label>Paper size<select name="format"><option>A4</option><option>A3</option><option>Letter</option></select></label><label>Margin (mm)<input name="margin" type="number" min="0" max="60" required value="20"></label><label>Font size<input name="fontSize" type="number" min="8" max="32" required value="14"></label><label>Header<input name="header"></label><label>Footer<input name="footer"></label><label><input name="landscape" type="checkbox"> Landscape</label><label><input name="pageNumbers" type="checkbox" checked> Page numbers</label><label><input name="headingBreak" type="checkbox"> Page break before H1</label><label><input name="allowMissingResources" type="checkbox"> Keep placeholders for missing images or invalid diagrams</label><button type="button" data-preflight>Check document</button><button value="preview">Preview</button><button value="export">Export</button><button type="button" data-cancel>Cancel</button></form>';
  for(const input of dialog.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[name]'))if(input.name in defaults){if(input instanceof HTMLInputElement&&input.type==='checkbox')input.checked=defaults[input.name];else input.value=defaults[input.name];}
  dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick=()=>dialog.close('cancel');
  dialog.querySelector('[data-preflight]')!.addEventListener('click',()=>window.dispatchEvent(new Event('pdf-preflight')));
  dialog.addEventListener('close',()=>{if(['preview','export'].includes(dialog.returnValue)){const data=new FormData(dialog.querySelector('form')!);const options:any=Object.fromEntries(data);options.margin=Number(options.margin);options.fontSize=Number(options.fontSize);for(const key of ['landscape','pageNumbers','headingBreak','allowMissingResources'])options[key]=data.has(key);defaults=options;send({type:'export-pdf',options:{...options,preview:dialog.returnValue==='preview'}});}});cleanDialog(dialog);document.body.append(dialog);dialog.showModal();
}
