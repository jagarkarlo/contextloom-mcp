export interface Passage {
  ord: number;
  heading: string;
  text: string;
}

export interface ChunkOptions {
  maxChars?: number;
  maxPassages?: number;
}

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_MAX_PASSAGES = 40;
const HEADING = /^#{1,4}\s+(.+?)\s*$/;

/** Splits Markdown into heading-aware passages bounded by character length. */
export function chunkMarkdown(
  content: string,
  { maxChars = DEFAULT_MAX_CHARS, maxPassages = DEFAULT_MAX_PASSAGES }: ChunkOptions = {}
): Passage[] {
  const sections: Array<{ heading: string; blocks: string[] }> = [];
  let current = { heading: 'Introduction', blocks: [] as string[] };
  let buffer: string[] = [];

  const flushParagraph = () => {
    const paragraph = buffer.join('\n').trim();
    buffer = [];
    if (paragraph) current.blocks.push(paragraph);
  };

  for (const line of content.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      flushParagraph();
      if (current.blocks.length > 0) sections.push(current);
      current = { heading: match[1]!.trim(), blocks: [] };
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
    } else {
      buffer.push(line);
    }
  }
  flushParagraph();
  if (current.blocks.length > 0) sections.push(current);

  const passages: Passage[] = [];
  const push = (heading: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed || passages.length >= maxPassages) return;
    passages.push({ ord: passages.length, heading, text: trimmed });
  };

  for (const section of sections) {
    let chunk = '';
    for (const block of section.blocks) {
      if (block.length > maxChars) {
        if (chunk) {
          push(section.heading, chunk);
          chunk = '';
        }
        for (let offset = 0; offset < block.length && passages.length < maxPassages; offset += maxChars) {
          push(section.heading, block.slice(offset, offset + maxChars));
        }
        continue;
      }
      const candidate = chunk ? `${chunk}\n\n${block}` : block;
      if (candidate.length <= maxChars) {
        chunk = candidate;
      } else {
        push(section.heading, chunk);
        chunk = block;
      }
    }
    if (chunk) push(section.heading, chunk);
    if (passages.length >= maxPassages) break;
  }

  return passages;
}
