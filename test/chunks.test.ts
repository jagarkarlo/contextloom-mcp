import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMarkdown } from '../src/chunks.js';

test('chunkMarkdown splits sections by Markdown headings and preserves order', () => {
  const markdown = [
    'Intro paragraph before any heading.',
    '',
    '## Symptoms',
    'Requests time out after 10 seconds when HTTPS_PROXY is ignored.',
    '',
    '## Fix',
    'Attach an undici ProxyAgent for hosts outside NO_PROXY.'
  ].join('\n');

  const passages = chunkMarkdown(markdown);
  assert.deepEqual(
    passages.map((p) => ({ ord: p.ord, heading: p.heading })),
    [
      { ord: 0, heading: 'Introduction' },
      { ord: 1, heading: 'Symptoms' },
      { ord: 2, heading: 'Fix' }
    ]
  );
  assert.match(passages[1]!.text, /HTTPS_PROXY/);
});

test('chunkMarkdown enforces maxChars and maxPassages bounds', () => {
  const longSection = `## Details\n\n${'a'.repeat(500)}\n\n${'b'.repeat(500)}\n\n${'c'.repeat(1200)}`;
  const passages = chunkMarkdown(longSection, { maxChars: 600, maxPassages: 3 });
  assert.equal(passages.length, 3);
  for (const passage of passages) {
    assert.ok(passage.text.length <= 600);
    assert.equal(passage.heading, 'Details');
  }
});
