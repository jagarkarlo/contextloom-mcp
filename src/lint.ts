import { freshnessOf, type NotesStore } from './notes.js';
import { buildMap, RECALL_BUDGETS } from './recall.js';

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  id?: string;
  detail: string;
  fix: string;
}

export interface LintMeasure {
  measure: string;
  value: number;
  target: string;
  met: boolean;
}

const MAX_CONTENT_CHARS = 6_000;
const DUPLICATE_SIMILARITY = 0.75;
const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with', 'via', 'vs']);
const RANK: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };

function titleTokens(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP_WORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Scores durable notes against North Star quality targets and lists actionable fixes. */
export function lintNotes(store: NotesStore, { now = new Date(), limit = 25 }: { now?: Date; limit?: number } = {}) {
  const notes = store.all();
  const findings: LintFinding[] = [];
  let sourced = 0;
  let current = 0;

  for (const note of notes) {
    const freshness = freshnessOf(note, now);
    if (freshness === 'current') current += 1;
    if (note.sources.length > 0) {
      sourced += 1;
    } else {
      findings.push({
        rule: 'no-source',
        severity: 'warn',
        id: note.id,
        detail: note.title,
        fix: 'Add the ticket, PR, page or file URL it was verified against.'
      });
    }
    if (freshness === 'expired' || freshness === 'stale') {
      findings.push({
        rule: freshness,
        severity: 'warn',
        id: note.id,
        detail: `${note.title}${note.expiresAt ? ` (expired ${note.expiresAt})` : ''}`,
        fix: 'Re-verify against the live system and update verifiedAt/expiresAt, or delete if obsolete.'
      });
    }
    if (freshness === 'unverified') {
      findings.push({
        rule: 'unverified',
        severity: 'warn',
        id: note.id,
        detail: note.title,
        fix: 'Verify against the live system and set verifiedAt.'
      });
    }
    if (note.content.length > MAX_CONTENT_CHARS) {
      findings.push({
        rule: 'oversized',
        severity: 'info',
        id: note.id,
        detail: `${note.content.length} characters`,
        fix: `Split by topic below ${MAX_CONTENT_CHARS} characters.`
      });
    }
    if (!note.project) {
      findings.push({
        rule: 'no-project',
        severity: 'info',
        id: note.id,
        detail: note.title,
        fix: 'Set project so scoped recall can filter accurately.'
      });
    }
  }

  const tokenSets = notes.map((note) => titleTokens(note.title));
  let duplicates = 0;
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const similarity = jaccard(tokenSets[i]!, tokenSets[j]!);
      if (similarity < DUPLICATE_SIMILARITY) continue;
      duplicates += 1;
      findings.push({
        rule: 'duplicate',
        severity: 'warn',
        id: notes[i]!.id,
        detail: `${Math.round(similarity * 100)}% title overlap with ${notes[j]!.id}`,
        fix: 'Merge into one note with notes_save(id), then notes_delete the duplicate.'
      });
    }
  }

  const mapChars = buildMap(store, { now }).map.length;
  const total = Math.max(notes.length, 1);
  const measures: LintMeasure[] = [
    { measure: 'sourced', value: Math.round((sourced / total) * 100), target: '100%', met: sourced === notes.length },
    { measure: 'current', value: Math.round((current / total) * 100), target: '>=80%', met: current / total >= 0.8 || notes.length === 0 },
    { measure: 'duplicates', value: duplicates, target: '0', met: duplicates === 0 },
    { measure: 'mapChars', value: mapChars, target: `<=${RECALL_BUDGETS[1]}`, met: mapChars <= RECALL_BUDGETS[1] }
  ];

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.rule.localeCompare(b.rule));
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;

  return {
    score: Math.round((measures.filter((m) => m.met).length / measures.length) * 100),
    entries: notes.length,
    measures,
    counts,
    findings: findings.slice(0, limit),
    omitted: Math.max(findings.length - limit, 0)
  };
}
