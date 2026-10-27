import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedRequest, readLimitedText } from '../src/http.js';

test('boundedRequest refuses redirects and applies a timeout signal', async () => {
  let seen: RequestInit | undefined;
  const response = await boundedRequest('https://api.example.com/items', {}, {
    fetcher: async (_url, init) => {
      seen = init;
      return new Response('{"ok":true}');
    }
  });
  assert.equal(seen?.redirect, 'error');
  assert.ok(seen?.signal instanceof AbortSignal);
  assert.deepEqual(response, { status: 200, ok: true, text: '{"ok":true}' });
});

test('boundedRequest hides raw network errors that may contain credentials', async () => {
  await assert.rejects(
    boundedRequest('https://api.example.com/items', {}, {
      fetcher: async () => {
        throw new Error('https://user:secret@api.example.com failed');
      }
    }),
    (error: Error) => !error.message.includes('secret') && /network, timeout or redirect/.test(error.message)
  );
});

test('boundedRequest aborts slow upstreams', async () => {
  await assert.rejects(
    boundedRequest('https://api.example.com/slow', {}, {
      timeoutMs: 20,
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          // AbortSignal.timeout timers are unref'd; this keeps the test's event loop alive.
          const keepAlive = setTimeout(() => reject(new Error('timeout was not applied')), 5_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(new Error('aborted'));
          });
        })
    }),
    /network, timeout or redirect/
  );
});

test('readLimitedText stops reading oversized bodies', async () => {
  assert.equal(await readLimitedText(new Response('small'), 10), 'small');
  await assert.rejects(readLimitedText(new Response('x'.repeat(50)), 10), /exceeds 10 bytes/);
});
