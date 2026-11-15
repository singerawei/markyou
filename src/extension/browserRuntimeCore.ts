import {execFile,spawn} from 'node:child_process';
import {stat,readFile,mkdir} from 'node:fs/promises';
import {join,win32} from 'node:path';

export interface BrowserCandidate {name:string;executablePath:string}
interface BrowserHandle {close():Promise<void>}
export interface BrowserServices<T extends BrowserHandle> {
  installed():Promise<BrowserCandidate[]>;
  cached():Promise<BrowserCandidate|undefined>;
  install(force:boolean,signal:AbortSignal,report:(message:string)=>void):Promise<void>;
  launch(candidate:BrowserCandidate):Promise<T>;
  report(message:string):void;
}
export async function acquireBrowser<T extends BrowserHandle>(services:BrowserServices<T>,signal:AbortSignal,allowDownload=true):Promise<T> {
  signal.throwIfAborted();
  const launch=async(candidate:BrowserCandidate)=>{
    signal.throwIfAborted();services.report(`Using ${candidate.name}`);
    const browser=await services.launch(candidate);
    if(signal.aborted){await browser.close();signal.throwIfAborted();}
    return browser;
  };
  for(const candidate of await services.installed()) {
    signal.throwIfAborted();
    try{return await launch(candidate);}catch{signal.throwIfAborted();}
  }
  const cached=await services.cached();
  if(cached){try{return await launch(cached);}catch{signal.throwIfAborted();}}
  signal.throwIfAborted();
  if(!allowDownload)throw new Error('No PDF/diagram browser is ready.');
  services.report('Downloading browser engine…');
  try{await services.install(!!cached,signal,services.report);}catch(error){
    signal.throwIfAborted();
    throw new Error('Could not download the browser engine. Check your connection and retry, or install Microsoft Edge or Google Chrome.',{cause:error});
  }
  signal.throwIfAborted();
  const installed=await services.cached();
  if(!installed)throw new Error('Browser download is incomplete. Retry to finish preparing the browser engine.');
  return launch(installed);
}

export async function isFile(path:string):Promise<boolean>{try{return(await stat(path)).isFile();}catch{return false;}}
export function systemBrowserPaths(env:NodeJS.ProcessEnv):BrowserCandidate[]{
  const roots=[env['ProgramFiles(x86)'],env.ProgramW6432,env.ProgramFiles,env.LOCALAPPDATA].filter((root):root is string=>!!root&&win32.isAbsolute(root));
  return [
    ...roots.map(root=>({name:'Microsoft Edge',executablePath:win32.join(root,'Microsoft','Edge','Application','msedge.exe')})),
    ...roots.map(root=>({name:'Google Chrome',executablePath:win32.join(root,'Google','Chrome','Application','chrome.exe')}))
  ].filter((candidate,index,all)=>all.findIndex(other=>other.executablePath.toLowerCase()===candidate.executablePath.toLowerCase())===index);
}
async function registeredBrowsers():Promise<BrowserCandidate[]>{
  const browsers=[{name:'Microsoft Edge',exe:'msedge.exe'},{name:'Google Chrome',exe:'chrome.exe'}];
  const values=await Promise.all(browsers.flatMap(browser=>['HKCU','HKLM'].map(hive=>new Promise<BrowserCandidate|undefined>(resolve=>{
    execFile('reg.exe',['query',`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${browser.exe}`,'/ve'],{windowsHide:true,timeout:2000},(error,stdout)=>{
      const path=error?undefined:stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim().replace(/^"|"$/g,'').replace(/%([^%]+)%/g,(all,key)=>process.env[key]??all);
      resolve(path&&win32.isAbsolute(path)&&path.toLowerCase().endsWith('.exe')?{name:browser.name,executablePath:path}:undefined);
    });
  }))));
  return values.filter((value):value is BrowserCandidate=>!!value);
}
export async function installedBrowsers():Promise<BrowserCandidate[]>{
  if(process.platform!=='win32')return [];
  const paths=[...systemBrowserPaths(process.env),...await registeredBrowsers()];
  const candidates=paths.filter((candidate,index)=>paths.findIndex(other=>other.executablePath.toLowerCase()===candidate.executablePath.toLowerCase())===index);
  const exists=await Promise.all(candidates.map(candidate=>isFile(candidate.executablePath)));
  return candidates.filter((_,index)=>exists[index]).sort((a,b)=>Number(a.name==='Google Chrome')-Number(b.name==='Google Chrome'));
}

export async function browserCacheLayout(runtimePath:string,cachePath:string){
  const metadata=JSON.parse(await readFile(join(runtimePath,'browsers.json'),'utf8'));
  const revision=metadata.browsers.find((browser:{name:string})=>browser.name==='chromium-headless-shell')?.revision;
  if(!/^\d+$/.test(revision))throw new Error('Missing browser engine revision.');
  const directory=join(cachePath,`chromium_headless_shell-${revision}`);
  return {executablePath:join(directory,'chrome-headless-shell-win64','chrome-headless-shell.exe'),marker:join(directory,'INSTALLATION_COMPLETE')};
}
export function installBrowser(runtimePath:string,cachePath:string,force:boolean,signal:AbortSignal,report:(message:string)=>void):Promise<void>{
  signal.throwIfAborted();
  return mkdir(cachePath,{recursive:true}).then(()=>new Promise<void>((resolve,reject)=>{
    signal.throwIfAborted();
    const child=spawn(process.execPath,[join(runtimePath,'cli.js'),'install','chromium-headless-shell','--no-remove',...(force?['--force']:[])],{
      windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PLAYWRIGHT_BROWSERS_PATH:cachePath,PLAYWRIGHT_SKIP_BROWSER_GC:'1',CI:'1'}
    });
    const stop=()=>{
      if(child.exitCode!==null)return;
      if(process.platform==='win32'&&child.pid){
        execFile('taskkill.exe',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>{if(child.exitCode===null)child.kill();});
      }else child.kill();
    };
    signal.addEventListener('abort',stop,{once:true});
    let timedOut=false,output='',lastPercent='';
    const timer=setTimeout(()=>{timedOut=true;stop();},10*60*1000);
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
    child.stdout.on('data',(data:Buffer)=>{
      output=(output+data.toString()).slice(-2048);
      const percent=[...output.matchAll(/(\d+)% of/g)].at(-1)?.[1];
      if(percent&&percent!==lastPercent){lastPercent=percent;report(`Downloading browser engine… ${percent}%`);}
    });
    // Drain the stream; download failures get an actionable message without exposing environment details.
    child.stderr.on('data',()=>{});
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',code=>{cleanup();if(signal.aborted)reject(signal.reason);else if(timedOut)reject(new Error('Browser download timed out.'));else if(code===0)resolve();else reject(new Error(`Browser installer exited with code ${code}.`));});
    if(signal.aborted)stop();
  }));
}
