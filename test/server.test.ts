import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');

export async function withServer<T>(
  environment: Record<string, string>,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve(root, 'src/server.ts')],
    cwd: resolve(root, 'test'),
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...environment },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'contextloom-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test('server starts with no credentials and exposes only the status tool', async () => {
  await withServer({}, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['contextloom_status']);
    const status = await client.callTool({ name: 'contextloom_status', arguments: {} });
    const text = (status.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /"jira": false/);
  });
});

test('configured groups register independently and status never echoes tokens', async () => {
  await withServer(
    { JIRA_BASE_URL: 'https://jira.example.com', JIRA_API_TOKEN: 'fake-token-value-123' },
    async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes('jira_get_issue'));
      assert.ok(!names.some((name) => name.startsWith('gitlab_') || name.startsWith('github_')));
      const status = await client.callTool({ name: 'contextloom_status', arguments: {} });
      assert.ok(!JSON.stringify(status).includes('fake-token-value-123'));
    }
  );
});
