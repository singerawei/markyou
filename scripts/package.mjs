import {execFileSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const manifest=JSON.parse(await readFile('package.json','utf8'));
const preview=process.env.MARKYOU_PRE_RELEASE==='true';
execFileSync(process.execPath,[resolve('node_modules/@vscode/vsce/vsce'),'package','--target','win32-x64','--no-dependencies','--no-rewrite-relative-links',...(preview?['--pre-release']:[])],{stdio:'inherit'});
const {readVSIXPackage,readZip}=require('@vscode/vsce/out/zip.js');
const filename=`markyou-win32-x64-${manifest.version}.vsix`;
const vsix=await readVSIXPackage(filename);
const metadata=vsix.xmlManifest.PackageManifest.Metadata[0];
const packagedPreview=!!metadata.Properties?.[0]?.Property.some(property=>property.$.Id==='Microsoft.VisualStudio.Code.PreRelease');
if(vsix.manifest.publisher!==manifest.publisher||vsix.manifest.name!==manifest.name||vsix.manifest.version!==manifest.version||packagedPreview!==preview){
  throw new Error('Packaged identity, version or pre-release channel does not match the requested release.');
}
const files=[];
await readZip(filename,name=>{files.push(name);return false;});
if(files.some(name=>/^extension\/(?:engine\/|\.cache\/)|\/(?:chrome-headless-shell|chrome|msedge)\.exe$/i.test(name)))throw new Error('The VSIX must not contain a browser binary or browser cache.');
const bytes=(await stat(filename)).size;
if(bytes>20*1024*1024)throw new Error('The VSIX exceeds 20 MiB. Check for accidentally bundled browsers or development files.');
console.log(`Browser-free VSIX: ${(bytes/1024/1024).toFixed(2)} MiB.`);
console.log(`Verified package: ${manifest.publisher}.${manifest.name} ${manifest.version} (${preview?'pre-release':'stable'}).`);
