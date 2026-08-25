import { fetch as undiciFetch, ProxyAgent } from 'undici';

/** Matches common NO_PROXY conventions: exact host, leading dot, or wildcard prefix. */
function matchesNoProxy(host: string, noProxy: string): boolean {
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      const pattern = entry.replace(/^\*/, '').replace(/^\./, '');
      return host === pattern || host.endsWith(`.${pattern}`);
    });
}

let cachedAgent: ProxyAgent | undefined;
let cachedAgentUrl: string | undefined;

function dispatcherFor(url: string): ProxyAgent | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim();
  if (!proxyUrl) return undefined;

  const host = new URL(url).hostname.toLowerCase();
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (matchesNoProxy(host, noProxy)) return undefined;

  if (!cachedAgent || cachedAgentUrl !== proxyUrl) {
    cachedAgent = new ProxyAgent(proxyUrl);
    cachedAgentUrl = proxyUrl;
  }
  return cachedAgent;
}

/**
 * Node's global fetch does not honor HTTP_PROXY/HTTPS_PROXY the way curl does, so a host
 * behind a corporate proxy times out silently unless a dispatcher is attached explicitly.
 * This applies one only when the target host is not covered by NO_PROXY, and uses undici's
 * own fetch throughout since mixing its ProxyAgent with the global fetch fails at runtime.
 */
export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const dispatcher = dispatcherFor(url);
  return undiciFetch(url, { ...init, dispatcher } as any) as unknown as Promise<Response>;
}
