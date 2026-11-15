import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
// This helper deliberately uses the pinned publishing tool's token exchange,
// so the probe exercises exactly the authentication used by `vsce --oidc`.
const {getOIDCCredential}=require('@vscode/vsce/out/oidc.js');
const {publisher}=JSON.parse(await readFile('package.json','utf8'));
if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Run this check with GitHub Actions and the marketplace environment.');
if(typeof publisher!=='string'||!publisher)throw new Error('Missing Marketplace publisher.');
await getOIDCCredential(publisher);
console.log(`Marketplace Trusted Publishing verified for ${publisher}. No extension was uploaded; no credential was stored or printed.`);
