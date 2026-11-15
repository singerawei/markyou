import * as vscode from 'vscode';
import {chromium,type Browser} from 'playwright-core';
import {join} from 'node:path';
import {acquireBrowser,browserCacheLayout,installedBrowsers,installBrowser,isFile} from './browserRuntimeCore';
import {translate} from '../shared/localization';

export interface BrowserRequest {allowDownload?:boolean;signal?:AbortSignal;report?:(message:string)=>void}
export function launchManagedBrowser(extensionPath:string,storagePath:string,request:BrowserRequest={}):Promise<Browser>{
  const runtimePath=join(extensionPath,'dist','node_modules','playwright-core');
  const cachePath=join(storagePath,'browser');
  const run=(signal:AbortSignal,report:(message:string)=>void)=>acquireBrowser({
    installed:installedBrowsers,
    cached:async()=>{const paths=await browserCacheLayout(runtimePath,cachePath);return await isFile(paths.marker)&&await isFile(paths.executablePath)?{name:'Chromium',executablePath:paths.executablePath}:undefined;},
    install:(force,signal,report)=>installBrowser(runtimePath,cachePath,force,signal,report),
    launch:candidate=>chromium.launch({executablePath:candidate.executablePath,headless:true,timeout:15000}),
    report:message=>report(translate(message,vscode.env.language))
  },signal,request.allowDownload!==false);
  if(request.report||request.allowDownload===false)return run(request.signal??new AbortController().signal,request.report??(()=>{}));
  return Promise.resolve(vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:translate('Preparing document browser',vscode.env.language),cancellable:true},async(progress,token)=>{
    const controller=new AbortController();const subscription=token.onCancellationRequested(()=>controller.abort());
    try{return await run(request.signal?AbortSignal.any([controller.signal,request.signal]):controller.signal,message=>progress.report({message}));}
    finally{subscription.dispose();}
  }));
}
