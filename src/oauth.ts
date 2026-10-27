import { boundedRequest, type BoundedOptions } from './http.js';
import { rememberSecret, upstreamErrorHint } from './redact.js';

export interface ClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
}

const EXPIRY_MARGIN_SECONDS = 30;
const MAX_CACHE_SECONDS = 3_600;

/** OAuth 2.0 client-credentials grant with in-memory caching and single-flight refresh. */
export class ClientCredentialsProvider {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly config: ClientCredentialsConfig,
    private readonly options: BoundedOptions = {}
  ) {
    const url = new URL(config.tokenUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('OAuth token URLs must use HTTPS without embedded credentials.');
    }
    rememberSecret(config.clientSecret);
  }

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt) return this.cached.token;
    this.pending ??= this.issue().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Drop the cached token, for example after the API answered 401. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async issue(): Promise<string> {
    const { tokenUrl, clientId, clientSecret, scope, audience } = this.config;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    if (scope) body.set('scope', scope);
    if (audience) body.set('audience', audience);
    const response = await boundedRequest(
      tokenUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body },
      this.options
    );
    let payload: { access_token?: unknown; token_type?: unknown; expires_in?: unknown } = {};
    try {
      payload = JSON.parse(response.text);
    } catch {
      // Reported below without echoing the body.
    }
    if (!response.ok) {
      throw new Error(`Token request failed (HTTP ${response.status})${upstreamErrorHint(payload)}`);
    }
    const token = payload.access_token;
    if (typeof token !== 'string' || !token || /\s/.test(token) || String(payload.token_type).toLowerCase() !== 'bearer') {
      throw new Error('Token endpoint did not return a bearer access token.');
    }
    rememberSecret(token);
    const lifetime = Number(payload.expires_in);
    if (Number.isFinite(lifetime) && lifetime > EXPIRY_MARGIN_SECONDS) {
      const seconds = Math.min(lifetime, MAX_CACHE_SECONDS) - EXPIRY_MARGIN_SECONDS;
      this.cached = { token, expiresAt: Date.now() + seconds * 1_000 };
    }
    return token;
  }
}
