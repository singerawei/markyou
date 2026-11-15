export interface UnappliedDraft {
  key:string; uri:string; pieceId:string; kind:'markdown'|'mermaid'|'html';
  baseline:string; value:string; updatedAt:number;
}
