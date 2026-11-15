import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireBrowser,browserCacheLayout,installBrowser,systemBrowserPaths,type BrowserCandidate,type BrowserServices} from '../src/extension/browserRuntimeCore';

const edge={name:'Microsoft Edge',executablePath:'edge.exe'},chrome={name:'Google Chrome',executablePath:'chrome.exe'},cached={name:'Chromium',executablePath:'cache.exe'};
function fixture(){
  const calls:string[]=[];let cache:BrowserCandidate|undefined;
  const browser={close:async()=>{calls.push('close');}};
  const services:BrowserServices<typeof browser>={
    installed:async()=>[],cached:async()=>cache,
    install:async(force)=>{calls.push(`install:${force}`);cache=cached;},
    launch:async candidate=>{calls.push(`launch:${candidate.name}`);return browser;},report:()=>{}
  };
  return {services,calls,browser,cache:(value:BrowserCandidate)=>{cache=value;}};
}
test('installed Edge is preferred over Chrome and a cached engine without a download',async()=>{
  const f=fixture();f.services.installed=async()=>[edge,chrome];f.cache(cached);
  assert.equal(await acquireBrowser(f.services,new AbortController().signal),f.browser);
  assert.deepEqual(f.calls,['launch:Microsoft Edge']);
});
test('Chrome is used if Edge cannot launch',async()=>{
  const f=fixture();f.services.installed=async()=>[edge,chrome];
  const launch=f.services.launch;f.services.launch=async candidate=>{if(candidate===edge)throw new Error('Policy blocked');return launch(candidate);};
  await acquireBrowser(f.services,new AbortController().signal);assert.deepEqual(f.calls,['launch:Google Chrome']);
});
test('the downloaded engine is reused offline',async()=>{
  const f=fixture();f.cache(cached);await acquireBrowser(f.services,new AbortController().signal);
  assert.deepEqual(f.calls,['launch:Chromium']);
});
test('no installed browser downloads once and reuses the completed cache',async()=>{
  const f=fixture();await acquireBrowser(f.services,new AbortController().signal);await acquireBrowser(f.services,new AbortController().signal);
  assert.deepEqual(f.calls,['install:false','launch:Chromium','launch:Chromium']);
});
test('prewarming never downloads an engine',async()=>{
  const f=fixture();await assert.rejects(acquireBrowser(f.services,new AbortController().signal,false),/No PDF\/diagram browser/);
  assert.deepEqual(f.calls,[]);
});
test('a failed download can be retried and an incomplete cache is rejected',async()=>{
  const f=fixture();const install=f.services.install;f.services.install=async()=>{throw new Error('Offline');};
  await assert.rejects(acquireBrowser(f.services,new AbortController().signal),/Check your connection and retry/);
  f.services.install=async()=>{};await assert.rejects(acquireBrowser(f.services,new AbortController().signal),/incomplete/);
  f.services.install=install;await acquireBrowser(f.services,new AbortController().signal);assert.deepEqual(f.calls,['install:false','launch:Chromium']);
});
test('an unusable cached engine is reinstalled',async()=>{
  const f=fixture();f.cache(cached);let attempts=0;const launch=f.services.launch;
  f.services.launch=async candidate=>{if(++attempts===1)throw new Error('Corrupt');return launch(candidate);};
  await acquireBrowser(f.services,new AbortController().signal);assert.deepEqual(f.calls,['install:true','launch:Chromium']);
});
test('cancellation stops preparation and closes a browser acquired during cancellation',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(acquireBrowser(f.services,controller.signal));assert.deepEqual(f.calls,[]);
  const active=new AbortController();f.services.installed=async()=>[edge];f.services.launch=async()=>{active.abort();return f.browser;};
  await assert.rejects(acquireBrowser(f.services,active.signal));assert.deepEqual(f.calls,['close']);
});
test('Windows candidates include per-user installs and skip missing or relative roots',()=>{
  const paths=systemBrowserPaths({ProgramFiles:'C:\\Program Files',ProgramW6432:'C:\\Program Files',LOCALAPPDATA:'D:\\User Data', 'ProgramFiles(x86)':'relative'});
  assert.equal(paths.length,4);assert.ok(paths.some(path=>path.executablePath==='D:\\User Data\\Google\\Chrome\\Application\\chrome.exe'));
  assert.equal(paths[0].name,'Microsoft Edge');assert.deepEqual(systemBrowserPaths({}),[]);
});
test('the cached executable is tied to the shipped Playwright revision',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'markyou-browser-layout-'));
  await writeFile(join(directory,'browsers.json'),JSON.stringify({browsers:[{name:'chromium-headless-shell',revision:'42'}]}));
  assert.match((await browserCacheLayout(directory,'cache')).executablePath,/chromium_headless_shell-42/);
  await writeFile(join(directory,'browsers.json'),JSON.stringify({browsers:[{name:'chromium-headless-shell',revision:'../elsewhere'}]}));
  await assert.rejects(browserCacheLayout(directory,'cache'),/revision/);
});
test('cancelling an installer terminates it and permits a subsequent retry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'markyou-browser-installer-')),cache=join(directory,'cache'),started=join(directory,'started');
  await writeFile(join(directory,'cli.js'),`require('node:fs').writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000);`);
  const controller=new AbortController();const download=installBrowser(directory,cache,false,controller.signal,()=>{});
  // Attach a rejection observer immediately while waiting for the child to start.
  const stopped=assert.rejects(download);const deadline=Date.now()+10000;
  while(true){try{await readFile(started);break;}catch{if(Date.now()>deadline)throw new Error('Installer did not start');await new Promise(resolve=>setTimeout(resolve,20));}}
  controller.abort();await stopped;
  await writeFile(join(directory,'cli.js'),'process.exit(0)');
  await installBrowser(directory,cache,false,new AbortController().signal,()=>{});
});
