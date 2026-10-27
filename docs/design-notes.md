# Design notes and lessons learned

Why each guard in this server exists. Every item here came from a real failure
while building and running MCP servers against GitLab, Jira, Confluence,
Grafana, ML tracking services and cloud storage. Use it as a checklist when you
build your own.

## Networking

| Lesson | What happens | Guard |
| --- | --- | --- |
| Node's `fetch` ignores `HTTPS_PROXY` | External hosts hang about 10 s, then `TypeError: fetch failed` with no hint about the proxy. curl works, which makes it confusing. | `proxy.ts` attaches an undici `ProxyAgent` only for hosts outside `NO_PROXY`. |
| Mixing fetch implementations | Passing a `ProxyAgent` from the `undici` package to the global fetch fails with `invalid onRequestStart method`. | Use undici's own `fetch` end to end. |
| `encodeURIComponent('owner/repo')` | Escapes the slash, so `/repos/owner%2Frepo` returns 404. | Encode each path segment separately (`githubRepositoryPath`). |
| Redirects carry credentials | A 302 to another origin forwards the `Authorization` header. | `redirect: 'error'` on every authenticated request. |
| Upstreams hang | One slow API blocks the tool call until the client gives up. | `AbortSignal.timeout(30_000)`. |
| Huge bodies | A log endpoint returns tens of megabytes into the model context. | Stream the body and stop after 2 MB. |

## Output the model sees

- **Budget every result.** Serialize, measure, and if it is too long return an
  explicit `truncated: true` preview with a note on how to narrow the request.
  A silently cut JSON document reads as complete data.
- **Measure the escaped size.** Strings full of quotes and newlines grow when
  JSON-encoded; binary search the preview length against the final serialized
  size, not the raw slice.
- **Redact twice.** Remove values you know (configured tokens, issued OAuth
  tokens, URL-encoded forms of both) and patterns you can recognize (private
  keys, GitHub/GitLab/Slack tokens, JWTs, `Bearer …`, `AccountKey=`, SAS `sig=`,
  `user:password@` URLs).
- **Never echo upstream error bodies.** They can quote the request, including
  the token. Return the status plus a short redacted hint.
- **Responses are untrusted.** Issue descriptions and wiki pages can contain
  instructions. Say so in tool descriptions; never treat them as authorization.

## Tool surface

- **Optional integrations.** A missing credential should remove one group of
  tools, not crash the server. Report what is enabled with a status tool that
  states it checks configuration presence, not connectivity.
- **Annotations.** `readOnlyHint` and `openWorldHint` let clients decide what
  needs approval. Writes also take `confirm: true` as an intent check; it is not
  authentication.
- **Configuration over code.** Most "add an API" requests are a base URL, an
  auth method and a few GET endpoints. A JSON source file with environment
  variable names (never values) covers them; reserve code for real logic.
- **Path validation.** Reject `..`, `//host`, embedded queries and fragments, and
  check the final URL's origin against the configured base.

## Service authentication

- **Find the token endpoint from discovery.** For OIDC providers it is
  `<issuer>/.well-known/openid-configuration` → `token_endpoint`. The service
  URL you were given is not the token URL.
- **A token is not authorization.** A client-credentials grant can succeed while
  the API answers 401 or 403. Check the token's `aud`, `azp`, scopes and roles
  (decode locally, never print the token) before blaming the password.
- **Compare like with like.** When "it works for them", confirm the same client
  ID, the same host (a proxy hostname and the service hostname can behave
  differently) and the same method (GET versus POST search).
- **Re-test before concluding.** Access granted on the identity side can take
  effect minutes later; a fresh request beats an old diagnosis.
- **Cache with a margin.** Refresh 30 s before expiry, share one in-flight
  request between concurrent callers, and invalidate once after a 401.

## Durable knowledge

- **Markdown files are the source of truth;** any index is rebuildable.
- **Provenance or it did not happen:** sources, `verifiedAt`, and `expiresAt` for
  volatile facts. Freshness is computed when read, so stale notes announce
  themselves.
- **Refuse secrets on write.** Store where a credential lives, never its value.
- **Version the directory with Git.** Every change becomes reviewable and
  revertible without inventing an undo system.

## Collecting data in bulk

If you extend this into periodic collection (indexing many API objects into a
local database), these rules prevent silent data loss:

- **Prune only after a complete enumeration.** If pagination stopped early or a
  page failed, deleting "everything not seen" deletes real data.
- **Incremental cursors need overlap.** Re-read a few minutes before the last
  checkpoint; clocks and eventual consistency drop edge items otherwise.
- **Schedule a full reconciliation** (for example daily) to catch deletions and
  missed updates that incremental reads cannot see.
- **One writer at a time.** A lease with renewal and expiry stops two refreshes
  from interleaving, and lets a crashed one be taken over.
- **Exact identifiers stay exact.** A lexical search for `ABC-34` must not match
  `ABC-340`; treat ticket keys as phrases.

## Testing

- Start the real server over stdio in at least one test; unit tests do not catch
  registration or schema mistakes.
- `AbortSignal.timeout` timers do not keep Node's event loop alive. A test that
  waits only on that signal is cancelled, not failed; check for `cancelled` in
  the test summary too.
- The Node 20 test runner does not expand globs. Let the shell expand
  `test/*.test.ts`, and run CI on every Node version you claim to support.
