import { proxiedFetch } from './proxy.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 2_000_000;

export interface BoundedResponse {
  status: number;
  ok: boolean;
  text: string;
}

export interface BoundedOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

export async function readLimitedText(response: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`Response exceeds ${maxBytes} bytes; narrow the request.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Authenticated requests must never follow redirects (the token would travel to the new
 * origin), never hang forever, and never buffer an unbounded body into the model context.
 */
export async function boundedRequest(
  url: string,
  init: RequestInit = {},
  { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, fetcher = proxiedFetch }: BoundedOptions = {}
): Promise<BoundedResponse> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(`Request to ${new URL(url).origin} failed (network, timeout or redirect).`);
  }
  return { status: response.status, ok: response.ok, text: await readLimitedText(response, maxBytes) };
}
