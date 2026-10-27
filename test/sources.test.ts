import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { ApiSourceClient, parseApiSources, sourceUrl, type ApiSource } from '../src/sources.js';

const bearer: ApiSource = {
  id: 'inventory',
  description: '',
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'bearer', tokenEnv: 'INVENTORY_TOKEN' },
  allowPaths: ['/items']
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('the shipped example configuration is valid', () => {
  const text = readFileSync(resolve(import.meta.dirname, '../examples/api-sources.example.json'), 'utf8');
  assert.equal(parseApiSources(text).length, 3);
});

test('configuration rejects plain HTTP, duplicate ids and literal secrets', () => {
  const wrap = (sources: unknown[]) => JSON.stringify({ sources });
  assert.throws(() => parseApiSources(wrap([{ id: 'a', baseUrl: 'http://api.example.com' }])), /HTTPS/);
  assert.throws(
    () => parseApiSources(wrap([{ id: 'a', baseUrl: 'https://a.example.com' }, { id: 'a', baseUrl: 'https://b.example.com' }])),
    /Duplicate/
  );
  assert.throws(
    () => parseApiSources(wrap([{ id: 'a', baseUrl: 'https://a.example.com', auth: { type: 'bearer', tokenEnv: 'ghp_literalTokenValue' } }])),
    /environment variable name/
  );
});

test('endpoint paths cannot traverse, change origin or leave allowPaths', () => {
  assert.equal(sourceUrl(bearer, '/items/42', { expand: 'owner' }).href, 'https://api.example.com/v1/items/42?expand=owner');
  for (const path of ['//evil.example.com/x', '/items/../admin', '/items?token=x', '/items#x', 'items']) {
    assert.throws(() => sourceUrl(bearer, path), /absolute endpoint path/);
  }
  assert.throws(() => sourceUrl(bearer, '/itemsevil'), /allowPaths/);
  assert.throws(() => sourceUrl(bearer, '/admin'), /allowPaths/);
});

test('get projects fields, pages locally and sends the bearer credential', async () => {
  let authorization: string | undefined;
  const client = new ApiSourceClient({ INVENTORY_TOKEN: 'inventory-token-1' }, async (_url, init) => {
    authorization = (init?.headers as Record<string, string>).Authorization;
    return json({ data: { items: [{ id: 1, name: 'a', secret: 'x' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }] } });
  });
  const result = await client.get(bearer, { path: '/items', itemsPath: 'data.items', fields: ['id', 'name'], limit: 2 });
  assert.equal(authorization, 'Bearer inventory-token-1');
  assert.deepEqual(result.data, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.totalItems, 3);
});

test('missing credentials and upstream errors fail without leaking secrets', async () => {
  assert.equal(new ApiSourceClient({}).isConfigured(bearer), false);
  await assert.rejects(new ApiSourceClient({}).get(bearer, { path: '/items' }), /INVENTORY_TOKEN/);
  const client = new ApiSourceClient({ INVENTORY_TOKEN: 'inventory-token-2' }, async () =>
    json({ message: 'denied for inventory-token-2' }, 403)
  );
  await assert.rejects(
    client.get(bearer, { path: '/items' }),
    (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes('inventory-token-2')
  );
});

test('OAuth sources refresh the token once after a 401', async () => {
  const oauth: ApiSource = {
    id: 'tracking',
    description: '',
    baseUrl: 'https://tracking.example.com/api',
    auth: { type: 'oauth-client-credentials', tokenUrl: 'https://id.example.com/token', clientIdEnv: 'ID', clientSecretEnv: 'SECRET' },
    allowPaths: []
  };
  const calls: string[] = [];
  let tokenNumber = 0;
  const client = new ApiSourceClient({ ID: 'client', SECRET: 'oauth-secret-1' }, async (url) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith('/token')) {
      tokenNumber++;
      return json({ access_token: `issued-token-${tokenNumber}-value`, token_type: 'Bearer', expires_in: 300 });
    }
    return calls.filter((path) => path === '/api/jobs').length === 1 ? json({}, 401) : json([{ id: 'job-1' }]);
  });
  const result = await client.get(oauth, { path: '/jobs' });
  assert.deepEqual(result.data, [{ id: 'job-1' }]);
  assert.deepEqual(calls, ['/token', '/api/jobs', '/token', '/api/jobs']);
});
