import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTSV,encodeTSV} from '../src/webview/tableToolbar';
import {parser,schema,serializer} from '../src/webview/schema';
import {parsePieces} from '../src/document/includeParser';
import {replaceMatches,textMatches} from '../src/shared/replacements';
import {visibleText,mappedVisibleText} from '../src/shared/visibleText';
import {portableMarkdown} from '../src/document/portableMarkdown';
import type {Segment} from '../src/shared/types';

test('TSV preserves quoted multiline cells, padding, empty trailing records and literal paths',()=>{
  const rows=[['  padded  ','00123','C:\\new','\\\\server\\name'],['first\nsecond','a\tb','"quote"',''],['','','','']];
  assert.deepEqual(parseTSV(encodeTSV(rows)),rows);
  assert.deepEqual(parseTSV('A\tB\n\n'),[['A','B'],['']]);
  assert.deepEqual(parseTSV('one\ntwo\n'),[['one'],['two']]);
});

test('GFM cells survive two saves and reopen as editable tables',()=>{
  const values=['  padded  ','C:\\new','a|b','first\nsecond','00123','`code`','中文 😊'];
  const content=(value:string)=>value.split('\n').flatMap((text,index)=>[...(index?[schema.nodes.hard_break.create()]:[]),...(text?[schema.text(text)]:[])]);
  let doc=schema.nodes.doc.create(null,schema.nodes.table.create(null,[
    schema.nodes.table_row.create(null,values.map(value=>schema.nodes.table_header.create({align:'right'},content(value)))),
    schema.nodes.table_row.create(null,values.map(()=>schema.nodes.table_cell.create({align:'right'})))
  ]));
  for(let round=0;round<2;round++){
    const raw=serializer.serialize(doc);assert.ok(!raw.includes('<table>'));assert.ok(parsePieces(raw).every(piece=>piece.kind==='markdown'&&piece.editable));
    doc=parser.parse(raw);
    doc.firstChild!.firstChild!.forEach((cell,_,index)=>{assert.equal(cell.textBetween(0,cell.content.size,'','\n'),values[index]);assert.equal(cell.attrs.align,'right');});
  }
});

test('replacement targets one occurrence and maps across emphasis without exposing URLs',()=>{
  assert.deepEqual(textMatches('word word word','word',true),[{start:0,end:4},{start:5,end:9},{start:10,end:14}]);
  assert.equal(replaceMatches('word word word','word','X',false,true,{start:5,end:9}).after,'word X word');
  const raw='The **important** note and [docs](https://important.example).';
  const result=replaceMatches(raw,'important note','new *text*',false,true);
  assert.equal(visibleText(result.after),'The new *text* and docs.');
  assert.ok(result.after.includes('(https://important.example)'));
  assert.equal(replaceMatches(raw,'important.example','X',false,true).count,0);
  assert.equal(replaceMatches('$$\nx+y\n$$','x+y','z',true,true).after,'$$\nz\n$$');
  assert.equal(mappedVisibleText('See [label](hidden).').text,'See label.');
});

test('visible replacement preserves Wiki targets, HTML tags and literal code punctuation',()=>{
  assert.equal(replaceMatches('[[same|same]]','same','new',false,true).after,'[[same|new]]');
  assert.equal(replaceMatches('<b>important</b> note','important note','new',false,true).after,'<b>new</b>');
  assert.equal(replaceMatches('Use `word` here.','word','*[]',false,true).after,'Use `*[]` here.');
});

test('portable Markdown expands repeated chapters, omits child metadata and relocates duplicate resource names',async()=>{
  const root='file:///C:/docs/main.md',child='file:///C:/docs/sub/chapter.md';
  const segment=(uri:string,text:string,id:string):Segment=>({id,sourceUri:uri,sourceFile:uri,pieceId:id,includeInstanceId:id,sourceVersion:1,text,editable:true});
  const segments=[segment(root,'---\ntitle: Root\n---','a'),segment(root,'![root](pic.png)','b'),segment(child,'---\ntitle: Child\n---','c'),segment(child,'![child](pic.png)','d'),segment(child,'Repeated unsaved chapter','e'),segment(child,'Repeated unsaved chapter','f')];
  const plan=await portableMarkdown(segments,root,'complete.assets',async(from,path)=>new URL(path,from).href,async uri=>new TextEncoder().encode(uri));
  assert.equal(plan.omittedMetadata,1);assert.equal(plan.resources.length,2);assert.notEqual(plan.resources[0].name,plan.resources[1].name);
  assert.equal(plan.markdown.split('Repeated unsaved chapter').length-1,2);assert.ok(plan.markdown.includes('complete.assets/'));assert.ok(!plan.markdown.includes('title: Child'));
  await assert.rejects(portableMarkdown([{...segments[0],error:'Missing Include'}],root,'assets',async()=>'',async()=>new Uint8Array()),/Include/);
});
