import assert from 'node:assert/strict';
import test from 'node:test';
import {
  githubContentPath,
  githubFileRequest,
  githubRepositoryPath,
  jiraCommentRequest,
  jiraWorklogRequestWithStart,
  jiraWorklogRequest,
  optionalConnection,
  optionalGitHubConnection,
  parseJsonResponse,
  requiredEnvironment,
  trimTrailingSlash
} from '../src/client.js';
import { loadGitLabInstances, selectGitLabInstance } from '../src/config.js';

test('loadGitLabInstances falls back to a single GITLAB_BASE_URL/GITLAB_TOKEN pair', () => {
  const instances = loadGitLabInstances({
    GITLAB_BASE_URL: 'https://gitlab.example.com/',
    GITLAB_TOKEN: 'token'
  } as NodeJS.ProcessEnv);
  assert.deepEqual(instances, [{ name: 'default', baseUrl: 'https://gitlab.example.com', token: 'token' }]);
});

test('loadGitLabInstances reads GITLAB_INSTANCES for multiple hosts', () => {
  const instances = loadGitLabInstances({
    GITLAB_INSTANCES: JSON.stringify([
      { name: 'work', baseUrl: 'https://gitlab.work.example.com', token: 'a' },
      { name: 'personal', baseUrl: 'https://gitlab.com', token: 'b' }
    ])
  } as NodeJS.ProcessEnv);
  assert.equal(instances.length, 2);
  assert.equal(selectGitLabInstance(instances, 'personal').baseUrl, 'https://gitlab.com');
  assert.equal(selectGitLabInstance(instances, undefined).name, 'work');
  assert.throws(() => selectGitLabInstance(instances, 'missing'), /Unknown GitLab instance/);
});

test('loadGitLabInstances throws when nothing is configured', () => {
  assert.throws(() => loadGitLabInstances({} as NodeJS.ProcessEnv), /Missing GitLab configuration/);
});

test('trimTrailingSlash removes one trailing slash', () => {
  assert.equal(trimTrailingSlash('https://gitlab.example.com/'), 'https://gitlab.example.com');
  assert.equal(trimTrailingSlash('https://gitlab.example.com'), 'https://gitlab.example.com');
});

test('requiredEnvironment returns a configured value and rejects missing values', () => {
  assert.equal(requiredEnvironment({ API_URL: 'https://example.com' }, 'API_URL'), 'https://example.com');
  assert.throws(() => requiredEnvironment({}, 'API_URL'), /Missing required environment variable: API_URL/);
});

test('optionalConnection requires a complete configuration pair', () => {
  assert.equal(optionalConnection({}, 'SERVICE_URL', 'SERVICE_TOKEN'), undefined);
  assert.deepEqual(optionalConnection({ SERVICE_URL: 'https://example.com/', SERVICE_TOKEN: 'token' }, 'SERVICE_URL', 'SERVICE_TOKEN'), {
    baseUrl: 'https://example.com',
    token: 'token'
  });
  assert.throws(
    () => optionalConnection({ SERVICE_URL: 'https://example.com' }, 'SERVICE_URL', 'SERVICE_TOKEN'),
    /Set both SERVICE_URL and SERVICE_TOKEN/
  );
});

test('optional GitHub configuration uses the public API by default', () => {
  assert.equal(optionalGitHubConnection({}), undefined);
  assert.deepEqual(optionalGitHubConnection({ GITHUB_TOKEN: 'token' }), {
    baseUrl: 'https://api.github.com',
    token: 'token'
  });
  assert.deepEqual(
    optionalGitHubConnection({ GITHUB_API_BASE_URL: 'https://github.example.com/api/v3/', GITHUB_TOKEN: 'token' }),
    { baseUrl: 'https://github.example.com/api/v3', token: 'token' }
  );
});

test('Jira write requests use the expected JSON bodies', () => {
  assert.deepEqual(jiraCommentRequest('Investigation completed.'), {
    method: 'POST',
    body: '{"body":"Investigation completed."}'
  });
  assert.deepEqual(jiraWorklogRequest('1h 30m', 'Reviewed the change.'), {
    method: 'POST',
    body: '{"timeSpent":"1h 30m","comment":"Reviewed the change."}'
  });
  assert.deepEqual(jiraWorklogRequest('30m'), {
    method: 'POST',
    body: '{"timeSpent":"30m"}'
  });
  assert.deepEqual(jiraWorklogRequestWithStart('1h', undefined, '2026-08-12T08:00:00+02:00'), {
    method: 'POST',
    body: '{"timeSpent":"1h","started":"2026-08-12T08:00:00+02:00"}'
  });
});

test('GitHub file writes encode UTF-8 content and retain update controls', () => {
  assert.deepEqual(githubFileRequest('Hello, world!', 'docs: add example', 'main', 'current-sha'), {
    method: 'PUT',
    body: '{"message":"docs: add example","content":"SGVsbG8sIHdvcmxkIQ==","branch":"main","sha":"current-sha"}'
  });
});

test('GitHub repository paths keep the owner/name slash literal', () => {
  assert.equal(githubRepositoryPath('octo-org/hello world'), '/repos/octo-org/hello%20world');
  assert.equal(
    githubContentPath('octo-org/app', 'docs/read me.md'),
    '/repos/octo-org/app/contents/docs/read%20me.md'
  );
  assert.throws(() => githubRepositoryPath('missing-name'), /owner\/repository/);
  assert.throws(() => githubRepositoryPath('a/b/c'), /owner\/repository/);
});

test('parseJsonResponse parses JSON and retains plain text', async () => {
  assert.deepEqual(await parseJsonResponse(new Response('{"ready":true}')), { ready: true });
  assert.equal(await parseJsonResponse(new Response('service unavailable')), 'service unavailable');
});
