import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetedText, textResult } from '../src/client.js';
import { redactText, redactValue, rememberSecret, upstreamErrorHint } from '../src/redact.js';

test('redactValue masks credential keys and common token formats', () => {
  const value = redactValue({
    access_token: 'short',
    nested: { password: 'p', note: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' },
    url: 'https://user:hunter2@example.com/path',
    connection: 'AccountName=demo;AccountKey=c2VjcmV0a2V5;EndpointSuffix=core.windows.net',
    header: 'Bearer abcdefghijklmnopqrstuvwxyz'
  });
  assert.deepEqual(value, {
    access_token: '[REDACTED]',
    nested: { password: '[REDACTED]', note: 'token [REDACTED]' },
    url: 'https://user:[REDACTED]@example.com/path',
    connection: 'AccountName=demo;AccountKey=[REDACTED];EndpointSuffix=core.windows.net',
    header: 'Bearer [REDACTED]'
  });
});

test('configured secrets are removed even when echoed in plain or URL-encoded form', () => {
  rememberSecret('configured-value/with+chars');
  assert.equal(
    redactText('echo configured-value/with+chars and configured-value%2Fwith%2Bchars'),
    'echo [REDACTED] and [REDACTED]'
  );
  assert.equal(textResult({ echo: 'configured-value/with+chars' }).content[0]?.text.includes('configured'), false);
});

test('budgetedText keeps small values intact and fits escaped previews within the budget', () => {
  assert.equal(budgetedText({ ok: true }, 1_000), '{\n  "ok": true\n}');
  for (const value of [{ body: '"\\\n'.repeat(5_000) }, Array.from({ length: 50 }, (_, i) => ({ i, text: 'x'.repeat(200) }))]) {
    const text = budgetedText(value, 1_000);
    assert.ok(text.length <= 1_000, `length ${text.length}`);
    const parsed = JSON.parse(text) as { truncated: boolean; note: string };
    assert.equal(parsed.truncated, true);
    assert.match(parsed.note, /not complete data/);
  }
});

test('upstream error hints are short, redacted and never the full body', () => {
  assert.equal(upstreamErrorHint({ message: 'Unauthorized', trace: 'x'.repeat(5000) }), ': Unauthorized');
  assert.equal(upstreamErrorHint({ errorMessages: ['Issue does not exist'] }), ': ["Issue does not exist"]');
  assert.equal(upstreamErrorHint('x'.repeat(1000)).length, 202);
  assert.equal(upstreamErrorHint(null), '');
});
