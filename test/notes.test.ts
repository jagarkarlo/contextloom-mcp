import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freshnessOf, NotesStore } from '../src/notes.js';

function withStore(run: (store: NotesStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'contextloom-notes-'));
  try {
    run(new NotesStore(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('notes are Markdown files that round-trip, update in place and rank by field weight', () => {
  withStore((store, root) => {
    const proxy = store.save({
      kind: 'runbook',
      title: 'Node fetch ignores HTTPS_PROXY',
      summary: 'Attach an undici ProxyAgent explicitly.',
      content: 'Use undici fetch end to end with the dispatcher.',
      tags: ['Proxy', 'node'],
      sources: [{ label: 'undici docs', url: 'https://undici.nodejs.org/' }],
      verifiedAt: new Date().toISOString()
    });
    store.save({ kind: 'fact', title: 'Unrelated', summary: 'mentions proxy once', content: 'other text' });
    const file = join(root, 'runbook', `${proxy.id}.md`);
    assert.match(readFileSync(file, 'utf8'), /^<!-- contextloom-meta .*-->\n# Node fetch ignores HTTPS_PROXY\n/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.get(proxy.id)?.tags, ['proxy', 'node']);

    const results = store.search('proxy');
    assert.equal(results[0]?.id, proxy.id);
    assert.equal(results[0]?.freshness, 'current');

    const updated = store.save({ ...proxy, kind: 'fact', summary: 'Changed kind and summary.' });
    assert.equal(updated.createdAt, proxy.createdAt);
    assert.equal(store.all().filter((note) => note.id === proxy.id).length, 1);
    assert.equal(store.get(proxy.id)?.kind, 'fact');
  });
});

test('notes refuse credentials and invalid identifiers', () => {
  withStore((store) => {
    assert.throws(
      () => store.save({ kind: 'fact', title: 'Token', summary: 's', content: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' }),
      /credential-like/
    );
    assert.throws(() => store.save({ id: '../escape', kind: 'fact', title: 't', summary: 's', content: 'c' }), /Invalid note/);
  });
});

test('freshness distinguishes current, stale, expired and unverified notes', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(freshnessOf({ verifiedAt: '2026-05-20T00:00:00Z' }, now), 'current');
  assert.equal(freshnessOf({ verifiedAt: '2025-12-01T00:00:00Z' }, now), 'stale');
  assert.equal(freshnessOf({ verifiedAt: '2026-05-20T00:00:00Z', expiresAt: '2026-05-30T00:00:00Z' }, now), 'expired');
  assert.equal(freshnessOf({}, now), 'unverified');
});
