import {mappedVisibleText} from './visibleText';

export interface TextMatch {start:number;end:number}
export function textMatches(text:string,query:string,matchCase:boolean):TextMatch[] {
  if(!query)return [];
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase?'g':'gi');
  return [...text.matchAll(pattern)].map(match=>({start:match.index!,end:match.index!+match[0].length}));
}

/** Visible replacements edit text characters while retaining Markdown delimiters. */
export function replaceMatches(raw:string,query:string,replacement:string,sourceMode:boolean,matchCase:boolean,current?:TextMatch) {
  const mapped=sourceMode?undefined:mappedVisibleText(raw);
  const matches=textMatches(mapped?.text??raw,query,matchCase).filter(match=>!current||(match.start===current.start&&match.end===current.end));
  let after=raw;
  for(const match of [...matches].reverse()) {
    if(!mapped) {after=after.slice(0,match.start)+replacement+after.slice(match.end);continue;}
    const spans=mapped.spans.slice(match.start,match.end);
    const unique=[...new Map(spans.map(span=>[`${span.start}:${span.end}`,span])).values()].sort((a,b)=>a.start-b.start);
    const inCode=[...raw.matchAll(/(`+)([^\r\n]*?)\1/g)].some(code=>unique[0]?.start>=code.index!+code[1].length&&unique.at(-1)!.end<=code.index!+code[0].length-code[1].length);
    if(inCode&&replacement.includes('`'))throw new Error('Replacement contains code delimiters. Use source mode to review the exact code span.');
    const literal=inCode?replacement:replacement.replace(/[\\`*_[\]<>~^=$|]/g,'\\$&');
    for(let i=unique.length-1;i>=0;i--) {
      const span=unique[i];after=after.slice(0,span.start)+(i===0?literal:'')+after.slice(span.end);
    }
  }
  return {after,count:matches.length};
}
