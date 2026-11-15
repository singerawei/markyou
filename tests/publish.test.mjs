import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifiedPreview} from '../scripts/prepare-marketplace-publish.mjs';

const run={conclusion:'success',event:'push',head_repository:{full_name:'singerawei/markyou'},path:'.github/workflows/ci.yml',head_branch:'v1.1.0-preview.2'};
const jobs=['verify (ubuntu-latest)','verify (windows-latest)','release'].map(name=>({name,conclusion:'success'}));
test('preview recovery accepts only a fully verified release run',()=>{
  assert.equal(verifiedPreview(run,jobs,'singerawei/markyou','1.1.0'),'v1.1.0-preview.2');
  assert.throws(()=>verifiedPreview({...run,conclusion:'failure'},jobs,'singerawei/markyou','1.1.0'));
  assert.throws(()=>verifiedPreview(run,jobs.slice(0,2),'singerawei/markyou','1.1.0'));
});
test('preview recovery cannot bypass stable gates or use another repository or version',()=>{
  assert.throws(()=>verifiedPreview({...run,head_branch:'v1.1.0'},jobs,'singerawei/markyou','1.1.0'));
  assert.throws(()=>verifiedPreview(run,jobs,'other/repository','1.1.0'));
  assert.throws(()=>verifiedPreview(run,jobs,'singerawei/markyou','1.2.0'));
  assert.throws(()=>verifiedPreview({...run,path:'.github/workflows/other.yml'},jobs,'singerawei/markyou','1.1.0'));
});
