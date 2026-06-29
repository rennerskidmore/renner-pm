# Research Digest (2026-06-11)

Condensed findings from five parallel research passes (Trello model, Jira model,
OSS PM tools, MCP transport spec, Claude Cowork connector requirements).
This digest is the decision input for planning.

## 1. Trello — what to borrow

- Model: Board → Lists (ordered, `pos` float) → Cards (name, desc, due,
  dueComplete, labels = color+name, checklists with complete/incomplete items,
  members, attachments). Comments live in the action log (`commentCard`).
- Simplicity comes from: drag-and-drop between lists, inline card add, the
  card-back modal (desc/checklist/comments in one overlay), one-key filtering,
  starred-board switching. Float `pos` ordering means a move touches one row.
- Card aging (fade untouched cards) is a beloved nicety, optional.

## 2. Jira — what to borrow

- Priorities: Highest / High / Medium / Low / Lowest with fixed colors
  (dark red / orange / yellow / grey / light grey).
- Statuses always roll up to 3 status categories: To Do (grey),
  In Progress (blue), Done (green) — this drives boards, filters, charts.
- Dashboards: most-valued gadgets are Filter Results (table), Pie chart by
  status/assignee/priority, Created-vs-Resolved over time, Assigned to Me,
  Issue Statistics (one-field breakdown), Average Age. Community wisdom:
  few high-signal gadgets beat 14 noisy ones.
- JQL = field + operator + value combinators; we only need a small subset
  (board, status, priority, label, due, text contains).

## 3. Prebuilt OSS PM tools — verdict: none fit, build custom

All seven evaluated tools (Planka, Focalboard, Wekan, Vikunja, Kanboard,
Plane, Taiga) require a long-running server process (Node/Go/PHP/Python +
DB daemons). We have no Docker host/VPS — only Supabase Edge Functions
(short-lived Deno isolates) and a GitHub repo. Notables:

- Vikunja: best API, single Go binary — still needs a host we don't have.
- Kanboard: lightest (shared PHP hosting) — still a server.
- Focalboard: unmaintained, avoid. Plane: official MCP server but heaviest infra.
- Existing "kanban MCP server with embedded SQLite" projects prove the
  MCP-native task store pattern, but give no UI/dashboards and no shared
  persistence for a web UI.

Conclusion: a small custom system on Supabase (Postgres + Edge Functions)
matches the constraints exactly; effort is modest because requirements are
Trello-scale, not Jira-scale.

## 4. MCP remote server — known-good pattern

- Spec (2025-03-26 / 2025-06-18 streamable HTTP): single endpoint, POST per
  JSON-RPC message. Server MAY reply `application/json` (single object) —
  SSE NOT required; client MUST accept JSON. Stateless mode (no
  `Mcp-Session-Id`) is fully compliant. GET may return 405. Notifications
  (`notifications/initialized` etc.) → `202 Accepted`, empty body.
- Minimal method set: `initialize` (return negotiated protocolVersion,
  `capabilities: {tools:{}}`, serverInfo), `ping` (empty result),
  `tools/list`, `tools/call`. Unknown method → JSON-RPC error -32601.
  Echo client's protocolVersion if supported; default `2025-03-26` when the
  MCP-Protocol-Version header is absent.
- Supabase Edge Functions are an officially documented MCP host
  (supabase.com/docs/guides/getting-started/byo-mcp): deploy with
  verify_jwt=false; stateless JSON responses are the natural fit given the
  2s-CPU/150s-wall limits. Confirmed working in our project via smoke test.

## 5. Claude Cowork / claude.ai custom connectors — auth reality

- Custom connectors are configured at the Claude account level
  (Settings → Connectors) and work across claude.ai, Desktop, mobile, and
  Cowork. Connections originate from Anthropic's cloud, so the server must
  be public HTTPS.
- Transport: Streamable HTTP (SSE legacy-accepted, being deprecated).
- Auth: for personal connectors an **unauthenticated URL is supported**
  (OAuth fields are optional "Advanced settings"). There is **no bearer-token
  / custom-header field** in the claude.ai UI (GH issue #112, closed
  not-planned). Full OAuth 2.1 + Dynamic Client Registration is the
  first-class path but is heavy (registration endpoint, PKCE, discovery).
- Practical pattern used in the wild: **secret embedded in the URL path**
  (capability URL). HTTPS protects the path in transit.

## Decision inputs distilled

1. Build custom on Supabase: Postgres tables + one Edge Function for the MCP
   server + one Edge Function (or same one) serving the web UI.
2. MCP server: hand-rolled stateless JSON-RPC handler (no SDK needed) or
   official SDK's web-standard transport; both documented-working on Deno.
3. Secure both UI and MCP with a secret path segment / query token; no OAuth.
4. UI: single-page app, Trello-style board with buckets as columns,
   Jira-style priorities and a small dashboard (pie by status, by board,
   created-vs-completed line, due-soon list, average age).
