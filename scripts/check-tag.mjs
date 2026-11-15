import {readFile} from 'node:fs/promises';
const {version}=JSON.parse(await readFile('package.json','utf8'));
const tag=process.env.RELEASE_TAG??'';
if(!new RegExp(`^v${version.replaceAll('.','\\.')}(?:-[a-zA-Z0-9.-]+)?$`).test(tag)){
  throw new Error(`Release tag ${tag} must match package version ${version}.`);
}
console.log(`Release tag validated: ${tag}`);
