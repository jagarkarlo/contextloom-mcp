import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientCredentialsProvider } from '../src/oauth.js';
import { redactText } from '../src/redact.js';

const config = {
  tokenUrl: 'https://id.example.com/token',
  clientId: 'service-client',
  clientSecret: 'client-secret-value'
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('issues one token for concurrent callers and reuses it until near expiry', async () => {
  let calls = 0;
  let form: URLSearchParams | undefined;
  const provider = new ClientCredentialsProvider(
    { ...config, scope: 'read' },
    {
      fetcher: async (_url, init) => {
        calls++;
        form = init?.body as URLSearchParams;
        return json({ access_token: 'issued-token-value', token_type: 'Bearer', expires_in: 300 });
      }
    }
  );
  const tokens = await Promise.all([provider.token(), provider.token(), provider.token()]);
  assert.deepEqual(tokens, Array(3).fill('issued-token-value'));
  await provider.token();
  assert.equal(calls, 1);
  assert.equal(form?.get('grant_type'), 'client_credentials');
  assert.equal(form?.get('scope'), 'read');
  provider.invalidate();
  await provider.token();
  assert.equal(calls, 2);
});

test('issued tokens and the client secret are redacted from later output', async () => {
  const provider = new ClientCredentialsProvider(config, {
    fetcher: async () => json({ access_token: 'another-issued-token', token_type: 'bearer', expires_in: 10 })
  });
  await provider.token();
  assert.equal(redactText('another-issued-token client-secret-value'), '[REDACTED] [REDACTED]');
});

test('rejects insecure token URLs, failed grants and non-bearer responses', async () => {
  assert.throws(() => new ClientCredentialsProvider({ ...config, tokenUrl: 'http://id.example.com/token' }), /HTTPS/);
  const denied = new ClientCredentialsProvider(config, {
    fetcher: async () => json({ error: 'invalid_client', error_description: 'bad client-secret-value' }, 401)
  });
  await assert.rejects(denied.token(), (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes('client-secret-value'));
  const wrongType = new ClientCredentialsProvider(config, {
    fetcher: async () => json({ access_token: 'x', token_type: 'mac' })
  });
  await assert.rejects(wrongType.token(), /bearer access token/);
});
