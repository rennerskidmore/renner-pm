# Final Reconciled Plan (Plan A × Plan B)

2026-06-11. Plans A and B agreed on ~90% of the architecture; this document is
the merged build spec. Where they differed, the decision and reason:

| Topic | A | B | Decision |
|---|---|---|---|
| DB access from functions | supabase-js + service role (needs `pm` exposed via PostgREST) | `npm:postgres` over `SUPABASE_DB_URL` | **B** — no PostgREST config changes, real SQL/transactions; documented Supabase pattern (`prepare:false`). Validate with a probe first; fallback = A. |
| Secret storage | `pm.app_config` table, cached at cold start | function env vars | **A** — deploy tooling can't set env vars. |
| MCP tool surface | 11 tools (list_boards, pm_stats, set_checklist, check_item) | 10 tools (get_summary, add_checklist_item, complete_task+comment) | **Union: 12 tools** (see below). |
| Card movement in UI | HTML5 drag-and-drop + move-menu fallback | move buttons only | **A** — DnD is the Trello hallmark; menu fallback keeps it reliable. |
| Boards | `pm.boards` table | enum | **A** — extensible, carries color/sort. |
| Comment import idempotency | unique `(source, source_key)` | delete+reinsert per task | **A** — no deletes, stable reasoning. |

## Architecture

- Postgres schema **`pm`**: `boards`, `tasks`, `comments`, `app_config`.
  RLS enabled with zero policies (deny-all backstop; functions connect over
  the Postgres wire as a privileged role, unaffected).
- Edge function **`pm-app`** (`verify_jwt=false`): serves single-file UI +
  JSON API + `/api/import`, under `/pm-app/{UI_SECRET}/…`.
- Edge function **`pm-mcp`** (`verify_jwt=false`): stateless streamable-HTTP
  JSON-RPC MCP server at `/pm-mcp/{MCP_SECRET}`, plain-JSON responses,
  202 for notifications, GET→405, bad secret→404, version echo per digest.
- Code in repo: `supabase/migrations/`, `supabase/functions/pm-app/`,
  `supabase/functions/pm-mcp/`, shared SQL helpers duplicated per function dir
  (deploy tool uploads per-function file sets), `web/index.html` as UI source
  of truth (inlined as a JSON-stringified TS export at deploy).

## Data model

As Plan A/B DDL (identical in substance): `pm.tasks` with bigint identity id,
`board` FK → `pm.boards(key)`, `status` enum (icebox/todo/doing/done/reference),
`bucket` text (original Trello list name; auto `"Done Mon YY"` on completion),
`priority` enum (high/medium/low/none), `labels text[]` + GIN, `due`,
`due_complete`, `archived`, `position` float, `assignees text[]`,
`checklists jsonb`, `attachments jsonb`, `source/source_id/source_url` with
partial unique `(source, source_id)`, `created_at/completed_at/updated_at`
(+touch trigger), pg_trgm index on title. `pm.comments` child table with
`(source, source_key)` partial unique. Completion invariants centralized in
`pm.move_task(id, status, bucket?)` SQL function used by API and MCP.

## MCP tools (12)

list_boards, list_tasks (filters: board/status/priority/label/query/due/
archived/limit/offset + total count), get_task, create_task, update_task,
move_task, complete_task (optional closing comment), add_comment,
set_checklist (create/replace named checklist), add_checklist_item,
check_item (fuzzy substring; errors with candidates when ambiguous),
get_summary (counts by status/priority, overdue top-10, completed this month).
Tool failures → `result.isError: true` with plain-text message. Mutating tools
return the updated task. No delete tool — archive only.

## UI (single index.html, vanilla JS + Chart.js + marked from jsDelivr)

- `#/board` view: tabs All/Personal/Intuitive Intel/VOTF; filter bar (priority
  pills Jira-colored, label dropdown, debounced search, archived + reference
  toggles); columns ICEBOX/TODO/DOING/DONE with Done grouped by monthly bucket
  (latest expanded, older collapsed with counts); cards show priority pill,
  due chip (red overdue), labels, checklist progress, comment count, board
  badge in All mode; + add-task inline at column tops; HTML5 DnD between
  columns + per-card move menu; card modal Trello-style (markdown desc,
  checklists w/ toggles, comments, due, links to Trello/GitHub).
- `#/dashboard`: stat tiles (open per board, overdue, done this month, avg age
  of open), stacked bar open board×status, doughnut open by priority, line
  created-vs-completed trailing 12 months, due-within-14-days table.
- Chart.js feature-check with plain-table fallback. `noindex` meta.

## Migration

normalized-trello.json (674) + normalized-github.json (27; tbd→label kept,
doing wins over tbd; unlabeled → intuitive-intel + `needs-review` label;
#29 → votf) → `load.js` POSTs batches of 50 to `/api/import` → upsert on
`(source, source_id)`, comments upsert on `(source, source_key)`. Run twice;
second run must change nothing. Verify with SQL reconciliation (source counts
674/27, Trello status split 51/31/30/474/88, comments 161+gh, due/checklist
counts, archived count) + 3 spot checks against raw Trello JSON.

## Verification

`tests/mcp-smoke.sh` (handshake, 202, tools/list, error codes, bad secret 404,
GET 405) + scripted CRUD round-trip via tools/call + UI curl smoke + dashboard
stats keys + `get_logs`/`get_advisors` + double-run idempotency + final
Cowork connect instructions for the user (URL pasted in Settings → Connectors).

## Build order

1. Probe function: `npm:postgres` over `SUPABASE_DB_URL` works (else fallback).
2. Migration `pm_0001_schema` + seed boards + generate/store secrets.
3. `pm-app` (API + import + UI shell) → deploy → curl tests.
4. Run migration load + verification queries.
5. `pm-mcp` → deploy → mcp-smoke + CRUD round-trip.
6. Full UI (board + modal + dashboard) → redeploy → smoke.
7. Ops checks, README, commit/push. Cleanup `pm-smoke-test` function.
