import { proxiedFetch } from './proxy.js';

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
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export async function fetchGitLab(
  connection: ServiceConnection,
  path: string
): Promise<JsonValue> {
  const response = await proxiedFetch(`${connection.baseUrl}${path}`, {
    headers: {
      'PRIVATE-TOKEN': connection.token,
      Accept: 'application/json'
    }
  });
  const body = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(`GitLab request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

export async function fetchJira(
  connection: ServiceConnection,
  path: string,
  init?: RequestInit
): Promise<JsonValue> {
  const response = await proxiedFetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });
  const body = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(`Jira request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
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
  const response = await proxiedFetch(`${connection.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: 'application/json'
    }
  });
  const body = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(`${service} request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

export async function fetchGitHub(
  connection: GitHubConnection,
  path: string,
  init?: RequestInit
): Promise<JsonValue> {
  const response = await proxiedFetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {})
    }
  });
  const body = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
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

export function textResult(body: JsonValue) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }]
  };
}
