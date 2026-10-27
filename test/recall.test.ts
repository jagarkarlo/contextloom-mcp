import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NotesStore } from '../src/notes.js';
import { buildCatalog, buildMap, buildPassages, buildSource } from '../src/recall.js';

function withSeededStore(run: (store: NotesStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'contextloom-recall-'));
  try {
    const store = new NotesStore(root);
    store.save({
      id: 'gitops-rollback',
      kind: 'runbook',
      title: 'GitOps rollout and rollback',
      summary: 'Declarative cluster state via Git.',
      content: '## Why\nAuditable deployments.\n\n## Rollback\nRevert the commit and let the controller reconcile.',
      project: 'platform',
      tags: ['gitops'],
      sources: [{ label: 'Runbook', url: 'https://example.com/runbook' }],
      verifiedAt: '2026-10-20T00:00:00Z'
    });
    run(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('L1 map summarizes holdings, freshness and projects within budget', () => {
  withSeededStore((store) => {
    const { level, map } = buildMap(store, { now: new Date('2026-10-27T00:00:00Z') });
    assert.equal(level, 1);
    assert.match(map, /Total 1: runbook 1 \(current 1, stale 0, expired 0, unverified 0\)/);
    assert.match(map, /Top projects: platform 1/);
  });
});

test('L2 catalog merges passage hits and L3 returns the matching section', () => {
  withSeededStore((store) => {
    const catalog = buildCatalog(store, 'reconcile', { now: new Date('2026-10-27T00:00:00Z') });
    assert.equal((catalog.lines as string[]).length, 1);
    assert.match((catalog.lines as string[])[0]!, /^gitops-rollback \| runbook \|/);

    const passages = buildPassages(store, 'reconcile', { now: new Date('2026-10-27T00:00:00Z') });
    assert.deepEqual(passages.passages, [
      {
        id: 'gitops-rollback',
        title: 'GitOps rollout and rollback',
        section: 1,
        heading: 'Rollback',
        freshness: 'current',
        text: 'Revert the commit and let the controller reconcile.'
      }
    ]);
  });
});

test('L4 source supports section lookup and offset pagination', () => {
  withSeededStore((store) => {
    const note = store.get('gitops-rollback')!;
    const section = buildSource(note, { section: 1 });
    assert.equal(section.heading, 'Rollback');
    assert.equal(section.content, 'Revert the commit and let the controller reconcile.');

    const paged = buildSource(note, { offset: 0, maxChars: 20 });
    assert.equal(paged.content.length, 20);
    assert.equal(paged.nextOffset, 20);
  });
});
