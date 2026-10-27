import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('tools carry read-only or write annotations and writes require confirm: true', async () => {
  await withServer(
    { JIRA_BASE_URL: 'https://jira.invalid', JIRA_API_TOKEN: 'fake-token-value-123' },
    async (client) => {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      assert.equal(tools.get('jira_get_issue')?.annotations?.readOnlyHint, true);
      assert.equal(tools.get('jira_add_comment')?.annotations?.readOnlyHint, false);
      const result = await client.callTool({
        name: 'jira_add_comment',
        arguments: { issueKey: 'DEMO-1', comment: 'hello' }
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /confirm/);
    }
  );
});

test('notes tools support save, 4-level recall, lint and confirmed delete over stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextloom-stdio-notes-'));
  try {
    await withServer({ CONTEXTLOOM_NOTES_DIR: dir }, async (client) => {
      const saved = await client.callTool({
        name: 'notes_save',
        arguments: {
          id: 'proxy-note',
          kind: 'runbook',
          title: 'Use undici ProxyAgent behind HTTPS_PROXY',
          summary: 'Node fetch ignores proxy env vars.',
          content: '## Cause\nGlobal fetch skips HTTPS_PROXY.\n\n## Fix\nAttach ProxyAgent for non-NO_PROXY hosts.',
          project: 'contextloom',
          sources: [{ label: 'undici', url: 'https://undici.nodejs.org/' }],
          verifiedAt: '2026-10-27T00:00:00Z'
        }
      });
      assert.ok(!saved.isError);

      const l3 = await client.callTool({
        name: 'notes_recall',
        arguments: { level: 3, query: 'ProxyAgent' }
      });
      const l3Text = (l3.content as Array<{ text: string }>)[0]!.text;
      assert.match(l3Text, /"heading": "Fix"/);

      const lint = await client.callTool({ name: 'notes_lint', arguments: {} });
      const lintText = (lint.content as Array<{ text: string }>)[0]!.text;
      assert.match(lintText, /"score": 100/);

      const del = await client.callTool({
        name: 'notes_delete',
        arguments: { id: 'proxy-note', confirm: true }
      });
      const delText = (del.content as Array<{ text: string }>)[0]!.text;
      assert.match(delText, /"deleted": true/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
