import {translate} from '../shared/localization';
import * as vscode from 'vscode';
import { dirname,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath,readFile,writeFile,rename,unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { CompositeDocument } from './compositeDocument';
import { SourceRepository } from '../document/sourceFile';
import { LocalFileIO, uriForPath } from '../document/fileIO';
import { serializeSource } from '../document/serializer';
import type { PieceEdit } from '../shared/types';
import { replaceMatches } from '../shared/replacements';
import { DocumentGraph } from '../document/documentGraph';
import { exportPdf,type PdfOptions } from './pdf';
import { DiagramService } from './diagramService';
import {portableMarkdown} from '../document/portableMarkdown';

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
  private readonly pendingAnchors=new Map<string,string>();
  private readonly replacementPlans=new Map<string,{document:CompositeDocument;changes:PieceEdit[];versions:Record<string,number>;count:number}>();
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
    document.drafts=this.context.workspaceState.get(`markyou.drafts:${document.rootUri}`,[]);
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
      const backup = JSON.parse(Buffer.from(bytes).toString('utf8')) as {sources:{uri:string;base:string;text:string}[];drafts?:CompositeDocument['drafts']};
      if(backup.drafts)document.drafts=backup.drafts;
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
          if (message.type === 'ready') {await this.refresh(document);await panel.webview.postMessage({type:'preferences',preferences:this.documentPreferences(document)});void panel.webview.postMessage({type:'pdf-options',options:this.context.globalState.get('pdf-options',{})});void panel.webview.postMessage({type:'drafts',drafts:document.drafts});const hash=this.pendingAnchors.get(document.rootUri);if(hash){this.pendingAnchors.delete(document.rootUri);void panel.webview.postMessage({type:'navigate-hash',hash});}}
          else if(message.type==='draft'){
            const draft=message.draft;
            if(!draft||typeof draft.key!=='string')throw new Error('Invalid draft.');
            if(!draft.remove&&(!document.graph.sourceUris.has(draft.uri)||!['markdown','mermaid','html'].includes(draft.kind)||typeof draft.value!=='string'||typeof draft.baseline!=='string'||draft.value.length>4*1024*1024))throw new Error('Invalid draft source or size.');
            document.drafts=document.drafts.filter(item=>item.key!==draft.key);
            if(!draft.remove)document.drafts.push(draft);
            await this.context.workspaceState.update(`markyou.drafts:${document.rootUri}`,document.drafts);
          }
          else if(message.type==='seal-history'){this.sealEditGroup();}
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
            if(typeof patch.readOnly==='boolean')await this.context.workspaceState.update(this.preferenceKey(document),{...this.savedPreferences(document),readOnly:patch.readOnly});
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
            const depths=new Map<string,number>();const walk=(uri:string,depth:number)=>{if(depths.has(uri))return;depths.set(uri,depth);for(const child of document.graph.dependencies.get(uri)??[])walk(child,depth+1);};walk(document.rootUri,0);
            const sources=[];
            for(const uri of document.graph.sourceUris){
              const source=document.repository.sources.get(uri);if(!source)continue;
              const imports=[];
              for(const piece of source.pieces){if(piece.kind!=='import')continue;let target='',error='';try{target=await document.repository.io.resolve(uri,piece.path);error=document.graph.segments.find(segment=>segment.sourceUri===target&&segment.error)?.error??'';}catch(reason){error=String(reason);}
                imports.push({id:piece.id,path:piece.path,target,error,repeated:document.graph.duplicates.has(target)});
              }
              sources.push({uri,version:source.version,depth:depths.get(uri)??0,repeated:document.graph.duplicates.has(uri),dirty:source.dirty,conflict:!!source.conflict,imports});
            }
            void panel.webview.postMessage({type:'result',id:message.id,result:sources});
          }else if(message.type==='join-blocks'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode.');const source=document.repository.sources.get(message.uri);if(!source||!document.graph.sourceUris.has(message.uri))throw new Error('Unknown source.');const first=source.pieces.findIndex(piece=>piece.id===message.first),second=source.pieces.findIndex(piece=>piece.id===message.second);const a=source.pieces[first],b=source.pieces[second];if(first<0||second<=first||a.kind!=='markdown'||b.kind!=='markdown'||a.blockType!=='paragraph_open'||b.blockType!=='paragraph_open'||source.pieces.slice(first+1,second).some(piece=>piece.kind==='import'||piece.raw.trim()))throw new Error('Only adjacent paragraphs in the same source can be joined.');const before=source.pieces.slice(),beforeHash=document.repository.fingerprint(source.uri);const merged={...a,raw:a.raw.trimEnd()+b.raw.trimStart()};const after=[...source.pieces.slice(0,first),merged,...source.pieces.slice(second+1)];document.repository.editPieces(source.uri,beforeHash,after);const afterHash=document.repository.fingerprint(source.uri);this.recordEdit(document,'Join source paragraphs',()=>this.enqueue(async()=>document.repository.editPieces(source.uri,afterHash,before)),()=>this.enqueue(async()=>document.repository.editPieces(source.uri,beforeHash,after)));void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }else if(message.type==='include-edit'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: include change rejected.');
            const source=document.repository.sources.get(message.uri);if(!source||!document.graph.sourceUris.has(message.uri))throw new Error('Unknown include source.');
            const before=serializeSource(source);let after:string;
            if(message.sourceVersion!==undefined&&source.version!==message.sourceVersion)throw new Error('Include source changed. Refresh the manager and try again.');
            const selected=source.pieceById.get(message.pieceId);
            if(['remove','edit','up','down'].includes(message.action)){
              if(selected?.kind!=='import')throw new Error('Include no longer exists.');
              if(message.action==='remove')after=source.pieces.filter(item=>item!==selected).map(item=>item.raw).join('');
              else if(message.action==='edit'){
                const path=String(message.path??'').replace(/\\/g,'/');if(/["\r\n]/.test(path))throw new Error('Invalid Include path.');
                const target=await document.repository.io.resolve(source.uri,path);await document.repository.load(target);
                after=source.pieces.map(piece=>piece===selected?`@import "${path}"`+(piece.raw.endsWith('\n')?'\n':''):piece.raw).join('');
              }else{
                const imports=source.pieces.filter(piece=>piece.kind==='import'),rank=imports.indexOf(selected),neighbor=imports[rank+(message.action==='up'?-1:1)];
                if(!neighbor)throw new Error('This Include is already at the source boundary.');
                after=source.pieces.map(piece=>piece===selected?neighbor.raw:piece===neighbor?selected.raw:piece.raw).join('');
              }
            }else{
              const path=String(message.path).replace(/\\/g,'/');if(/["\r\n]/.test(path))throw new Error('Invalid Include path.');
              const target=await document.repository.io.resolve(source.uri,path);
              if(message.create){try{await vscode.workspace.fs.stat(vscode.Uri.parse(target));}catch{const title=path.split('/').pop()?.replace(/\.md$/i,'')??'New chapter';await vscode.workspace.fs.writeFile(vscode.Uri.parse(target),Buffer.from(`# ${title}\n`,'utf8'));}}
              await document.repository.load(target);const graph=new DocumentGraph(document.repository,target);await graph.build();
              if(graph.segments.some(segment=>segment.error))throw new Error('Include validation failed. If Create was selected, the new file remains on disk at '+path+'. Remove the resource explicitly if no longer needed.');
              const reaches=(uri:string,seen=new Set<string>()):boolean=>{if(uri===source.uri)return true;if(seen.has(uri))return false;seen.add(uri);return [...(graph.dependencies.get(uri)??[])].some(next=>reaches(next,seen));};
              if(reaches(target))throw new Error('This Include would create a cycle. No reference was added.');
              const eol=before.includes('\r\n')?'\r\n':'\n';let offset=before.length;
              if(message.after){const index=source.pieces.findIndex(piece=>piece.id===message.after);if(index<0)throw new Error('Selected Include changed. Refresh and retry.');offset=source.pieces.slice(0,message.position==='before'?index:index+1).reduce((sum,piece)=>sum+piece.raw.length,0);}
              const prefix=before.slice(0,offset),suffix=before.slice(offset);
              after=prefix+(prefix&&!prefix.endsWith(eol+eol)?eol:'')+`@import "${path}"${eol}${eol}`+suffix;
            }
            document.repository.editDraft(source.uri,before,after);this.recordEdit(document,'Change Markdown include',()=>this.enqueue(async()=>document.repository.editDraft(source.uri,after,before)),()=>this.enqueue(async()=>document.repository.editDraft(source.uri,before,after)));void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }else if(message.type==='save-image'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: image rejected.');
            if(typeof message.data!=='string'||message.data.length>28*1024*1024)throw new Error('Image is missing or larger than 20 MB.');
            if(!document.graph.sourceUris.has(message.uri))throw new Error('Image source is no longer part of this document.');
            const sourceUri=message.uri;
            if(message.sourceVersion!==undefined&&document.repository.sources.get(sourceUri)?.version!==message.sourceVersion)throw new Error('Image source changed. Select the insertion point again.');
            const result=await this.storeImage(document,sourceUri,Buffer.from(message.data,'base64'),String(message.name??'image'),String(message.mime??'image/png'));
            void panel.webview.postMessage({type:'result',id:message.id,result});
          }else if(message.type==='pick-image'){
            if(this.readOnlyPanels.has(panel)||!document.graph.sourceUris.has(message.uri))throw new Error('Choose an editable source first.');
            const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{Images:['png','jpg','jpeg','gif','webp','svg']}});
            const selected=files?.[0];let result:string|undefined;
            if(selected){
              const file=await realpath(selected.fsPath),roots=vscode.workspace.workspaceFolders?.map(folder=>folder.uri.fsPath)??[dirname(document.uri.fsPath)];
              const canonical=await Promise.all(roots.map(root=>realpath(root)));
              const inside=canonical.some(root=>{const rel=relative(root,file);return rel!== '..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!/^[A-Za-z]:|^[/\\]/.test(rel);});
              if(inside)result=relative(dirname(fileURLToPath(message.uri)),file).replace(/\\/g,'/');
              else if(await vscode.window.showWarningMessage('This image is outside the workspace. Copy it into the source document resource directory? The original image will remain unchanged.',{modal:true},'Copy into assets')==='Copy into assets'){
                const ext=file.split('.').pop()?.toLowerCase()??'png';
                result=await this.storeImage(document,message.uri,await readFile(file),selected.path.split('/').pop()??'image',ext==='jpg'||ext==='jpeg'?'image/jpeg':`image/${ext==='svg'?'svg+xml':ext}`);
              }
            }
            void panel.webview.postMessage({type:'result',id:message.id,result});
          }
          else if(message.type==='document-markdown'){
            const source=document.repository.sources.get(document.rootUri);
            void panel.webview.postMessage({type:'result',id:message.id,result:source?serializeSource(source):''});
          }
          else if(message.type==='export-markdown'){
            const destination=await vscode.window.showSaveDialog({defaultUri:document.uri.with({path:document.uri.path.replace(/\.md$/i,'-complete.md')}),filters:{Markdown:['md']}});
            if(!destination){void panel.webview.postMessage({type:'result',id:message.id,result:false});return;}
            if(!/\.md$/i.test(destination.fsPath))throw new Error('Choose a .md export destination.');
            const targetUri=uriForPath(await realpath(destination.fsPath).catch(()=>destination.fsPath));
            if([...this.repositories.values()].some(repository=>repository.sources.has(targetUri)))throw new Error('Choose a new destination, separate from all open source files.');
            const folder=destination.fsPath.split(/[\\/]/).pop()!.replace(/\.md$/i,'')+'.assets-'+randomBytes(4).toString('hex');
            const snapshot=document.graph.segments.map(segment=>({...segment,text:document.repository.sources.get(segment.sourceUri)?.pieceById.get(segment.pieceId)?.raw??segment.text}));
            const io=document.repository.io as LocalFileIO;
            const plan=await portableMarkdown(snapshot,document.rootUri,folder,(from,path)=>io.resolveResource(from,path),uri=>readFile(fileURLToPath(uri)));
            const accepted=await vscode.window.showInformationMessage(`Export complete Markdown to ${destination.fsPath}\n${plan.chapters} blocks; ${plan.resources.length} local resources in ${folder}. Repeated Includes follow display order. ${plan.omittedMetadata} child metadata blocks omitted. Applied unsaved edits are included; unapplied drafts are excluded. Source files remain unchanged.`,{modal:true},'Export');
            if(accepted!=='Export'){void panel.webview.postMessage({type:'result',id:message.id,result:false});return;}
            const temporary=destination.fsPath+'.'+randomBytes(8).toString('hex')+'.tmp';
            try{
              if(plan.resources.length)await vscode.workspace.fs.createDirectory(vscode.Uri.file(join(dirname(destination.fsPath),folder)));
              for(const resource of plan.resources)await vscode.workspace.fs.writeFile(vscode.Uri.file(join(dirname(destination.fsPath),folder,resource.name)),resource.bytes);
              await writeFile(temporary,plan.markdown,{flag:'wx'});await rename(temporary,destination.fsPath);
            }catch(error){throw new Error(`Markdown export failed. Original sources are unchanged. Partial resources may remain in ${folder}; inspect this directory before retrying. ${String(error)}`,{cause:error});}
            finally{await unlink(temporary).catch(()=>{});}
            void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }
          else if(message.type==='workspace-files'){
            const files=await vscode.workspace.findFiles('**/*.md','**/node_modules/**',500);
            const base=dirname(document.uri.fsPath);
            const list=[...new Set(files.map(uri=>relative(base,uri.fsPath).replace(/\\/g,'/')).filter(name=>!name.startsWith('../')))].sort((a,b)=>a.localeCompare(b));
            void panel.webview.postMessage({type:'result',id:message.id,result:list});
          }
          else if(message.type==='insert-footnote'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode.');
            const source=document.repository.sources.get(message.uri),label=String(message.label??'');
            if(!source||!document.graph.sourceUris.has(message.uri)||!label||/[\s[\]:]/u.test(label))throw new Error('Choose a source and a label without whitespace, brackets or colons.');
            const piece=source.pieceById.get(message.pieceId);
            if(piece?.kind!=='markdown'||piece.raw!==message.before||source.version!==message.sourceVersion)throw new Error('Footnote target changed. Select the insertion point again.');
            const before=serializeSource(source);
            if([...before.matchAll(/\[\^([^\]]+)\]:/g)].some(match=>match[1]===label))throw new Error('This footnote label already exists in the source.');
            const eol=before.includes('\r\n')?'\r\n':'\n';
            const after=source.pieces.map(item=>item===piece?String(message.text):item.raw).join('').trimEnd()+eol+eol+`[^${label}]: ${String(message.body).replace(/\r?\n/g,' ')}${eol}`;
            document.repository.editDraft(source.uri,before,after);
            this.recordEdit(document,'Insert footnote',()=>this.enqueue(async()=>document.repository.editDraft(source.uri,after,before)),()=>this.enqueue(async()=>document.repository.editDraft(source.uri,before,after)));
            void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }
          else if(message.type==='block-operation'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode.');
            const source=document.repository.sources.get(message.uri);
            if(!source||!document.graph.sourceUris.has(message.uri)||source.version!==message.sourceVersion||source.conflict)throw new Error('Source changed. Select the block again.');
            const index=source.pieces.findIndex(piece=>piece.id===message.pieceId),piece=source.pieces[index];
            if(index<0||piece.kind!=='markdown')throw new Error('Choose a Markdown block.');
            const before=serializeSource(source),pieces=[...source.pieces];
            if(message.action==='delete')pieces.splice(index,1);
            else if(message.action==='duplicate')pieces.splice(index+1,0,{...piece,id:'copy-'+randomBytes(8).toString('hex'),raw:'\n\n'+piece.raw});
            else if(message.action==='up'||message.action==='down'){
              const target=index+(message.action==='up'?-1:1),neighbor=pieces[target];
              if(!neighbor||neighbor.kind==='import')throw new Error('Cannot move across an Include boundary or the beginning/end of the source.');
              [pieces[index],pieces[target]]=[pieces[target],pieces[index]];
            }else throw new Error('Unsupported block operation.');
            let after='';const eol=before.includes('\r\n')?'\r\n':'\n';
            for(const item of pieces){if(after&&item.raw&&!after.endsWith(eol+eol)&&!item.raw.startsWith(eol))after+=after.endsWith(eol)?eol:eol+eol;after+=item.raw;}
            document.repository.editDraft(source.uri,before,after);
            this.recordEdit(document,'Change source block',()=>this.enqueue(async()=>document.repository.editDraft(source.uri,after,before)),()=>this.enqueue(async()=>document.repository.editDraft(source.uri,before,after)));
            void panel.webview.postMessage({type:'result',id:message.id,result:true});
          }
          else if(message.type==='edit-region'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode.');
            const source=document.repository.sources.get(message.uri);
            const changes=message.changes as PieceEdit[];
            if(!source||source.conflict||!document.graph.sourceUris.has(message.uri)||!Array.isArray(changes)||!changes.length||changes.some(edit=>edit.uri!==message.uri||typeof edit.before!=='string'||typeof edit.after!=='string'))throw new Error('Invalid continuous source edit.');
            const indexes=changes.map(edit=>source.pieces.findIndex(piece=>piece.id===edit.pieceId));
            if(indexes.some((index,i)=>index<0||(i>0&&index!==indexes[i-1]+1)))throw new Error('Continuous editing cannot cross Include or source boundaries.');
            document.repository.apply(changes,'after',true,message.origin);
            this.recordEdit(document,message.separateHistory?'Edit source selection':'Edit Markdown block',()=>this.enqueue(async()=>document.repository.apply(changes,'before')),()=>this.enqueue(async()=>document.repository.apply(changes,'after')),message.separateHistory?undefined:`${message.uri}::region:${changes[0].pieceId}`);
          }
          else if(message.type==='insert-block'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: insert rejected.');
            const text=String(message.text??'');
            if(!text.trim())throw new Error('Nothing to insert.');
            if(message.uri&&!document.graph.sourceUris.has(message.uri))throw new Error('The source for this block is no longer part of the document. Reload and retry.');
            const uri=message.uri??document.rootUri;
            const source=document.repository.sources.get(uri)??await document.repository.load(uri);
            if(message.sourceVersion!==undefined&&source.version!==message.sourceVersion)throw new Error('Insertion target changed. Select it again.');
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
          else if(message.type==='replace'||message.type==='preview-replace'){
            if(this.readOnlyPanels.has(panel))throw new Error('Read-only mode: replacement rejected.');
            const query=String(message.query??'').trim(),replacement=String(message.replacement??'');
            if(!query)throw new Error('Enter text to replace.');
            if(!message.all && (!document.graph.sourceUris.has(message.uri)||typeof message.pieceId!=='string'||!message.range))throw new Error('Locate a current match before replacing.');
            const changes:PieceEdit[]=[];let count=0;
            const versions:Record<string,number>={};
            for(const uri of document.graph.sourceUris){
              if(!message.all&&uri!==message.uri)continue;
              const source=document.repository.sources.get(uri);if(!source)continue;
              if(!message.all&&source.version!==message.sourceVersion)throw new Error('Source changed. Find the match again; nothing was replaced.');
              for(const piece of source.pieces){
                if(piece.kind!=='markdown'||(!message.all&&piece.id!==message.pieceId))continue;
                const result=replaceMatches(piece.raw,query,replacement,!!message.sourceMode,!!message.matchCase,message.all?undefined:message.range);
                if(!result.count||result.after===piece.raw)continue;
                if(source.conflict)throw new Error('Resolve all affected source conflicts before replacing. No files were changed.');
                changes.push({uri,pieceId:piece.id,before:piece.raw,after:result.after});count+=result.count;versions[uri]=source.version;
              }
            }
            const files=Object.keys(versions);
            if(message.type==='preview-replace'){
              const plan=randomBytes(16).toString('hex');
              this.replacementPlans.set(plan,{document,changes,versions,count});
              if(this.replacementPlans.size>20)this.replacementPlans.delete(this.replacementPlans.keys().next().value!);
              void panel.webview.postMessage({type:'result',id:message.id,result:{plan,count,files}});return;
            }
            let selected=changes;let replaced=count;
            if(message.plan){
              const plan=this.replacementPlans.get(message.plan);this.replacementPlans.delete(message.plan);
              if(!plan||plan.document!==document)throw new Error('Replacement preview expired. Review again.');
              for(const [uri,version]of Object.entries(plan.versions)){const source=document.repository.sources.get(uri);if(!source||source.version!==version||source.conflict)throw new Error('A previewed file changed. Review replacements again; nothing was changed.');}
              selected=plan.changes;replaced=plan.count;
            }else if(message.all&&files.length>1)throw new Error('Review the affected files before replacing across sources.');
            if(selected.length){
              document.repository.apply(selected,'after',true);
              this.recordEdit(document,'Replace text',()=>this.enqueue(async()=>document.repository.apply(selected,'before')),()=>this.enqueue(async()=>document.repository.apply(selected,'after')));
            }
            void panel.webview.postMessage({type:'result',id:message.id,result:{count:replaced,pieces:selected.length}});
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
            if(message.separateHistory)this.sealEditGroup();
            this.recordEdit(document,message.separateHistory?'Paste or format Markdown':'Edit Markdown block',
              () => this.enqueue(async () => { document.repository.apply(changes,'before'); }),
              () => this.enqueue(async () => { document.repository.apply(changes,'after'); }),
              message.separateHistory?undefined:`${message.uri}::${message.pieceId}`);
          } else if (message.type === 'reveal' && document.graph.sourceUris.has(message.uri)) {const source=document.repository.sources.get(message.uri);const index=source?.pieces.findIndex(piece=>piece.id===message.pieceId)??-1;const offset=index<0?0:source!.pieces.slice(0,index).reduce((sum,piece)=>sum+piece.raw.length,0);const text=await vscode.workspace.openTextDocument(vscode.Uri.parse(message.uri));const position=text.positionAt(offset);await vscode.window.showTextDocument(text,{selection:new vscode.Range(position,position)});}
          else if ((message.type === 'link'||message.type==='wikilink') && document.graph.sourceUris.has(message.uri)) {
            const href=String(message.type==='wikilink'?message.target:message.href);
            if(/^https?:\/\/|^mailto:/i.test(href)){await vscode.env.openExternal(vscode.Uri.parse(href));return;}
            const hash=href.split('#',2)[1];let path=href.split('#',2)[0];
            if(message.type==='wikilink'&&path&&!/\.md$/i.test(path))path+='.md';
            if(!path){void panel.webview.postMessage({type:'navigate-hash',hash:hash??''});return;}
            const io=document.repository.io as LocalFileIO;
            const target=await io.resolveResource(message.uri,decodeURIComponent(path));
            try{await vscode.workspace.fs.stat(vscode.Uri.parse(target));}catch{throw new Error(`Link target is missing: ${path}. Edit the link or explicitly create the Markdown file. No file was created.`);}
            if(/\.md$/i.test(path)){
              if(hash)this.pendingAnchors.set(target,hash);
              void vscode.commands.executeCommand('vscode.openWith',vscode.Uri.parse(target),EditorProvider.viewType).then(()=>{for(const other of this.documents)if(other.rootUri===target)this.post(other,{type:'navigate-hash',hash:hash??''});});
            }else void vscode.commands.executeCommand('vscode.open',vscode.Uri.parse(target));
          }
          else if (message.type === 'conflict' && document.trackedSources.has(message.uri)) {
            this.sealEditGroup();
            if (message.choice === 'diff') await this.diff(document,message.uri);
            else if (message.choice === 'reload' || message.choice === 'keep') await document.repository.resolveConflict(message.uri,message.choice);
          }
        } catch (error) {
          const text=translate(String(error),vscode.env.language);
          if(message.id)void panel.webview.postMessage({type:'result',id:message.id,error:text});
          else void panel.webview.postMessage({type:'error',message:text});
        }
      });
    });
  }
  private async storeImage(document:CompositeDocument,sourceUri:string,bytes:Uint8Array,name:string,mime:string){
    if(bytes.length>20*1024*1024)throw new Error('Image is larger than 20 MB.');
    const types:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg'};
    const extension=types[mime];if(!extension)throw new Error('Unsupported image type.');
    const sourceDirectory=dirname(fileURLToPath(sourceUri));
    const assetDirectory=vscode.workspace.getConfiguration('markyou').get<string>('assetDirectory','assets');
    if(!assetDirectory||/^[a-z]:|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/i.test(assetDirectory))throw new Error('Resource directory must be relative and inside the workspace.');
    const io=document.repository.io as LocalFileIO;
    await io.resolveResource(sourceUri,assetDirectory+'/image.'+extension);
    const directory=join(sourceDirectory,assetDirectory);await vscode.workspace.fs.createDirectory(vscode.Uri.file(directory));
    const base=name.replace(/\.[^.]+$/,'').replace(/[^\w.-]+/g,'-').slice(0,60)||'image';
    const path=await io.resolveResource(sourceUri,`${assetDirectory}/${base}-${randomBytes(8).toString('hex')}.${extension}`);
    await vscode.workspace.fs.writeFile(vscode.Uri.parse(path),bytes);
    return relative(sourceDirectory,fileURLToPath(path)).replace(/\\/g,'/');
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
      display: {...this.displayPreferences(),readOnly:typeof saved.readOnly==='boolean'?saved.readOnly:configuration.get<boolean>('defaultReadOnly',false)},
      version: String(this.context.extension.packageJSON.version ?? ''),
      productName: 'MarkYou',
      rootUri:document.rootUri,
      rootVersion:document.repository.sources.get(document.rootUri)?.version,
    };
  }
  private displayPreferences() {
    const saved = this.context.globalState.get<Record<string, unknown>>('markyou.display') ?? {};
    return {
      textSize: typeof saved.textSize === 'number' ? Math.max(12, Math.min(28, saved.textSize)) : 16,
      readingWidth: ['narrow', 'standard', 'wide'].includes(String(saved.readingWidth)) ? saved.readingWidth : 'standard',
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
        sourceVersion:document.repository.sources.get(segment.sourceUri)?.version??segment.sourceVersion,
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
      await vscode.workspace.fs.writeFile(context.destination,Buffer.from(JSON.stringify({sources,drafts:document.drafts}),'utf8'));
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
    return `<!doctype html><html lang="${vscode.env.language}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob: https: http:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; font-src ${webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body><nav id="toolbar" aria-label="Formatting toolbar"></nav><div id="statusbar" role="group" aria-label="Document status"><span id="status" role="status" aria-live="polite">Ready</span></div><div id="readonly-banner" role="status" hidden><span>Read-only preview — editing is disabled</span><button type="button" id="enable-editing">Enable editing</button></div><aside id="conflicts" aria-live="assertive"></aside><div id="notice" role="alert" hidden></div><main id="document" aria-label="Markdown document" tabindex="-1"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  dispose() { this.diagrams.dispose(); for (const timer of this.pendingFiles.values()) clearTimeout(timer); for (const item of this.subscriptions) item.dispose(); this.edits.dispose(); }
}
