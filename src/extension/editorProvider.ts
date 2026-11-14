import * as vscode from 'vscode';
import { dirname,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { CompositeDocument } from './compositeDocument';
import { SourceRepository } from '../document/sourceFile';
import { LocalFileIO, uriForPath } from '../document/fileIO';
import { serializeSource } from '../document/serializer';
import type { PieceEdit } from '../shared/types';
import { visibleText } from '../shared/visibleText';
import { DocumentGraph } from '../document/documentGraph';
import { exportPdf,type PdfOptions } from './pdf';
import { DiagramService } from './diagramService';

export class EditorProvider implements vscode.CustomEditorProvider<CompositeDocument>, vscode.Disposable {
  static readonly viewType = 'markyou.editor';
  private readonly edits = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CompositeDocument>>();
  readonly onDidChangeCustomDocument = this.edits.event;
  private readonly documents = new Set<CompositeDocument>();
  private readonly repositories = new Map<string, SourceRepository>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly snapshots = new Map<string, string>();
  private readonly generations = new WeakMap<vscode.WebviewPanel,string>();
  private readonly pendingFiles = new Map<string,ReturnType<typeof setTimeout>>();
  private readonly diagrams:DiagramService;
  private exporting=false;
  private readonly readOnlyPanels=new WeakSet<vscode.WebviewPanel>();
  private readonly diagramJobs=new Map<string,AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly context: vscode.ExtensionContext) {
    this.diagrams=new DiagramService(context.extensionUri.fsPath);
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFile = (uri: vscode.Uri) => {
      const key = uriForPath(uri.fsPath);
      if (![...this.repositories.values()].some(repository => repository.sources.has(key)) && ![...this.documents].some(document => document.graph.sourceUris.has(key))) return;
      clearTimeout(this.pendingFiles.get(key));
      this.pendingFiles.set(key,setTimeout(() => {
        this.pendingFiles.delete(key);
        void this.enqueue(async () => {
          for (const repository of this.repositories.values()) if (repository.sources.has(key)) await repository.external(key);
          for (const document of this.documents) if (document.graph.sourceUris.has(key) && !document.repository.sources.has(key)) await this.refresh(document);
        });
      },100));
    };
    this.subscriptions.push(watcher,watcher.onDidChange(onFile),watcher.onDidCreate(onFile),watcher.onDidDelete(onFile),
      vscode.workspace.registerTextDocumentContentProvider('markyou-diff',{provideTextDocumentContent: uri => this.snapshots.get(uri.toString()) ?? ''}));
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(error => { void vscode.window.showErrorMessage(`MarkYou: ${String(error)}`); });
    return result;
  }
  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<CompositeDocument> {
    if (uri.scheme !== 'file') throw new Error('MarkYou supports local Markdown files only.');
    const canonical = vscode.Uri.file(await realpath(uri.fsPath).catch(error => {
      if (openContext.backupId && (error as NodeJS.ErrnoException).code === 'ENOENT') return uri.fsPath;
      throw error;
    }));
    const roots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [dirname(canonical.fsPath)];
    const key = roots.slice().sort().join('|');
    let repository = this.repositories.get(key);
    if (!repository) {
      repository = new SourceRepository(new LocalFileIO(roots,sourceUri => {
        if (vscode.workspace.textDocuments.some(doc => uriForPath(doc.uri.fsPath) === sourceUri && doc.isDirty)) {
          throw new Error('The source has unsaved changes in Text Editor. Save or revert those changes first.');
        }
      }));
      const shared = repository;
      repository.on('change',event => {
        for (const document of this.documents) {
          if (document.repository !== shared || !document.trackedSources.has(event.uri)) continue;
          if (event.kind === 'piece') this.post(document,{type:'patch',...event});
          else if(event.kind==='pieces'){
            document.graph.segments=document.graph.segments.flatMap(segment=>{if(segment.sourceUri!==event.uri)return[segment];if(event.removed.includes(segment.pieceId))return[];const piece=event.updated.find((piece:{id:string})=>piece.id===segment.pieceId);const current=piece?{...segment,text:piece.raw,editable:piece.editable,blockType:piece.blockType,sourceVersion:event.version}:segment;return[current,...event.added.filter((item:{after:string})=>item.after===segment.pieceId).map((item:any)=>({...current,id:current.includeInstanceId+':'+item.piece.id,pieceId:item.piece.id,text:item.piece.raw,editable:item.piece.editable,blockType:item.piece.blockType}))];});this.post(document,{type:'pieces',...event});
          }
          else if (event.kind === 'structure') void this.enqueue(() => this.refresh(document));
          if(event.kind!=='piece'&&event.kind!=='pieces')this.post(document,this.status(document));
        }
      });
      this.repositories.set(key,repository);
    }
    const document = new CompositeDocument(canonical,repository);
    this.documents.add(document);
    document.onDidDispose(() => {
      this.documents.delete(document);
      // Only retain source models which still belong to an open composite.
      for (const sourceUri of repository!.sources.keys()) {
        if (![...this.documents].some(other => other.repository === repository && other.trackedSources.has(sourceUri))) repository!.sources.delete(sourceUri);
      }
      if (![...this.documents].some(other => other.repository === repository)) { repository!.removeAllListeners(); this.repositories.delete(key); }
    });
    if (openContext.backupId) {
      await document.graph.build(); document.trackSources();
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
      const backup = JSON.parse(Buffer.from(bytes).toString('utf8')) as {sources:{uri:string;base:string;text:string}[]};
      for (const item of backup.sources) {
        if (item.uri !== document.rootUri) await repository.io.resolve(document.rootUri,relative(dirname(document.uri.fsPath),fileURLToPath(item.uri)));
        await repository.restore(item.uri,item.base,item.text);
        document.trackedSources.add(item.uri);
      }
      await document.graph.build();
      document.trackSources();
    }
    return document;
  }
  async resolveCustomEditor(document: CompositeDocument, panel: vscode.WebviewPanel) {
    const panelRequests=new Set<string>();
    document.panels.add(panel);
    panel.onDidDispose(() => {document.panels.delete(panel);for(const id of panelRequests)this.diagramJobs.get(id)?.abort();});
    const roots = vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? [vscode.Uri.file(dirname(document.uri.fsPath))];
    panel.webview.options = {enableScripts:true,localResourceRoots:[this.context.extensionUri,...roots]};
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(message => {
      if(message.type==='render-diagram' && typeof message.code==='string'){
        const controller=new AbortController();this.diagramJobs.set(message.id,controller);panelRequests.add(message.id);void this.diagrams.render(message.code,!!message.dark,Number(message.priority)||0,controller.signal).then(svg=>{if(document.panels.has(panel))void panel.webview.postMessage({type:'diagram-result',id:message.id,svg});},error=>{if(document.panels.has(panel))void panel.webview.postMessage({type:'diagram-result',id:message.id,error:String(error)});}).finally(()=>{this.diagramJobs.delete(message.id);panelRequests.delete(message.id);});return;
      }
      if(message.type==='cancel-diagram'){this.diagramJobs.get(message.id)?.abort();return;}
      if(message.type==='mode'){if(message.readOnly)this.readOnlyPanels.add(panel);else this.readOnlyPanels.delete(panel);return;}
      if(message.type==='copy'&&typeof message.text==='string'){
        void(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;let expired=false;try{
          // Success means the operating system clipboard actually returns the
          // text, not merely that writeText() resolved.
          const confirm=async()=>{await vscode.env.clipboard.writeText(message.text);for(let i=0;i<5&&!expired;i++){if(await vscode.env.clipboard.readText()===message.text)return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Clipboard write could not be confirmed. Check clipboard access and retry.');};
          await Promise.race([confirm(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Clipboard confirmation timed out. Check clipboard access and retry.'));},1500);})]);
          if(document.panels.has(panel))void panel.webview.postMessage({type:'result',id:message.id,result:true});
        }catch(error){if(document.panels.has(panel))void panel.webview.postMessage({type:'result',id:message.id,error:String(error)});}finally{if(timer)clearTimeout(timer);}})();return;
      }
      if(message.type==='export-diagram'&&typeof message.code==='string'){
        void(async()=>{try{if(!['svg','png'].includes(message.format))throw new Error('Unsupported diagram format.');const file=await vscode.window.showSaveDialog({defaultUri:document.uri.with({path:document.uri.path.replace(/\.md$/i,'-diagram.'+message.format)}),filters:{[message.format.toUpperCase()]:[message.format]}});if(!file){await panel.webview.postMessage({type:'result',id:message.id,result:false});return;}const data=message.format==='png'?await this.diagrams.png(message.code,!!message.dark):Buffer.from(await this.diagrams.render(message.code,!!message.dark),'utf8');await vscode.workspace.fs.writeFile(file,data);await panel.webview.postMessage({type:'result',id:message.id,result:true});}catch(error){if(document.panels.has(panel))void panel.webview.postMessage({type:'result',id:message.id,error:String(error)});}})();return;
      }
      const commands: Record<string,string> = {save:'workbench.action.files.save','save-as':'workbench.action.files.saveAs',undo:'undo',redo:'redo'};
      if (commands[message.type]) {
        if(this.readOnlyPanels.has(panel)&&['undo','redo'].includes(message.type))return;
        void this.queue.then(() => vscode.commands.executeCommand(commands[message.type]));
        return;
      }
      void this.enqueue(async () => {
        try {
          if (message.type === 'ready') {await this.refresh(document);await panel.webview.postMessage({type:'preferences',preferences:this.documentPreferences(document)});void panel.webview.postMessage({type:'pdf-options',options:this.context.globalState.get('pdf-options',{})});}
          else if (message.type === 'preference' && ['navigationPinned','navigationMode','toolbarHidden'].includes(message.key)) {
            const key = this.preferenceKey(document);
            const allowed = message.key === 'navigationPinned' || message.key === 'toolbarHidden' ? typeof message.value === 'boolean' : message.value === 'find' || message.value === 'outline';
            if (!allowed) throw new Error('Invalid preference value.');
            await this.context.workspaceState.update(key, {...this.savedPreferences(document), [message.key]: message.value});
            this.post(document, {type:'preferences', preferences:this.documentPreferences(document)});
          }
          else if (message.type === 'display-preference' && message.patch && typeof message.patch === 'object') {
            const patch = message.patch as Record<string, unknown>;
            const next = {...this.displayPreferences()};
            if (typeof patch.textSize === 'number' && Number.isFinite(patch.textSize)) next.textSize = Math.max(12, Math.min(28, Math.round(patch.textSize)));
            if (['narrow','standard','wide'].includes(String(patch.readingWidth))) next.readingWidth = patch.readingWidth;
            if (typeof patch.readOnly === 'boolean') next.readOnly = patch.readOnly;
            if (typeof patch.focusMode === 'boolean') next.focusMode = patch.focusMode;
            await this.context.globalState.update('markyou.display', next);
            // Display settings are user-global: every open document must follow.
            for(const other of this.documents)this.post(other,{type:'preferences',preferences:this.documentPreferences(other)});
          }
          else if (message.type === 'export-pdf') { if(this.exporting){void vscode.window.showInformationMessage('A PDF export is already running.');return;}this.exporting=true;void this.context.globalState.update('pdf-options',message.options);void exportPdf(document,this.context.extensionUri.fsPath,message.options).catch(error=>vscode.window.showErrorMessage(String(error))).finally(()=>{this.exporting=false;}); }
          else if (message.type === 'metrics' && ['readable','editable','diagram'].includes(message.phase)) {
            document.metrics[message.phase] ??= (Number.isFinite(message.timestamp) ? message.timestamp : Date.now())-document.openedAt;
          } else if (message.type === 'benchmark-result') document.benchmark = message.result;
          else if(message.type==='includes'){
            const sources=[...document.graph.sourceUris].flatMap(uri=>{const source=document.repository.sources.get(uri);return source?[{uri,imports:source.pieces.filter(piece=>piece.kind==='import').map(piece=>({id:piece.id,path:piece.kind==='import'?piece.path:''}))}]:[];});void panel.webview.postMessage({type:'result',id:message.id,result:sources});
          }else if(message.type==='join-blocks'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode.');const source=document.repository.sources.get(message.uri);if(!source||!document.graph.sourceUris.has(message.uri))throw new Error('Unknown source.');const first=source.pieces.findIndex(piece=>piece.id===message.first),second=source.pieces.findIndex(piece=>piece.id===message.second);const a=source.pieces[first],b=source.pieces[second];if(first<0||second<=first||a.kind!=='markdown'||b.kind!=='markdown'||a.blockType!=='paragraph_open'||b.blockType!=='paragraph_open'||source.pieces.slice(first+1,second).some(piece=>piece.kind==='import'||piece.raw.trim()))throw new Error('Only adjacent paragraphs in the same source can be joined.');const before=source.pieces.slice(),beforeHash=document.repository.fingerprint(source.uri);const merged={...a,raw:a.raw.trimEnd()+b.raw.trimStart()};const after=[...source.pieces.slice(0,first),merged,...source.pieces.slice(second+1)];document.repository.editPieces(source.uri,beforeHash,after);const afterHash=document.repository.fingerprint(source.uri);this.recordEdit(document,'Join source paragraphs',()=>this.enqueue(async()=>document.repository.editPieces(source.uri,afterHash,before)),()=>this.enqueue(async()=>document.repository.editPieces(source.uri,beforeHash,after)));void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }else if(message.type==='include-edit'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: include change rejected.');
            const source=document.repository.sources.get(message.uri);if(!source||!document.graph.sourceUris.has(message.uri))throw new Error('Unknown include source.');
            const before=serializeSource(source);let after:string;
            if(message.action==='remove'){const piece=source.pieceById.get(message.pieceId);if(piece?.kind!=='import')throw new Error('Include no longer exists.');after=source.pieces.filter(item=>item!==piece).map(item=>item.raw).join('');}
            else{const path=String(message.path).replace(/\\/g,'/');if(/["\r\n]/.test(path))throw new Error('Invalid include path.');const target=await document.repository.io.resolve(source.uri,path);
              if(message.create){try{await vscode.workspace.fs.stat(vscode.Uri.parse(target));}catch{const title=path.split('/').pop()?.replace(/\.md$/i,'')??'New chapter';await vscode.workspace.fs.writeFile(vscode.Uri.parse(target),Buffer.from(`# ${title}\n`,'utf8'));}}
              await document.repository.load(target);const targetGraph=new DocumentGraph(document.repository,target);await targetGraph.build();if(targetGraph.segments.some(segment=>segment.error))throw new Error('The selected include contains unresolved or circular references.');const reaches=(uri:string,seen=new Set<string>()):boolean=>{if(uri===source.uri)return true;if(seen.has(uri))return false;seen.add(uri);return [...(targetGraph.dependencies.get(uri)??[])].some(next=>reaches(next,seen));};if(reaches(target))throw new Error('This include would create a cycle.');const eol=before.includes('\r\n')?'\r\n':'\n';after=before+(before.endsWith(eol+eol)?'':eol)+`@import "${path}"${eol}`;}
            document.repository.editDraft(source.uri,before,after);this.recordEdit(document,'Change Markdown include',()=>this.enqueue(async()=>document.repository.editDraft(source.uri,after,before)),()=>this.enqueue(async()=>document.repository.editDraft(source.uri,before,after)));void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }else if(message.type==='save-image'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: image rejected.');
            if(typeof message.data!=='string'||message.data.length>28*1024*1024)throw new Error('Image is missing or larger than 20 MB.');
            const sourceUri=message.uri&&document.graph.sourceUris.has(message.uri)?message.uri:document.rootUri;
            const mime=String(message.mime??'image/png');
            const extension=mime==='image/jpeg'?'jpg':mime==='image/gif'?'gif':mime==='image/webp'?'webp':mime==='image/svg+xml'?'svg':'png';
            const sourceDirectory=dirname(fileURLToPath(sourceUri));
            const directory=join(sourceDirectory,'assets');
            const roots=vscode.workspace.workspaceFolders?.map(folder=>folder.uri.fsPath)??[dirname(document.uri.fsPath)];
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
            const canonicalDirectory=await realpath(directory);
            const allowed=await Promise.all(roots.map(root=>realpath(root).catch(()=>root)));
            if(!allowed.some(root=>{const rel=relative(root,canonicalDirectory);return rel===''||(!rel.startsWith('..')&&!rel.startsWith('/')&&!rel.startsWith('\\'));}))throw new Error('Image must be saved inside the workspace.');
            const base=String(message.name??'image').replace(/\.[^.]+$/,'').replace(/[^\w.-]+/g,'-').slice(0,60)||'image';
            const target=join(canonicalDirectory,`${base}-${randomBytes(4).toString('hex')}.${extension}`);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(target),Buffer.from(String(message.data),'base64'));
            void panel.webview.postMessage({type:'result',id:message.id,result:relative(sourceDirectory,target).replace(/\\/g,'/')});
          }else if(message.type==='pick-image'){
            if(!document.graph.sourceUris.has(message.uri))throw new Error('Unknown source.');const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{Images:['png','jpg','jpeg','gif','webp','svg']}});const selected=files?.[0];let result:string|undefined;
            if(selected){const file=await realpath(selected.fsPath);const roots=vscode.workspace.workspaceFolders?.map(folder=>folder.uri.fsPath)??[dirname(document.uri.fsPath)];const canonical=await Promise.all(roots.map(root=>realpath(root)));if(!canonical.some(root=>{const rel=relative(root,file);return rel!== '..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!/^[A-Za-z]:|^[/\\]/.test(rel);}))throw new Error('Choose an image inside the workspace.');result=relative(dirname(fileURLToPath(message.uri)),file).replace(/\\/g,'/');}void panel.webview.postMessage({type:'result',id:message.id,result});
          }
          else if(message.type==='document-markdown'){
            const source=document.repository.sources.get(document.rootUri);
            void panel.webview.postMessage({type:'result',id:message.id,result:source?serializeSource(source):''});
          }
          else if(message.type==='workspace-files'){
            const files=await vscode.workspace.findFiles('**/*.md','**/node_modules/**',500);
            const base=dirname(document.uri.fsPath);
            const list=[...new Set(files.map(uri=>relative(base,uri.fsPath).replace(/\\/g,'/')).filter(name=>!name.startsWith('../')))].sort((a,b)=>a.localeCompare(b));
            void panel.webview.postMessage({type:'result',id:message.id,result:list});
          }
          else if(message.type==='insert-block'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: insert rejected.');
            const text=String(message.text??'');
            if(!text.trim())throw new Error('Nothing to insert.');
            if(message.uri&&!document.graph.sourceUris.has(message.uri))throw new Error('The source for this block is no longer part of the document. Reload and retry.');
            const uri=message.uri??document.rootUri;
            const source=document.repository.sources.get(uri)??await document.repository.load(uri);
            const before=serializeSource(source);
            const eol=before.includes('\r\n')?'\r\n':'\n';
            const normalized=text.replace(/\r?\n/g,eol).trimEnd()+eol;
            let offset=before.length;
            if(message.position==='start')offset=before.startsWith('﻿')?1:0;
            else if(message.position==='before'||message.position==='after'){
              const index=source.pieces.findIndex(piece=>piece.id===message.after);
              if(index<0)throw new Error('The target block changed. Reload the document and retry.');
              offset=source.pieces.slice(0,message.position==='before'?index:index+1).reduce((sum,piece)=>sum+piece.raw.length,0);
            }
            const prefix=before.slice(0,offset),suffix=before.slice(offset);
            const separatedBefore=prefix===''?'':/\r?\n\r?\n$/.test(prefix)?'':/\r?\n$/.test(prefix)?eol:eol+eol;
            const separatedAfter=suffix===''||/^\r?\n/.test(suffix)?'':eol;
            const after=prefix+separatedBefore+normalized+separatedAfter+suffix;
            document.repository.editDraft(uri,before,after);
            this.recordEdit(document,'Insert Markdown block',()=>this.enqueue(async()=>document.repository.editDraft(uri,after,before)),()=>this.enqueue(async()=>document.repository.editDraft(uri,before,after)));
            void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }
          else if(message.type==='replace'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: replacement rejected.');
            const query=String(message.query??'').trim();const replacement=String(message.replacement??'');
            if(!query)throw new Error('Enter text to replace.');
            const matchCase=!!message.matchCase;const sourceMode=!!message.sourceMode;
            const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase?'g':'gi');
            const hidden=(raw:string)=>{
              if(sourceMode)return [] as [number,number][];
              const ranges:[number,number][]=[];
              for(const expression of [/\]\([^)\n]*\)/g,/^[ \t]*\[[^\]]+\]:[ \t]*\S+.*$/gm,/<[^>]+>/g])for(const match of raw.matchAll(expression))ranges.push([match.index!,match.index!+match[0].length]);
              return ranges;
            };
            const changes:PieceEdit[]=[];let count=0;let skipped=0;
            for(const uri of document.graph.sourceUris){
              const source=document.repository.sources.get(uri);if(!source)continue;
              for(const piece of source.pieces){
                if(piece.kind!=='markdown'||piece.editable===false)continue;
                if(!message.all&&changes.length)break;
                if(!message.all&&message.pieceId&&piece.id!==message.pieceId)continue;
                const raw=piece.raw;const ranges=hidden(raw);
                const matches=[...raw.matchAll(pattern)].filter(match=>!ranges.some(([start,end])=>match.index!<end&&match.index!+match[0].length>start));
                skipped+=ranges.length?[...raw.matchAll(pattern)].length-matches.length:0;
                if(!matches.length)continue;
                let after=raw;
                const selected=message.all?matches:[matches[0]];
                for(const match of [...selected].reverse())after=after.slice(0,match.index!)+replacement+after.slice(match.index!+match[0].length);
                if(after===raw)continue;
                changes.push({uri,pieceId:piece.id,before:raw,after});
                count+=selected.length;
                if(!message.all)break;
              }
            }
            let visibleOnly=false;
            if(!changes.length&&!sourceMode){
              outer:for(const uri of document.graph.sourceUris){
                const source=document.repository.sources.get(uri);if(!source)continue;
                for(const piece of source.pieces){
                  if(piece.kind!=='markdown'||piece.editable===false)continue;
                  if(visibleText(piece.raw).includes(query)){visibleOnly=true;break outer;}
                }
              }
            }
            if(!changes.length){void panel.webview.postMessage({type:'result',id:message.id,result:{count:0,pieces:0,skipped,visibleOnly}});return;}
            document.repository.apply(changes,'after',true);
            this.recordEdit(document,'Replace text',()=>this.enqueue(async()=>document.repository.apply(changes,'before')),()=>this.enqueue(async()=>document.repository.apply(changes,'after')));
            void panel.webview.postMessage({type:'result',id:message.id,result:{count,pieces:changes.length,skipped}});
          }
          else if(message.type==='open-source'){
            const uri=document.repository.sources.has(message.uri)?message.uri:document.rootUri;
            void vscode.commands.executeCommand('vscode.openWith',vscode.Uri.parse(uri),EditorProvider.viewType);
          }
          else if(message.type==='open-include'&&typeof message.path==='string'){
            const base=document.graph.sourceUris.has(message.uri)?message.uri:document.rootUri;
            const target=await document.repository.io.resolve(base,message.path);
            void vscode.commands.executeCommand('vscode.openWith',vscode.Uri.parse(target),EditorProvider.viewType);
          }
          else if(message.type==='reload-document'){
            await this.refresh(document);
            void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }
          else if(message.type === 'edit') {
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: edit rejected.');
            const source = document.repository.sources.get(message.uri);
            const piece = source?.pieceById.get(message.pieceId);
            if (!document.graph.sourceUris.has(message.uri) || piece?.kind !== 'markdown' || typeof message.text !== 'string' || typeof message.before !== 'string') throw new Error('Invalid source edit.');
            const changes: PieceEdit[] = [{uri:message.uri,pieceId:message.pieceId,before:message.before,after:message.text}];
            document.repository.apply(changes,'after',true,message.origin);
            this.recordEdit(document,'Edit Markdown block',
              () => this.enqueue(async () => { document.repository.apply(changes,'before'); }),
              () => this.enqueue(async () => { document.repository.apply(changes,'after'); }),
              `${message.uri}::${message.pieceId}`);
          } else if (message.type === 'reveal' && document.graph.sourceUris.has(message.uri)) {const source=document.repository.sources.get(message.uri);const index=source?.pieces.findIndex(piece=>piece.id===message.pieceId)??-1;const offset=index<0?0:source!.pieces.slice(0,index).reduce((sum,piece)=>sum+piece.raw.length,0);const text=await vscode.workspace.openTextDocument(vscode.Uri.parse(message.uri));const position=text.positionAt(offset);await vscode.window.showTextDocument(text,{selection:new vscode.Range(position,position)});}
          else if (message.type === 'link' && document.graph.sourceUris.has(message.uri) && typeof message.href === 'string') {
            if (/^https?:\/\//i.test(message.href)) await vscode.env.openExternal(vscode.Uri.parse(message.href));
            else if (!message.href.startsWith('#')) {
              const target = await document.repository.io.resolve(message.uri,message.href.split('#')[0]);
              // Opening another custom editor must not wait on the current message queue.
              void vscode.commands.executeCommand('vscode.openWith',vscode.Uri.parse(target),EditorProvider.viewType);
            }
          }
          else if (message.type === 'wikilink' && document.graph.sourceUris.has(message.uri) && typeof message.target === 'string') {
            let target = message.target.split('#')[0].trim();
            if (!/\.md$/i.test(target)) target += '.md';
            const uri = await document.repository.io.resolve(message.uri, target);
            void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(uri), EditorProvider.viewType);
          }
          else if (message.type === 'conflict' && document.trackedSources.has(message.uri)) {
            this.sealEditGroup();
            if (message.choice === 'diff') await this.diff(document,message.uri);
            else if (message.choice === 'reload' || message.choice === 'keep') await document.repository.resolveConflict(message.uri,message.choice);
          }
        } catch (error) {
          const text=String(error);
          if(message.id)void panel.webview.postMessage({type:'result',id:message.id,error:text});
          else void panel.webview.postMessage({type:'error',message:text});
        }
      });
    });
  }
  private preferenceKey(document: CompositeDocument) {
    return `markyou.preferences:${document.uri.toString()}`;
  }
  private savedPreferences(document: CompositeDocument): Record<string, unknown> {
    return this.context.workspaceState.get<Record<string, unknown>>(this.preferenceKey(document), {}) ?? {};
  }
  private documentPreferences(document: CompositeDocument) {
    const saved = this.savedPreferences(document);
    const configuration = vscode.workspace.getConfiguration('markyou');
    return {
      navigationPinned: typeof saved.navigationPinned === 'boolean' ? saved.navigationPinned : false,
      navigationMode: saved.navigationMode === 'outline' || saved.navigationMode === 'find' ? saved.navigationMode : configuration.get<'find' | 'outline'>('defaultNavigationMode', 'find'),
      toolbarHidden: typeof saved.toolbarHidden === 'boolean' ? saved.toolbarHidden : !configuration.get<boolean>('showToolbar', true),
      display: this.displayPreferences(),
      version: String(this.context.extension.packageJSON.version ?? ''),
      productName: 'MarkYou',
    };
  }
  private displayPreferences() {
    const saved = this.context.globalState.get<Record<string, unknown>>('markyou.display') ?? {};
    return {
      textSize: typeof saved.textSize === 'number' ? Math.max(12, Math.min(28, saved.textSize)) : 16,
      readingWidth: ['narrow', 'standard', 'wide'].includes(String(saved.readingWidth)) ? saved.readingWidth : 'standard',
      readOnly: saved.readOnly === true,
      focusMode: saved.focusMode === true,
    };
  }
  private status(document: CompositeDocument) {
    return {type:'status',dirty:[...document.dirtySources],history:{undo:document.undoDepth,redo:document.redoDepth},conflicts:[...document.trackedSources].flatMap(uri => {
      const source = document.repository.sources.get(uri);
      return source?.conflict ? [{uri,deleted:source.conflict.external === null}] : [];
    })};
  }
  private editGroup?: {document:CompositeDocument;groupKey?:string;time:number;undoFns:(()=>Promise<void>)[];redoFns:(()=>Promise<void>)[]};
  private sealEditGroup(){
    if(this.editGroup)this.editGroup.time=0;
    this.editGroup=undefined;
  }
  /**
   * One undo step per burst of typing in one block. Consecutive edits within
   * 700 ms extend the group already on the undo stack instead of pushing a new
   * step per keystroke. Structural edits, saves and conflicts close the group.
   */
  private recordEdit(document:CompositeDocument,label:string,undo:()=>Promise<void>,redo:()=>Promise<void>,groupKey?:string){
    const now=Date.now();
    if(label==='Edit Markdown block'&&groupKey&&this.editGroup?.document===document&&this.editGroup.groupKey===groupKey&&now-this.editGroup.time<=700){
      const group=this.editGroup;group.time=now;group.undoFns.push(undo);group.redoFns.push(redo);this.post(document,this.status(document));return;
    }
    this.sealEditGroup();
    const group={document,groupKey,time:now,undoFns:[undo],redoFns:[redo]};
    if(label==='Edit Markdown block'&&groupKey)this.editGroup=group;
    document.undoDepth++;document.redoDepth=0;
    this.edits.fire({document,label,undo:async()=>{this.sealEditGroup();for(const fn of [...group.undoFns].reverse())await fn();document.undoDepth=Math.max(0,document.undoDepth-1);document.redoDepth++;this.post(document,this.status(document));},redo:async()=>{this.sealEditGroup();for(const fn of group.redoFns)await fn();document.undoDepth++;document.redoDepth=Math.max(0,document.redoDepth-1);this.post(document,this.status(document));}});this.post(document,this.status(document));
  }
  private async refresh(document: CompositeDocument) {
    if (!document.graph.segments.length) {
      const io = document.repository.io;
      const preview = new DocumentGraph(new SourceRepository({read:async uri => (await io.read(uri)).slice(0,16384),write:async () => { throw new Error('Read-only preview'); },resolve:(from,path) => io.resolve(from,path)}),document.rootUri);
      await preview.build(64);
      for (const panel of document.panels) await panel.webview.postMessage({type:'document',readOnly:true,title:document.uri.path.split('/').pop(),segments:preview.segments.map(segment => ({...segment,resourceBase:panel.webview.asWebviewUri(vscode.Uri.file(dirname(vscode.Uri.parse(segment.sourceUri).fsPath))).toString()}))});
    }
    const segments = await document.graph.build();
    document.trackSources();
    if (segments.some(segment => /^\s*(?:`{3,}|~{3,})mermaid\b/m.test(segment.text))) this.diagrams.prewarm();
    for (const panel of document.panels) {
      const generation = randomBytes(8).toString('hex'); this.generations.set(panel,generation);
      const map = (batch:typeof segments) => batch.map(segment => ({...segment,
        text:document.repository.sources.get(segment.sourceUri)?.pieceById.get(segment.pieceId)?.raw ?? segment.text,
        resourceBase:panel.webview.asWebviewUri(vscode.Uri.file(dirname(vscode.Uri.parse(segment.sourceUri).fsPath))).toString()
      }));
      await panel.webview.postMessage({type:'document',generation,title:document.uri.path.split('/').pop(),segments:map(segments.slice(0,128))});
      // The first screen must not wait for an IPC payload describing the entire file.
      void (async () => {
        for (let i = 128; i < segments.length && this.generations.get(panel) === generation; i += 512) {
          await new Promise<void>(resolve => setImmediate(resolve));
          if (!document.panels.has(panel) || this.generations.get(panel) !== generation) return;
          await panel.webview.postMessage({type:'append',generation,segments:map(segments.slice(i,i+512))});
        }
        if(document.panels.has(panel)&&this.generations.get(panel)===generation)await panel.webview.postMessage({type:'index-complete',generation});
      })();
    }
    this.post(document,this.status(document));
  }
  private post(document: CompositeDocument, message: unknown) { for (const panel of document.panels) void panel.webview.postMessage(message); }
  openExport() { for (const document of this.documents) for (const panel of document.panels) if (panel.active) void panel.webview.postMessage({type:'open-export'}); }
  dispatch(command:string,context?:unknown){for(const document of this.documents)for(const panel of document.panels)if(panel.active)void panel.webview.postMessage({type:'command',command,context});}
  exportToPdf(document:CompositeDocument,options:PdfOptions){return exportPdf(document,this.context.extensionUri.fsPath,options);}
  async saveCustomDocument(document: CompositeDocument) {
    await this.enqueue(async () => { this.sealEditGroup(); await document.repository.save(document.trackedSources); this.post(document,this.status(document)); });
  }
  async saveCustomDocumentAs(document: CompositeDocument, destination: vscode.Uri) {
    // Relative directives are meaningful only in the original directory.
    // Windows may hand us different casing or an 8.3 short path for the same
    // folder, so compare canonical directories instead of raw strings.
    const destinationDirectory = await realpath(dirname(destination.fsPath)).catch(() => dirname(destination.fsPath));
    const currentDirectory = dirname(document.uri.fsPath);
    const sameDirectory = process.platform === 'win32'
      ? destinationDirectory.toLowerCase() === currentDirectory.toLowerCase()
      : destinationDirectory === currentDirectory;
    if (!sameDirectory) throw new Error('Save As Copy must stay in the same folder so relative @import paths remain valid. Choose a file in the current folder, or use Save and copy the file in your file manager. The original file has not been changed.');
    await this.enqueue(async () => {
      this.sealEditGroup();
      if([...document.dirtySources].some(uri=>uri!==document.rootUri))throw new Error('Included files have unsaved changes. Save them first, then use Save As Copy. No files were written.');
      const root = document.repository.sources.get(document.rootUri)!;
      await vscode.workspace.fs.writeFile(destination,Buffer.from(serializeSource(root),'utf8'));
    });
  }
  async revertCustomDocument(document: CompositeDocument) {
    await this.enqueue(async () => {
      this.sealEditGroup();
      for (const uri of document.trackedSources) {
        const source = document.repository.sources.get(uri);
        if (source) document.repository.replace(source,await document.repository.io.read(uri));
      }
      for (const other of this.documents) if (other.repository === document.repository) await this.refresh(other);
    });
  }
  async backupCustomDocument(document: CompositeDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await this.enqueue(async () => {
      const sources = [...document.trackedSources].flatMap(uri => {
        const source = document.repository.sources.get(uri);
        return source?.dirty ? [{uri,base:source.rawText,text:serializeSource(source)}] : [];
      });
      await vscode.workspace.fs.writeFile(context.destination,Buffer.from(JSON.stringify({sources}),'utf8'));
    });
    return {id:context.destination.toString(),delete:() => { void vscode.workspace.fs.delete(context.destination); }};
  }
  private async diff(document: CompositeDocument, uri: string) {
    const source = document.repository.sources.get(uri)!;
    const external = vscode.Uri.parse(`markyou-diff:/${randomBytes(8).toString('hex')}/external.md`);
    const local = vscode.Uri.parse(`markyou-diff:/${randomBytes(8).toString('hex')}/editor.md`);
    this.snapshots.set(external.toString(),source.conflict?.external ?? '(file deleted)');
    this.snapshots.set(local.toString(),serializeSource(source));
    await vscode.commands.executeCommand('vscode.diff',external,local,'External ↔ MarkYou');
  }
  private html(webview: vscode.Webview) {
    const nonce = randomBytes(18).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'dist','editor.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'dist','editor.css'));
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https: http:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; font-src ${webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body><nav id="toolbar" aria-label="Formatting toolbar"></nav><div id="statusbar" role="group" aria-label="Document status"><span id="status" role="status" aria-live="polite">Ready</span></div><div id="readonly-banner" role="status" hidden><span>Read-only preview — editing is disabled</span><button type="button" id="enable-editing">Enable editing</button></div><aside id="conflicts" aria-live="assertive"></aside><div id="notice" role="alert" hidden></div><main id="document" aria-label="Markdown document" tabindex="-1"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  dispose() { this.diagrams.dispose(); for (const timer of this.pendingFiles.values()) clearTimeout(timer); for (const item of this.subscriptions) item.dispose(); this.edits.dispose(); }
}
