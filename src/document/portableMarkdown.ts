import {createHash} from 'node:crypto';
import {basename,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isFrontmatter} from '../shared/frontmatter';
import type {Segment} from '../shared/types';

export interface PortableResource {uri:string;name:string;bytes:Uint8Array}
export interface PortablePlan {markdown:string;resources:PortableResource[];chapters:number;omittedMetadata:number}

/** Snapshot current composition; never save or alter any source model. */
export async function portableMarkdown(segments:Segment[],rootUri:string,assetFolder:string,resolve:(from:string,path:string)=>Promise<string>,read:(uri:string)=>Promise<Uint8Array>):Promise<PortablePlan>{
  const errors=segments.filter(segment=>segment.error);
  if(errors.length)throw new Error('Resolve missing/circular Includes before exporting: '+errors.map(segment=>segment.error).join('; '));
  const resources=new Map<string,PortableResource>();let total=0;let omittedMetadata=0;
  const included=new Set(segments.map(segment=>segment.sourceUri));
  const rewrite=async(raw:string,owner:string,inResource=false):Promise<string>=>{
    // Fenced code is literal, so destinations inside it must never be rewritten.
    const fenced=/^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1[^\r\n]*(?:\r?\n|$)/gm;
    const protectedRanges=[...raw.matchAll(fenced),...raw.matchAll(/(`+)[^\r\n]*?\1/g)].map(match=>[match.index!,match.index!+match[0].length]);
    const destinations=[...raw.matchAll(/\]\((<[^>\r\n]+>|(?:\\.|[^\s()])+)(?:[ \t]+["'][^\r\n]*?["'])?\)|^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(<[^>\r\n]+>|\S+)/gm)];
    const edits:{start:number;end:number;value:string}[]=[];
    for(const match of destinations){
      if(protectedRanges.some(([start,end])=>match.index!>=start&&match.index!<end))continue;
      const destination=match[1]??match[2];const angled=destination.startsWith('<');
      const value=angled?destination.slice(1,-1):destination;
      if(!value||/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value))continue;
      const [path,fragment]=value.split('#',2);
      const uri=await resolve(owner,decodeURIComponent(path));
      let next:string;
      if(included.has(uri)&&extname(fileURLToPath(uri)).toLowerCase()==='.md')next=fragment?`#${fragment}`:'#';
      else{
        let resource=resources.get(uri);
        if(!resource){
          if(resources.size>=1000)throw new Error('Export has more than 1000 resources.');
          const name=createHash('sha256').update(uri).digest('hex').slice(0,12)+'-'+basename(fileURLToPath(uri)).replace(/[^\p{L}\p{N}._-]/gu,'-');
          resource={uri,name,bytes:await read(uri)};resources.set(uri,resource);total+=resource.bytes.length;
          if(total>100*1024*1024)throw new Error('Export resources exceed 100 MB.');
          if(extname(fileURLToPath(uri)).toLowerCase()==='.md')resource.bytes=new TextEncoder().encode(await rewrite(new TextDecoder().decode(resource.bytes),uri,true));
        }
        next=(inResource?'':assetFolder+'/')+encodeURIComponent(resource.name)+(fragment?'#'+fragment:'');
      }
      const start=match.index!+match[0].indexOf(destination);
      edits.push({start,end:start+destination.length,value:angled?`<${next}>`:next});
    }
    let result=raw;for(const edit of edits.reverse())result=result.slice(0,edit.start)+edit.value+result.slice(edit.end);
    return result;
  };
  const chunks:string[]=[];
  for(const segment of segments){
    if(segment.sourceUri!==rootUri&&isFrontmatter(segment.text)){omittedMetadata++;continue;}
    chunks.push(await rewrite(segment.text,segment.sourceUri));
  }
  return {markdown:chunks.join('\n\n'),resources:[...resources.values()],chapters:segments.length,omittedMetadata};
}
