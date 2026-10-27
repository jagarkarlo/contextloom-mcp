import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { boundedRequest } from './http.js';
import { ClientCredentialsProvider } from './oauth.js';
import { rememberSecret, upstreamErrorHint } from './redact.js';

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Use an environment variable name, never a literal secret.');

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), tokenEnv: envName }),
  z.object({ type: z.literal('header'), header: z.string().regex(/^[A-Za-z0-9-]+$/), valueEnv: envName }),
  z.object({ type: z.literal('query'), param: z.string().min(1), valueEnv: envName }),
  z.object({
    type: z.literal('oauth-client-credentials'),
    tokenUrl: z.string().url(),
    clientIdEnv: envName,
    clientSecretEnv: envName,
    scope: z.string().optional(),
    audience: z.string().optional()
  })
]);

const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  description: z.string().max(300).default(''),
  baseUrl: z.string().url(),
  auth: authSchema.default({ type: 'none' }),
  allowPaths: z.array(z.string().startsWith('/')).default([])
});

export type ApiSource = z.infer<typeof sourceSchema>;

export interface ApiGetOptions {
  path: string;
  query?: Record<string, string>;
  itemsPath?: string;
  fields?: string[];
  offset?: number;
  limit?: number;
}

export function parseApiSources(json: string): ApiSource[] {
  const parsed = z.object({ sources: z.array(sourceSchema) }).parse(JSON.parse(json));
  const ids = new Set<string>();
  for (const source of parsed.sources) {
    const url = new URL(source.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`Source ${source.id}: baseUrl must be HTTPS without credentials, query or fragment.`);
    }
    if (ids.has(source.id)) throw new Error(`Duplicate API source id: ${source.id}`);
    ids.add(source.id);
  }
  return parsed.sources;
}

export function loadApiSources(environment: NodeJS.ProcessEnv): ApiSource[] {
  const path = environment.CONTEXTLOOM_API_SOURCES?.trim();
  return path ? parseApiSources(readFileSync(path, 'utf8')) : [];
}

export function getByPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** Validates the endpoint path and builds a URL that cannot leave the source's origin. */
export function sourceUrl(source: ApiSource, path: string, query: Record<string, string> = {}): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#?\r\n]/.test(path) || path.split('/').includes('..')) {
    throw new Error('Use an absolute endpoint path without query, fragment or "..". Pass parameters in query.');
  }
  if (source.allowPaths.length > 0 && !source.allowPaths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) {
    throw new Error(`Path is outside this source's allowPaths: ${source.allowPaths.join(', ')}`);
  }
  const base = new URL(source.baseUrl);
  const url = new URL(`${base.href.replace(/\/$/, '')}${path}`);
  if (url.origin !== base.origin) throw new Error('Endpoint origin must match the source baseUrl.');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

export class ApiSourceClient {
  private readonly providers = new Map<string, ClientCredentialsProvider>();

  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  ) {}

  /** True when every credential the source references is present. */
  isConfigured(source: ApiSource): boolean {
    const auth = source.auth;
    switch (auth.type) {
      case 'none':
        return true;
      case 'bearer':
        return Boolean(this.environment[auth.tokenEnv]);
      case 'header':
      case 'query':
        return Boolean(this.environment[auth.valueEnv]);
      case 'oauth-client-credentials':
        return Boolean(this.environment[auth.clientIdEnv] && this.environment[auth.clientSecretEnv]);
    }
  }

  private secret(name: string): string {
    const value = this.environment[name];
    if (!value) throw new Error(`Missing credential environment variable ${name}.`);
    rememberSecret(value);
    return value;
  }

  private provider(source: ApiSource & { auth: { type: 'oauth-client-credentials' } }): ClientCredentialsProvider {
    let provider = this.providers.get(source.id);
    if (!provider) {
      provider = new ClientCredentialsProvider(
        {
          tokenUrl: source.auth.tokenUrl,
          clientId: this.secret(source.auth.clientIdEnv),
          clientSecret: this.secret(source.auth.clientSecretEnv),
          scope: source.auth.scope,
          audience: source.auth.audience
        },
        { fetcher: this.fetcher }
      );
      this.providers.set(source.id, provider);
    }
    return provider;
  }

  private async send(source: ApiSource, url: URL): Promise<{ status: number; ok: boolean; text: string }> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const auth = source.auth;
    if (auth.type === 'bearer') headers.Authorization = `Bearer ${this.secret(auth.tokenEnv)}`;
    if (auth.type === 'header') headers[auth.header] = this.secret(auth.valueEnv);
    if (auth.type === 'query') url.searchParams.set(auth.param, this.secret(auth.valueEnv));
    if (auth.type === 'oauth-client-credentials') {
      headers.Authorization = `Bearer ${await this.provider(source as never).token()}`;
    }
    return boundedRequest(url.toString(), { headers }, { fetcher: this.fetcher });
  }

  async get(source: ApiSource, options: ApiGetOptions) {
    const { itemsPath = '', fields = [], offset = 0, limit = 20 } = options;
    const url = sourceUrl(source, options.path, options.query);
    let response = await this.send(source, new URL(url));
    if (response.status === 401 && source.auth.type === 'oauth-client-credentials') {
      this.provider(source as never).invalidate();
      response = await this.send(source, new URL(url));
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      payload = response.text;
    }
    if (!response.ok) {
      throw new Error(`API source ${source.id} returned HTTP ${response.status}${upstreamErrorHint(payload)}`);
    }

    const selected = getByPath(payload, itemsPath);
    if (selected === undefined) throw new Error(`itemsPath "${itemsPath}" does not exist in the response.`);
    const project = (item: unknown) =>
      fields.length ? Object.fromEntries(fields.map((field) => [field, getByPath(item, field)])) : item;
    if (!Array.isArray(selected)) return { data: project(selected) };
    const items = selected.slice(offset, offset + limit).map(project);
    return {
      data: items,
      totalItems: selected.length,
      nextOffset: offset + items.length < selected.length ? offset + items.length : null,
      note: 'Pagination applies to this response; pass upstream page parameters in query for more.'
    };
  }
}
