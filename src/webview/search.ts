import {visibleText} from '../shared/visibleText';
export {visibleText};

const MAX_RANGES = 400;

/**
 * Ranges for every occurrence of `query` in the mounted document. Text is
 * joined per block first, so a match that spans inline marks (for example
 * "important note" across `**important**`) still produces one Range.
 */
export function findRanges(root: HTMLElement, query: string, matchCase: boolean): Range[] {
  const term = query.trim();
  if (!term) return [];
  const needle = matchCase ? term : term.toLocaleLowerCase();
  const ranges: Range[] = [];
  for (const block of root.querySelectorAll<HTMLElement>('.segment')) {
    if (ranges.length >= MAX_RANGES) break;
    const nodes: {node: Text; start: number; end: number}[] = [];
    let text = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('script,style,noscript,.sr-only')) return NodeFilter.FILTER_REJECT;
        return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const value = node.textContent ?? '';
      nodes.push({node: node as Text, start: text.length, end: text.length + value.length});
      text += value;
    }
    if (!nodes.length) continue;
    const haystack = matchCase ? text : text.toLocaleLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0 && ranges.length < MAX_RANGES) {
      const start = locate(nodes, index);
      const end = locate(nodes, index + term.length);
      if (start && end) {
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        ranges.push(range);
      }
      index = haystack.indexOf(needle, index + Math.max(1, term.length));
    }
  }
  return ranges;
}

function locate(nodes: {node: Text; start: number; end: number}[], position: number) {
  for (const item of nodes) {
    if (position <= item.end) return {node: item.node, offset: Math.max(0, position - item.start)};
  }
  const last = nodes[nodes.length - 1];
  return last ? {node: last.node, offset: last.node.textContent?.length ?? 0} : undefined;
}

/** Use the CSS Custom Highlight API so the rendered DOM is never mutated. */
export function applyFindHighlights(root: HTMLElement, query: string, currentElement: HTMLElement | null, matchCase: boolean) {
  const highlights = (CSS as unknown as {highlights?: Map<string, unknown>}).highlights;
  if (!highlights || typeof (window as any).Highlight !== 'function') return 0;
  highlights.delete('markyou-find');
  highlights.delete('markyou-current');
  if (!query.trim()) return 0;
  const ranges = findRanges(root, query, matchCase);
  if (!ranges.length) return 0;
  const current = ranges.filter(range => currentElement?.contains(range.commonAncestorContainer));
  const rest = ranges.filter(range => !current.includes(range));
  if (rest.length) highlights.set('markyou-find', new (window as any).Highlight(...rest));
  if (current.length) highlights.set('markyou-current', new (window as any).Highlight(...current));
  return ranges.length;
}

export function clearFindHighlights() {
  const highlights = (CSS as unknown as {highlights?: Map<string, unknown>}).highlights;
  highlights?.delete('markyou-find');
  highlights?.delete('markyou-current');
}
