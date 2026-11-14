/**
 * Approximate the text a reader sees. Shared by Find and by the host-side
 * replacement guard so both decide what counts as visible text.
 */
export function visibleText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');
  text = text.replace(/^(?:\uFEFF)?(---|\+\+\+)[ \t]*\n[\s\S]*?\n\1[ \t]*(?:\n|$)/, '');
  text = text.replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, '$1');
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  // Protect code spans: their contents are literal, so `*args*` and
  // snake_case_name must not be treated as emphasis markers.
  const inlineCode: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, content: string) => {
    inlineCode.push(content);
    return `\uE000${inlineCode.length - 1}\uE001`;
  });
  text = text.replace(/!\[\[([^\]]*)\]\]/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label: string | undefined) => label || target);
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

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

