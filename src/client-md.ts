// src/client-md.ts - the ONE markdown renderer, shared by Mission Control and the War Room.
// Written as real TypeScript (typechecked, unit-tested) and shipped to the browser via
// Function#toString, so the page runs exactly the code the tests run. No template-literal
// escaping layer = no more "regex looks right but ** renders raw" bugs.
// Rules: pure functions, no imports, no references to module scope except `esc`.

/** HTML-escape including quotes (attribute-safe: links put URLs inside href="..."). */
export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Small, safe markdown: paragraphs, **bold**, `code`, ```fences```, [links](https://...),
 *  #/##/### headings, - and 1. lists, --- rules. Everything is escaped first. */
export function md(source: unknown): string {
  const inline = (text: string): string =>
    text
      .split(/(`[^`]+`)/)
      .map((part, i) =>
        i % 2 === 1
          ? '<code>' + part.slice(1, -1) + '</code>'
          : part
              .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
              .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'),
      )
      .join('');

  const lines = esc(source).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let para: string[] = [];
  let list: 'ul' | 'ol' | '' = '';
  let fence: string[] | null = null;

  const flushPara = (): void => {
    if (para.length) html += '<p>' + para.map(inline).join('<br>') + '</p>';
    para = [];
  };
  const closeList = (): void => {
    if (list) html += '</' + list + '>';
    list = '';
  };
  const openList = (kind: 'ul' | 'ol'): void => {
    flushPara();
    if (list !== kind) {
      closeList();
      html += '<' + kind + '>';
      list = kind;
    }
  };

  for (const line of lines) {
    const t = line.trim();
    if (fence) {
      if (t.startsWith('```')) {
        html += '<pre><code>' + fence.join('\n') + '</code></pre>';
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (t.startsWith('```')) {
      flushPara();
      closeList();
      fence = [];
      continue;
    }
    if (!t) {
      flushPara();
      closeList();
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      html += '<hr>';
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara();
      closeList();
      const tag = heading[1].length === 3 ? 'h4' : 'h3';
      html += '<' + tag + '>' + inline(heading[2]) + '</' + tag + '>';
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    if (bullet) {
      openList('ul');
      html += '<li>' + inline(bullet[1]) + '</li>';
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(t);
    if (numbered) {
      openList('ol');
      html += '<li>' + inline(numbered[1]) + '</li>';
      continue;
    }
    closeList();
    para.push(t);
  }
  if (fence) html += '<pre><code>' + fence.join('\n') + '</code></pre>';
  flushPara();
  closeList();
  return html;
}

/** Browser bundle: drop inside a <script> before any code that calls md()/esc(). */
export const CLIENT_MD_JS = `${esc.toString()}\n${md.toString()}\n`;
