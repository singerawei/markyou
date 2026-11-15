import type {Segment} from '../shared/types';
import type {UnappliedDraft} from '../shared/draft';

let publish:(draft:UnappliedDraft|{key:string;remove:true})=>void=()=>{};
const drafts=new Map<string,UnappliedDraft>();
let onChange:()=>void=()=>{};
export function configureDrafts(send:typeof publish,change:()=>void){publish=send;onChange=change;}
export function restoredDrafts(values:UnappliedDraft[]){for(const draft of values)drafts.set(draft.key,draft);onChange();}
export function pendingDrafts(){return [...drafts.values()];}
export function discardDraft(key:string){drafts.delete(key);publish({key,remove:true});onChange();}
export function trackDraft(segment:Segment,kind:UnappliedDraft['kind']){
  const baseline=segment.text,key=`${segment.sourceUri}::${segment.pieceId}::${kind}`;
  return {
    update(value:string){
      if(value===baseline){discardDraft(key);return;}
      const draft:UnappliedDraft={key,uri:segment.sourceUri,pieceId:segment.pieceId,kind,baseline,value,updatedAt:Date.now()};
      drafts.set(key,draft);publish(draft);onChange();
    },
    clear(){discardDraft(key);}
  };
}
