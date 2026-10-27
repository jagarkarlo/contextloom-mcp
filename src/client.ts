import { boundedRequest } from './http.js';
import { redactValue, upstreamErrorHint } from './redact.js';

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface ServiceConnection {
  baseUrl: string;
  token: string;
}

export interface GitHubConnection {
  baseUrl: string;
  token: string;
}

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function optionalConnection(
  environment: NodeJS.ProcessEnv,
  baseUrlName: string,
  tokenName: string
): ServiceConnection | undefined {
  const baseUrl = environment[baseUrlName];
  const token = environment[tokenName];

  if (Boolean(baseUrl) !== Boolean(token)) {
    throw new Error(`Set both ${baseUrlName} and ${tokenName} to enable this integration.`);
  }

  return baseUrl && token ? { baseUrl: trimTrailingSlash(baseUrl), token } : undefined;
}

export function optionalGitHubConnection(
  environment: NodeJS.ProcessEnv
): GitHubConnection | undefined {
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    return undefined;
  }

  return {
    baseUrl: trimTrailingSlash(environment.GITHUB_API_BASE_URL ?? 'https://api.github.com'),
    token
  };
}

export async function parseJsonResponse(response: Response): Promise<JsonValue> {
  return parseJsonText(await response.text());
}

export function parseJsonText(text: string): JsonValue {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

async function requestJson(service: string, url: string, init: RequestInit): Promise<JsonValue> {
  const response = await boundedRequest(url, init);
  const body = parseJsonText(response.text);

  if (!response.ok) {
    throw new Error(`${service} request failed (HTTP ${response.status})${upstreamErrorHint(body)}`);
  }

  return body;
}

export async function fetchGitLab(
  connection: ServiceConnection,
  path: string
): Promise<JsonValue> {
  return requestJson('GitLab', `${connection.baseUrl}${path}`, {
    headers: {
      'PRIVATE-TOKEN': connection.token,
      Accept: 'application/json'
    }
  });
}

export async function fetchJira(
  connection: ServiceConnection,
  path: string,
  init?: RequestInit
): Promise<JsonValue> {
  return requestJson('Jira', `${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
}

export function jiraCommentRequest(comment: string): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({ body: comment })
  };
}

export function jiraWorklogRequest(timeSpent: string, comment?: string): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({
      timeSpent,
      ...(comment ? { comment } : {})
    })
  };
}

export function jiraWorklogRequestWithStart(
  timeSpent: string,
  comment?: string,
  started?: string
): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify({
      timeSpent,
      ...(comment ? { comment } : {}),
      ...(started ? { started } : {})
    })
  };
}

export async function fetchBearerApi(
  service: string,
  connection: ServiceConnection,
  path: string
): Promise<JsonValue> {
  return requestJson(service, `${connection.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: 'application/json'
    }
  });
}

export async function fetchGitHub(
  connection: GitHubConnection,
  path: string,
  init?: RequestInit
): Promise<JsonValue> {
  return requestJson('GitHub', `${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {})
    }
  });
}

/** Encodes each segment separately: encodeURIComponent('owner/repo') would escape the slash. */
export function githubRepositoryPath(repository: string): string {
  const [owner, name, ...rest] = repository.split('/');
  if (!owner || !name || rest.length > 0) {
    throw new Error('Use owner/repository.');
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function githubContentPath(repository: string, filePath: string): string {
  return `${githubRepositoryPath(repository)}/contents/${filePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export function githubFileRequest(
  content: string,
  message: string,
  branch?: string,
  sha?: string
): RequestInit {
  return {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(branch ? { branch } : {}),
      ...(sha ? { sha } : {})
    })
  };
}

export const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

function outputBudget(): number {
  const configured = Number(process.env.CONTEXTLOOM_MAX_OUTPUT_CHARS);
  return Number.isInteger(configured) && configured >= 1_000 ? configured : DEFAULT_MAX_OUTPUT_CHARS;
}

/** Serializes within maxChars; oversized values become an explicit, never silent, preview. */
export function budgetedText(value: unknown, maxChars = outputBudget()): string {
  const full = JSON.stringify(redactValue(value), null, 2) ?? 'null';
  if (full.length <= maxChars) return full;

  const note = `Truncated: the full result is ${full.length} characters. Narrow the query, lower limit, or paginate; this preview is not complete data.`;
  const wrap = (length: number) => JSON.stringify({ truncated: true, note, preview: full.slice(0, length) }, null, 2);
  let lower = 0;
  let upper = full.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (wrap(middle).length <= maxChars) lower = middle;
    else upper = middle - 1;
  }
  return wrap(lower);
}

export function textResult(body: unknown, maxChars?: number) {
  return {
    content: [{ type: 'text' as const, text: budgetedText(body, maxChars) }]
  };
}
