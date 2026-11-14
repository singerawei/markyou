import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visibleText} from '../src/shared/visibleText';
import {parseTSV} from '../src/webview/tableToolbar';

test('visible text finds words inside emphasis and across inline marks', () => {
  assert.equal(visibleText('A **bold** word and ==bold== highlight.'), 'A bold word and bold highlight.');
  assert.equal(visibleText('The **important** note.'), 'The important note.');
});

test('visible text keeps literal underscores and code spans', () => {
  assert.equal(visibleText('Use snake_case_name.'), 'Use snake_case_name.');
  assert.equal(visibleText('Use `*args*` here.'), 'Use *args* here.');
  assert.equal(visibleText('`a_b_c` and _emphasis_'), 'a_b_c and emphasis');
});

test('visible text strips link destinations but keeps the label', () => {
  assert.equal(visibleText('See [docs](https://docs.example.com).'), 'See docs.');
  assert.equal(visibleText('See <https://example.com>.'), 'See https://example.com.');
});

test('TSV parsing keeps rows, columns and the hard-break marker', () => {
  assert.deepEqual(parseTSV('A\tB\nC\t\\nD\n'), [['A','B'],['C','\\nD']]);
  assert.deepEqual(parseTSV(''), []);
});
