import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { lintNotes } from '../src/lint.js';
import { NotesStore } from '../src/notes.js';

function withStore(run: (store: NotesStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'contextloom-lint-'));
  try {
    run(new NotesStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('lintNotes scores a clean, sourced and current store at 100', () => {
  withStore((store) => {
    store.save({
      kind: 'decision',
      title: 'Use undici ProxyAgent for hosts outside NO_PROXY',
      summary: 'Node fetch ignores HTTPS_PROXY.',
      content: 'Attach ProxyAgent explicitly.',
      project: 'contextloom',
      sources: [{ label: 'undici', url: 'https://undici.nodejs.org/' }],
      verifiedAt: '2026-10-25T00:00:00Z'
    });
    const report = lintNotes(store, { now: new Date('2026-10-27T00:00:00Z') });
    assert.equal(report.score, 100);
    assert.equal(report.findings.length, 0);
  });
});

test('lintNotes flags missing sources, expired notes and duplicate titles', () => {
  withStore((store) => {
    store.save({
      id: 'dup-a',
      kind: 'fact',
      title: 'PostgreSQL backup restore rehearsal runbook',
      summary: 's',
      content: 'c',
      verifiedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-02-01T00:00:00Z'
    });
    store.save({
      id: 'dup-b',
      kind: 'fact',
      title: 'PostgreSQL backup and restore rehearsal runbook',
      summary: 's',
      content: 'c'
    });
    const report = lintNotes(store, { now: new Date('2026-10-27T00:00:00Z') });
    assert.ok(report.score < 100);
    assert.equal(report.counts['no-source'], 2);
    assert.equal(report.counts.expired, 1);
    assert.equal(report.counts.unverified, 1);
    assert.equal(report.counts.duplicate, 1);
  });
});
