const REDACTED = '[REDACTED]';
const knownSecrets = new Set<string>();

const SENSITIVE_KEY =
  /^(?:password|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|private[_-]?key|cookie|set-cookie)$/i;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /(?<=\bBearer\s)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /(?<=AccountKey=)[^;\s"']+/gi,
  /(?<=[?&]sig=)[^&\s"']+/gi,
  /(?<=:\/\/[^/\s:@]+:)[^@\s/]+(?=@)/g
];

/** Values that must never appear in output, such as configured API tokens. */
export function rememberSecret(value: string | undefined): void {
  if (value && value.length >= 6) knownSecrets.add(value);
}

export function redactText(text: string): string {
  let clean = text;
  for (const secret of knownSecrets) {
    clean = clean.split(secret).join(REDACTED).split(encodeURIComponent(secret)).join(REDACTED);
  }
  for (const pattern of PATTERNS) clean = clean.replace(pattern, REDACTED);
  return clean;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child)])
    );
  }
  return value;
}

/** A short, redacted hint from an upstream error body; never the whole body. */
export function upstreamErrorHint(body: unknown): string {
  const candidate =
    body && typeof body === 'object' && !Array.isArray(body)
      ? ['message', 'error_description', 'error', 'errorMessages', 'detail']
          .map((key) => (body as Record<string, unknown>)[key])
          .find((value) => value !== undefined)
      : body;
  if (candidate === undefined || candidate === null || candidate === '') return '';
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  const hint = redactText(text).replace(/\s+/g, ' ').trim().slice(0, 200);
  return hint ? `: ${hint}` : '';
}
