export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, '&quot;');
}

function renderInlineMarkdown(text: string): string {
  let rendered = escapeTelegramHtml(text);
  const placeholders = new Map<string, string>();
  let index = 0;

  const stash = (value: string): string => {
    const key = `@@TG_${index++}@@`;
    placeholders.set(key, value);
    return key;
  };

  rendered = rendered.replace(/`([^`]+)`/g, (_, code: string) => stash(`<code>${escapeTelegramHtml(code)}</code>`));
  rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => {
    if (/^https?:\/\//i.test(href)) {
      return stash(`<a href="${escapeAttribute(href)}">${escapeTelegramHtml(label)}</a>`);
    }
    return stash(`<code>${escapeTelegramHtml(label)}</code>`);
  });
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  rendered = rendered.replace(/__([^_]+)__/g, '<b>$1</b>');
  rendered = rendered.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  rendered = rendered.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');

  for (const [key, value] of placeholders.entries()) {
    rendered = rendered.replaceAll(key, value);
  }

  return rendered;
}

function renderParagraph(lines: string[]): string {
  return lines.map((line) => renderInlineMarkdown(line)).join('\n');
}

function renderCodeBlock(lines: string[]): string {
  return `<pre>${escapeTelegramHtml(lines.join('\n'))}</pre>`;
}

function renderBlockquote(lines: string[]): string {
  return `<blockquote>${lines.map((line) => renderInlineMarkdown(line)).join('\n')}</blockquote>`;
}

function renderList(lines: string[], ordered: boolean): string {
  return lines
    .map((line, index) => {
      const prefix = ordered ? `${index + 1}. ` : '• ';
      return `${prefix}${renderInlineMarkdown(line)}`;
    })
    .join('\n');
}

export function markdownToTelegramBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && lines[index].startsWith('```')) {
        index += 1;
      }
      blocks.push(renderCodeBlock(codeLines));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(`<b>${renderInlineMarkdown(headingMatch[2])}</b>`);
      index += 1;
      continue;
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].startsWith('> ')) {
        quoteLines.push(lines[index].slice(2));
        index += 1;
      }
      blocks.push(renderBlockquote(quoteLines));
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        listLines.push(lines[index].replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(renderList(listLines, false));
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        listLines.push(lines[index].replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(renderList(listLines, true));
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith('```') &&
      !lines[index].startsWith('> ') &&
      !/^[-*]\s+/.test(lines[index]) &&
      !/^\d+\.\s+/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(renderParagraph(paragraphLines));
  }

  return blocks.filter(Boolean);
}

export function chunkTelegramHtml(blocks: string[], limit = 3500): string[] {
  if (blocks.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (block.length <= limit) {
      current = block;
      continue;
    }

    const plainText = block
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/?(?:b|i|u|s|code|pre|blockquote)>/g, '')
      .replace(/<a [^>]+>/g, '')
      .replace(/<\/a>/g, '');
    const segments = plainText.split('\n');
    let oversized = '';
    for (const segment of segments) {
      const normalized = escapeTelegramHtml(segment);
      const joined = oversized ? `${oversized}\n${normalized}` : normalized;
      if (joined.length <= limit) {
        oversized = joined;
      } else {
        if (oversized) chunks.push(oversized);
        oversized = normalized;
      }
    }
    if (oversized) {
      current = oversized;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export function markdownToTelegramHtml(markdown: string): string {
  return markdownToTelegramBlocks(markdown).join('\n\n');
}

export function plainTextToTelegramHtml(text: string): string {
  return escapeTelegramHtml(text).replace(/\r\n/g, '\n');
}
