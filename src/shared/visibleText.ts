/**
 * Approximate the text a reader sees. Shared by Find and by the host-side
 * replacement guard so both decide what counts as visible text.
 */
export function visibleText(markdown: string): string { return mappedVisibleText(markdown,false).text; }

export function mappedVisibleText(markdown: string,tracked=true): MappedText {
  let text = new MappedText(markdown,undefined,tracked).replace(/\r\n?/g, '\n');
  text = text.replace(/^(?:\uFEFF)?(---|\+\+\+)[ \t]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/, '');
  text = text.replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, '$1');
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  // Protect code spans: their contents are literal, so `*args*` and
  // snake_case_name must not be treated as emphasis markers.
  const inlineCode: MappedText[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, content: string, offset: number) => {
    inlineCode.push(text.slice(offset + 1, offset + 1 + content.length));
    return `\uE000${inlineCode.length - 1}\uE001`;
  });
  text = text.replace(/\\([\\`*_[\]<>~^=$|])/g, (_match,content:string,offset:number)=>{
    inlineCode.push(new MappedText(content,text.tracked?[{start:text.spans[offset].start,end:text.spans[offset+1].end}]:undefined,text.tracked));
    return `\uE000${inlineCode.length-1}\uE001`;
  });
  text = text.replace(/!\[\[([^\]]*)\]\]/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match:string,target:string,label:string|undefined,offset:number)=>{
    const value=label||target,start=label?match.lastIndexOf(label):2;
    return text.slice(offset+start,offset+start+value.length);
  });
  text = text.replace(/^ {0,3}\[[^\]]+\]:[ \t]*\S+.*$/gm, '');
  text = text.replace(/^\*\[[^\]]+\]:.*$/gm, '');
  text = text.replace(/^ {0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^ {0,3}>[ \t]?/gm, '');
  text = text.replace(/^ {0,3}(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '');
  text = text.replace(/^[ \t]*\[toc\][ \t]*$/gim, '');
  text = text.replace(/^[ \t]*@import\b.*$/gm, '');
  text = text.replace(/%%[\s\S]*?%%/g, '');
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/__(.*?)__/g, '$1');
  text = text.replace(/\*(.*?)\*/g, '$1');
  // Intraword underscores are literal (snake_case_name), not emphasis.
  text = text.replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, '$1$2');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/==(.*?)==/g, '$1');
  text = text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => inlineCode[Number(index)] ?? '');
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, '$1');
  text = text.replace(/\$([^$\n]+)\$/g, '$1');
  text = text.replace(/\[\^([^\]]+)\]/g, '$1');
  text = text.replace(/^[ \t]*!!![ \t]*[^\n]*$/gm, '');
  text = text.replace(/^[ \t]*>[ \t]*\[![^\]]+\][^\n]*$/gm, '');
  text = text.replace(/^[ \t]*:[ \t]+/gm, '');
  text = text.replace(/^[ \t]*\|/gm, '').replace(/\|[ \t]*$/gm, '');
  text = text.replace(/[ \t]*\|[ \t]*/g, ' ');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function decodeEntities(value: MappedText) {
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match,code:string)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(code.startsWith('x')?code.slice(1):code,code.startsWith('x')?16:10))))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}


/** Each visible UTF-16 character retains its exact source span. */
export class MappedText {
  readonly spans: {start:number;end:number}[];
  constructor(readonly text:string, spans?: {start:number;end:number}[],readonly tracked=true) {
    this.spans = spans ?? (tracked?Array.from({length:text.length},(_,i)=>({start:i,end:i+1})):[]);
  }
  slice(start:number,end=this.text.length) {return new MappedText(this.text.slice(start,end),this.tracked?this.spans.slice(start,end):undefined,this.tracked);}
  trim() {const start=this.text.length-this.text.trimStart().length;return this.slice(start,this.text.trimEnd().length);}
  replace(expression:RegExp,replacement:string|((...args:any[])=>string|MappedText)):MappedText {
    if(!this.tracked){
      const value=typeof replacement==='string'?this.text.replace(expression,replacement):this.text.replace(expression,(...args)=>{const result=replacement(...args);return result instanceof MappedText?result.text:result;});
      return new MappedText(value,undefined,false);
    }
    const pattern=new RegExp(expression.source,expression.flags.includes('g')?expression.flags:expression.flags+'g');
    const chunks:MappedText[]=[];let cursor=0;
    for(const match of this.text.matchAll(pattern)) {
      const start=match.index!;chunks.push(this.slice(cursor,start));
      const whole=this.slice(start,start+match[0].length);
      const literal=(value:string)=>new MappedText(value,Array.from({length:value.length},()=>({start:whole.spans[0]?.start??start,end:whole.spans.at(-1)?.end??start})));
      if(typeof replacement==='function') {
        const result=replacement(...match,start,this.text);
        if(result instanceof MappedText)chunks.push(result);
        else {const offset=match[0].indexOf(result);chunks.push(result&&offset>=0?this.slice(start+offset,start+offset+result.length):literal(result));}
      } else {
        let previous=0;let captureCursor=0;
        for(const part of replacement.matchAll(/\$(\d+)/g)) {
          chunks.push(literal(replacement.slice(previous,part.index)));
          const group=match[Number(part[1])]??'';let offset=match[0].indexOf(group,captureCursor);if(offset<0)offset=match[0].indexOf(group);captureCursor=offset+group.length;
          chunks.push(this.slice(start+Math.max(0,offset),start+Math.max(0,offset)+group.length));previous=part.index!+part[0].length;
        }
        chunks.push(literal(replacement.slice(previous)));
      }
      cursor=start+match[0].length;
      if(!expression.global)break;
    }
    chunks.push(this.slice(cursor));return new MappedText(chunks.map(chunk=>chunk.text).join(''),chunks.flatMap(chunk=>chunk.spans));
  }
}
