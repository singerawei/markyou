import {readFile,appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function verifiedPreview(run,jobs,repository,version){
  const tag=run.head_branch;
  const pattern=new RegExp(`^v${version.replaceAll('.','\\.')}-[a-zA-Z0-9.-]+$`);
  if(run.conclusion!=='success'||run.event!=='push'||run.head_repository?.full_name!==repository||run.path!=='.github/workflows/ci.yml'||!pattern.test(tag??''))throw new Error('Recovery requires a successful preview-tag run from this repository, workflow and package version.');
  for(const name of ['verify (ubuntu-latest)','verify (windows-latest)','release']){
    if(!jobs.some(job=>job.name===name&&job.conclusion==='success'))throw new Error(`The original preview has no successful ${name} job.`);
  }
  return tag;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const {version}=JSON.parse(await readFile('package.json','utf8'));
  const requested=process.env.PUBLISH_PREVIEW_RUN??'';
  let runId=process.env.GITHUB_RUN_ID,tag=process.env.GITHUB_REF_NAME;
  if(requested){
    if(!/^\d+$/.test(requested))throw new Error('Preview run ID must be numeric.');
    const repository=process.env.GITHUB_REPOSITORY;
    const api=async path=>{
      const response=await fetch(`https://api.github.com/repos/${repository}/${path}`,{headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`Cannot verify preview provenance: GitHub returned ${response.status}.`);
      return response.json();
    };
    const run=await api(`actions/runs/${requested}`);
    const {jobs}=await api(`actions/runs/${requested}/jobs?per_page=100`);
    tag=verifiedPreview(run,jobs,repository,version);
    let ref=(await api(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
    for(let depth=0;ref.type==='tag'&&depth<5;depth++)ref=(await api(`git/tags/${ref.sha}`)).object;
    if(ref.type!=='commit'||ref.sha!==run.head_sha)throw new Error('The preview tag no longer points to the tested commit.');
    runId=requested;
  }
  if(!runId||!tag||!process.env.GITHUB_OUTPUT)throw new Error('Publishing must run in GitHub Actions.');
  await appendFile(process.env.GITHUB_OUTPUT,`artifact_run_id=${runId}\nrelease_tag=${tag}\n`);
  console.log(`Publishing the verified package from run ${runId}, tag ${tag}.`);
}
