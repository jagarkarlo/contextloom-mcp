import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { redactText } from './redact.js';

export const NOTE_KINDS = ['fact', 'decision', 'runbook', 'incident', 'reference', 'preference'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type Freshness = 'current' | 'stale' | 'expired' | 'unverified';

export interface NoteInput {
  id?: string;
  kind: NoteKind;
  title: string;
  summary: string;
  content: string;
  project?: string;
  tags?: string[];
  sources?: Array<{ label: string; url: string }>;
  verifiedAt?: string;
  expiresAt?: string;
}

export interface Note extends NoteInput {
  id: string;
  tags: string[];
  sources: Array<{ label: string; url: string }>;
  createdAt: string;
  updatedAt: string;
}

const META = /^<!-- contextloom-meta (\{.*\}) -->\n/;
const STALE_AFTER_DAYS = 90;

export function freshnessOf(note: Pick<Note, 'verifiedAt' | 'expiresAt'>, now = new Date()): Freshness {
  if (note.expiresAt && Date.parse(note.expiresAt) <= now.getTime()) return 'expired';
  if (!note.verifiedAt) return 'unverified';
  const ageDays = (now.getTime() - Date.parse(note.verifiedAt)) / 86_400_000;
  return ageDays > STALE_AFTER_DAYS ? 'stale' : 'current';
}

function slug(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
  return `${base}-${createHash('sha256').update(`${title}${Date.now()}${Math.random()}`).digest('hex').slice(0, 8)}`;
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
}

/** Durable, human-editable notes: one Markdown file per note, the files are the source of truth. */
export class NotesStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(kind: string, id: string): string {
    if (!NOTE_KINDS.includes(kind as NoteKind) || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) {
      throw new Error('Invalid note kind or id.');
    }
    const path = resolve(this.root, kind, `${id}.md`);
    if (!path.startsWith(this.root + sep)) throw new Error('Note path escapes the notes directory.');
    return path;
  }

  save(input: NoteInput, now = new Date()): Note {
    const serialized = JSON.stringify(input);
    if (redactText(serialized) !== serialized) {
      throw new Error('Refusing to store credential-like content. Reference where a secret lives instead.');
    }
    for (const date of [input.verifiedAt, input.expiresAt]) {
      if (date !== undefined && Number.isNaN(Date.parse(date))) throw new Error(`Invalid date: ${date}`);
    }
    const existing = input.id ? this.get(input.id) : undefined;
    if (existing && existing.kind !== input.kind) this.remove(existing);
    const stamp = now.toISOString();
    const note: Note = {
      ...input,
      id: input.id ?? slug(input.title),
      tags: [...new Set((input.tags ?? []).map((tag) => tag.toLowerCase()))],
      sources: input.sources ?? [],
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp
    };
    const path = this.path(note.kind, note.id);
    mkdirSync(join(this.root, note.kind), { recursive: true });
    const { content, ...meta } = note;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `<!-- contextloom-meta ${JSON.stringify(meta)} -->\n# ${note.title}\n\n${content.trim()}\n`, {
      mode: 0o600
    });
    renameSync(temporary, path);
    return note;
  }

  private remove(note: Note): void {
    unlinkSync(this.path(note.kind, note.id));
  }

  all(): Note[] {
    if (!existsSync(this.root)) return [];
    const notes: Note[] = [];
    for (const kind of NOTE_KINDS) {
      const directory = join(this.root, kind);
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory).filter((name) => name.endsWith('.md'))) {
        const text = readFileSync(join(directory, file), 'utf8');
        const match = META.exec(text);
        if (!match) continue;
        const meta = JSON.parse(match[1]!) as Omit<Note, 'content'>;
        const body = text.slice(match[0].length).replace(/^# .*\n\n?/, '').trim();
        notes.push({ ...meta, content: body });
      }
    }
    return notes;
  }

  get(id: string): Note | undefined {
    return this.all().find((note) => note.id === id);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.remove(existing);
    return true;
  }

  search(query: string, { project, kind, limit = 10 }: { project?: string; kind?: NoteKind; limit?: number } = {}) {
    const wanted = [...new Set(terms(query))];
    return this.all()
      .filter((note) => (!project || note.project === project) && (!kind || note.kind === kind))
      .map((note) => {
        const fields: Array<[string, number]> = [
          [note.title, 4],
          [note.tags.join(' '), 3],
          [note.summary, 2],
          [note.content, 1]
        ];
        const score = wanted.reduce(
          (total, term) =>
            total + fields.reduce((sum, [text, weight]) => sum + weight * terms(text).filter((t) => t === term).length, 0),
          0
        );
        return { note, score };
      })
      .filter(({ score }) => score > 0 || wanted.length === 0)
      .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
      .slice(0, limit)
      .map(({ note }) => ({
        id: note.id,
        kind: note.kind,
        title: note.title,
        summary: note.summary,
        project: note.project,
        tags: note.tags,
        freshness: freshnessOf(note)
      }));
  }
}
