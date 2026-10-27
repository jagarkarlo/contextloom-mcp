# Changelog

## 0.5.0

### Added

- `notes_recall`: 4-level progressive recall (`1` map, `2` one-line catalog interleaving whole-note and passage hits, `3` heading-chunked passages, `4` paged full source).
- `notes_lint`: scores durable notes against North Star quality targets (`sourced`, `current`, `duplicates` via Jaccard title similarity, `mapChars`) and lists actionable fixes.
- `notes_delete`: deletes a note by ID after `confirm: true`.
- Heading-aware Markdown passage chunker (`src/chunks.ts`).

## 0.4.0

### Added

- `api_list_sources` and `api_get`: bounded, read-only access to any HTTPS JSON API declared in `CONTEXTLOOM_API_SOURCES`, with `none`, `bearer`, `header`, `query` and OAuth2 client-credentials authentication.
- Cached OAuth2 client-credentials provider with single-flight refresh and one retry after `401`.
- `notes_search`, `notes_get` and `notes_save`: durable Markdown notes with sources, `verifiedAt`, `expiresAt` and computed freshness, enabled by `CONTEXTLOOM_NOTES_DIR`.
- `contextloom_status`: reports which integrations are configured.
- MCP tool annotations (`readOnlyHint`, `openWorldHint`) on every tool.
- Design notes describing why each guard exists.

### Changed

- Every integration is optional, including GitLab and Jira; the server starts with no credentials.
- Upstream requests time out after 30 seconds, refuse redirects and stop reading after 2 MB.
- Tool output is redacted and capped at `CONTEXTLOOM_MAX_OUTPUT_CHARS` (default 16,000) with an explicit truncated preview.
- Upstream errors return a short redacted hint instead of the raw body.
- Node.js 20.18.1 or newer is required; CI tests Node 20 and 22.

### Fixed

- GitHub repository paths no longer escape the slash in `owner/repo`.

## 0.3.0

- Renamed to `contextloom-mcp`; multi-host GitLab via `GITLAB_INSTANCES` and corporate proxy support.
