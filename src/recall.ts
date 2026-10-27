import { chunkMarkdown } from './chunks.js';
import { freshnessOf, type Freshness, type Note, type NoteKind, type NotesStore } from './notes.js';

export type RecallLevel = 1 | 2 | 3 | 4;

export const RECALL_BUDGETS: Record<RecallLevel, number> = {
  1: 1_800,
  2: 3_000,
  3: 5_000,
  4: 12_000
};

export interface PassageMatch {
  note: Note;
  ord: number;
  heading: string;
  text: string;
  score: number;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? [];
}

/** Searches heading-chunked passages across notes, returning at most perNote passages per note. */
export function searchPassages(
  store: NotesStore,
  query: string,
  { project, kind, limit = 8, perNote = 2 }: { project?: string; kind?: NoteKind; limit?: number; perNote?: number } = {}
): PassageMatch[] {
  const wanted = [...new Set(terms(query))];
  if (wanted.length === 0) return [];
  const matches: PassageMatch[] = [];

  for (const note of store.all()) {
    if ((project && note.project !== project) || (kind && note.kind !== kind)) continue;
    const perNoteHits: PassageMatch[] = [];
    for (const passage of chunkMarkdown(note.content)) {
      const headingTerms = terms(passage.heading);
      const bodyTerms = terms(passage.text);
      const score = wanted.reduce(
        (sum, term) =>
          sum +
          headingTerms.filter((t) => t === term).length * 3 +
          bodyTerms.filter((t) => t === term).length,
        0
      );
      if (score > 0) {
        perNoteHits.push({ note, ord: passage.ord, heading: passage.heading, text: passage.text, score });
      }
    }
    perNoteHits.sort((a, b) => b.score - a.score || a.ord - b.ord);
    matches.push(...perNoteHits.slice(0, perNote));
  }

  return matches
    .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt) || a.ord - b.ord)
    .slice(0, limit);
}

/** L1: compact orientation map of holdings, freshness and top projects. */
export function buildMap(store: NotesStore, { maxChars = RECALL_BUDGETS[1], now = new Date() } = {}) {
  const notes = store.all();
  const kinds = new Map<string, number>();
  const projects = new Map<string, number>();
  const freshness: Record<Freshness, number> = { current: 0, stale: 0, expired: 0, unverified: 0 };

  for (const note of notes) {
    kinds.set(note.kind, (kinds.get(note.kind) ?? 0) + 1);
    if (note.project) projects.set(note.project, (projects.get(note.project) ?? 0) + 1);
    freshness[freshnessOf(note, now)] += 1;
  }

  const kindSummary = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, count]) => `${k} ${count}`)
    .join(', ');
  const topProjects = [...projects.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');

  const lines = [
    '# Notes map (L1)',
    `Total ${notes.length}${kindSummary ? `: ${kindSummary}` : ''} (current ${freshness.current}, stale ${freshness.stale}, expired ${freshness.expired}, unverified ${freshness.unverified})`,
    topProjects ? `Top projects: ${topProjects}` : '',
    'Recall: L2 notes_recall(level 2, query) one line per match -> L3 level 3 matching passages -> L4 level 4 + id full source.'
  ].filter(Boolean);

  return { level: 1 as const, map: clip(lines.join('\n'), maxChars) };
}

function pack<T>(items: T[], maxChars: number, base: Record<string, unknown>, key: string) {
  const result: Record<string, unknown> = { ...base, [key]: [] as T[] };
  const kept = result[key] as T[];
  for (const item of items) {
    kept.push(item);
    if (JSON.stringify(result).length > maxChars) {
      kept.pop();
      break;
    }
  }
  return { result, omitted: items.length - kept.length };
}

/** L2: interleaves whole-note matches with passage-level matches and returns one line per candidate. */
export function buildCatalog(
  store: NotesStore,
  query: string,
  { project, kind, limit = 10, maxChars = RECALL_BUDGETS[2], now = new Date() }: {
    project?: string;
    kind?: NoteKind;
    limit?: number;
    maxChars?: number;
    now?: Date;
  } = {}
) {
  const byNote = store
    .search(query, { project, kind, limit })
    .map((hit) => store.get(hit.id))
    .filter((n): n is Note => Boolean(n));
  const byPassage = searchPassages(store, query, { project, kind, limit, perNote: 1 }).map((hit) => hit.note);
  const merged = new Map<string, Note>();
  for (let i = 0; i < Math.max(byNote.length, byPassage.length); i++) {
    for (const candidate of [byNote[i], byPassage[i]]) {
      if (candidate && !merged.has(candidate.id)) merged.set(candidate.id, candidate);
    }
  }
  const lines = [...merged.values()].slice(0, limit).map((note) =>
    [
      note.id,
      note.kind,
      clip(note.title, 90),
      note.project ?? '-',
      freshnessOf(note, now),
      clip(note.summary, 120)
    ].join(' | ')
  );
  const { result, omitted } = pack(
    lines,
    maxChars - 200,
    { level: 2, query, format: 'id | kind | title | project | freshness | summary' },
    'lines'
  );
  return {
    ...result,
    omitted,
    next:
      lines.length === 0
        ? 'No matching note. Check the live system or broaden the query.'
        : 'Call level 3 with the same query for matching passages, or level 4 with id for the full note.'
  };
}

/** L3: returns matching heading-chunked passages within the character budget. */
export function buildPassages(
  store: NotesStore,
  query: string,
  { project, kind, limit = 8, maxChars = RECALL_BUDGETS[3], now = new Date() }: {
    project?: string;
    kind?: NoteKind;
    limit?: number;
    maxChars?: number;
    now?: Date;
  } = {}
) {
  const hits = searchPassages(store, query, { project, kind, limit, perNote: 2 });
  const passages = hits.map((hit) => ({
    id: hit.note.id,
    title: clip(hit.note.title, 90),
    section: hit.ord,
    heading: clip(hit.heading, 90),
    freshness: freshnessOf(hit.note, now),
    text: clip(hit.text, 900)
  }));
  const { result, omitted } = pack(passages, maxChars - 200, { level: 3, query }, 'passages');
  return {
    ...result,
    omitted,
    next:
      passages.length === 0
        ? 'No passage matched. Try level 2 with fewer terms.'
        : 'Call level 4 with id (and optional section) for the full source.'
  };
}

/** L4: returns one note in full or one section, paged by offset. */
export function buildSource(
  note: Note,
  { section, offset = 0, maxChars = RECALL_BUDGETS[4], now = new Date() }: {
    section?: number;
    offset?: number;
    maxChars?: number;
    now?: Date;
  } = {}
) {
  const passages = section === undefined ? [] : chunkMarkdown(note.content);
  const body = section === undefined ? note.content : passages[section]?.text ?? '';
  const slice = body.slice(offset, offset + maxChars);
  const nextOffset = offset + slice.length < body.length ? offset + slice.length : null;
  return {
    level: 4 as const,
    id: note.id,
    kind: note.kind,
    title: note.title,
    summary: note.summary,
    project: note.project ?? null,
    sources: note.sources,
    freshness: freshnessOf(note, now),
    section: section ?? null,
    heading: section === undefined ? null : passages[section]?.heading ?? null,
    totalChars: body.length,
    offset,
    nextOffset,
    content: slice,
    next:
      nextOffset === null
        ? 'Complete. Verify volatile state against the live service before acting.'
        : `Call level 4 again with offset ${nextOffset} for the remaining content.`
  };
}
