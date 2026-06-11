# Plan B — "pm" schema + two edge functions + direct-Postgres, no PostgREST

Author: Planner B, 2026-06-11.
Scope: lightweight PM system on Supabase project `scypfjpovfmgzbdnpwpz` + repo
`rennerskidmore/renner-pm`. 701 migrated tasks (674 Trello + 27 GitHub), board UI,
dashboard, custom MCP server for Claude Cowork.

## 0. Architecture in one paragraph

A dedicated Postgres schema **`pm`** (clean separation from the CRM in `public`,
invisible to PostgREST by default — which is fine because *nothing uses PostgREST*).
Two Deno edge functions, both `verify_jwt=false`, both talking to the DB **directly
over the Postgres wire protocol** (`npm:postgres@3.4` + the `SUPABASE_DB_URL` env
var injected into every edge function), so schema choice and RLS are non-issues:

1. **`pm-app`** — serves the single-file vanilla-JS UI *and* a tiny JSON API under a
   secret path segment (`/pm-app/{UI_SECRET}/...`). Also hosts the one-time
   `/api/import` endpoint used by the migration loader.
2. **`pm-mcp`** — stateless streamable-HTTP JSON-RPC MCP server under a different
   secret (`/pm-mcp/{MCP_SECRET}`), 10 tools.

All code lives in the repo (`supabase/functions/pm-app`, `supabase/functions/pm-mcp`,
`supabase/migrations/*.sql`, `migration/*.js`); deployment via the Supabase MCP
admin tools (`apply_migration`, `deploy_edge_function`). Secrets are generated at
deploy time (`openssl rand -hex 16`), stored as function env vars
(`PM_UI_SECRET`, `PM_MCP_SECRET`), **never committed**.

Why direct-Postgres instead of supabase-js/PostgREST: PostgREST only exposes
configured schemas (`public` today) and changing exposed schemas isn't possible via
the MCP admin tools; the service-role path through PostgREST would also force PM
tables into `public` next to the CRM. `npm:postgres` over `SUPABASE_DB_URL`
(use `prepare: false` to be pooler-safe) gives full SQL, real transactions for the
importer, and keeps `pm.*` completely private. Belt-and-braces: enable RLS on every
`pm` table **with zero policies** so even if the schema were ever exposed, anon/
authenticated see nothing (also keeps `get_advisors` quiet).

## 1. Data model (migration `0001_pm_schema.sql`)

Three enums, two tables, one trigger. Checklists/attachments are JSONB on the task
(edited atomically, Trello-scale — never queried relationally); comments are a real
table (append-heavy, counted in dashboards, idempotency matters).

```sql
create schema if not exists pm;

create type pm.board_key as enum ('personal', 'intuitive-intel', 'votf');
create type pm.task_status as enum ('icebox', 'todo', 'doing', 'done', 'reference');
create type pm.task_priority as enum ('high', 'medium', 'low', 'none');

create table pm.tasks (
  id           bigint generated always as identity primary key,
  board        pm.board_key      not null,
  title        text              not null check (length(title) between 1 and 500),
  description  text              not null default '',
  status       pm.task_status    not null default 'todo',
  bucket       text              not null default 'TODO',  -- original/list name; monthly done buckets live here
  priority     pm.task_priority  not null default 'none',
  labels       text[]            not null default '{}',
  due          timestamptz,
  due_complete boolean           not null default false,
  archived     boolean           not null default false,
  position     double precision  not null default 65536,   -- Trello float-pos ordering
  assignees    text[]            not null default '{}',
  checklists   jsonb             not null default '[]',    -- [{name, items:[{name, done}]}]
  attachments  jsonb             not null default '[]',    -- [{name, url}]
  source       text              not null default 'mcp',   -- 'trello' | 'github' | 'mcp' | 'ui'
  source_id    text,                                       -- trello card id / gh issue number
  source_url   text,
  created_at   timestamptz       not null default now(),
  completed_at timestamptz,
  updated_at   timestamptz       not null default now()
);
create unique index tasks_source_uq on pm.tasks (source, source_id) where source_id is not null;
create index tasks_board_status_idx on pm.tasks (board, status, archived);
create index tasks_bucket_idx       on pm.tasks (board, bucket);
create index tasks_due_idx          on pm.tasks (due) where status in ('todo','doing') and not archived;
create index tasks_completed_idx    on pm.tasks (completed_at) where completed_at is not null;
create index tasks_labels_gin       on pm.tasks using gin (labels);
create index tasks_title_trgm       on pm.tasks using gin (title gin_trgm_ops); -- requires pg_trgm (already common on Supabase; create extension if not exists pg_trgm)

create table pm.comments (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references pm.tasks(id) on delete cascade,
  author     text   not null default 'Renner Skidmore',
  body       text   not null,
  source     text   not null default 'mcp',
  created_at timestamptz not null default now()
);
create index comments_task_idx on pm.comments (task_id, created_at);

create function pm.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger tasks_touch before update on pm.tasks
  for each row execute function pm.touch_updated_at();

alter table pm.tasks    enable row level security;  -- no policies: service-role only
alter table pm.comments enable row level security;
```

Modeling decisions, explicitly:
- **Status vs bucket are independent fields.** `status` drives the 4 board columns
  and all charts (Jira's status-category trick). `bucket` preserves the user's
  monthly-done-list muscle memory ("Done March 26", "February 2026") and renders as
  sub-groups inside the Done column. Active tasks: bucket mirrors the list name
  (TODO/DOING/ICEBOX). On completion, server sets `bucket = 'Done ' || to_char(now(),'Mon YY')`
  (e.g. "Done Jun 26") and `completed_at = now()` automatically.
- **Priority** is the 4-value enum above; migration writes `none` for the ~95% of
  Trello cards with no signal (per brief: do not invent priorities). UI colors:
  high = dark red, medium = orange, low = grey, none = unstyled (Jira palette).
- **Labels** are a flat `text[]` (Trello named labels + leftover GitHub labels);
  no label table — there are <20 distinct values and a GIN index covers filtering.
- **IDs**: bigint identity, displayed as `#123` everywhere (UI, MCP). Trello/GitHub
  identities survive in `(source, source_id, source_url)`; that pair is also the
  migration idempotency key.
- **updated_at** via trigger so MCP/UI/SQL writes all stay honest.

## 2. API layer

**Choice: edge-function JSON API with the direct-Postgres client; no PostgREST, no
anon key, no RLS policies.** Trade-off acknowledged: PostgREST+anon+RLS would give
the UI a free API, but it forces tables into `public` (CRM collision), needs RLS
policies that effectively make the data world-readable (anon key is public), and
the filtering DSL would leak into the UI code. A 150-line handler in `pm-app` is
simpler, keeps one auth model (secret path) for everything, and shares a `db.ts` +
`queries.ts` module with `pm-mcp` (copied into both function dirs, or a shared
import — Supabase supports `_shared/` folders in functions deploys).

`pm-app` routes (all under `/pm-app/{UI_SECRET}`):
- `GET /` → `index.html` (inlined into the function bundle as a string import)
- `GET /api/tasks?board=&status=&priority=&label=&q=&archived=&due=overdue|7d&limit=&offset=` → list (compact rows, no checklists/comments)
- `GET /api/tasks/:id` → full task + comments
- `POST /api/tasks` | `PATCH /api/tasks/:id` | `POST /api/tasks/:id/comments`
- `POST /api/tasks/:id/move {status, bucket?, position?}` (encapsulates completed_at/bucket rules)
- `GET /api/stats` → one round-trip dashboard payload (see §4)
- `POST /api/import` → migration upsert endpoint (see §5)

Both functions construct the client once per isolate:
`const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2 })`.
Secret check is a constant-time compare of path segment vs env var; mismatch → 404
(don't confirm the function exists). CORS: same-origin only, no CORS headers needed.

## 3. MCP server (`pm-mcp`)

Hand-rolled stateless JSON-RPC per the research digest — no SDK. Single endpoint
`POST https://scypfjpovfmgzbdnpwpz.supabase.co/functions/v1/pm-mcp/{MCP_SECRET}`.

Protocol handling:
- `initialize` → `{ protocolVersion: echo-if-known else "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "renner-pm", version: "1.0.0" } }`
- `notifications/*` → HTTP 202, empty body. `ping` → `{}` result.
- `tools/list` → static array below. `tools/call` → dispatch.
- `GET` → 405. Unknown method → `-32601`. Parse failure → `-32700`. Bad params →
  `-32602`. **Tool-level failures** (task not found, bad enum) return a *successful*
  JSON-RPC response with `result: { content:[{type:"text", text:"Error: ..."}], isError: true }`
  so Cowork can read and self-correct. Responses always `application/json` (single
  object, no SSE). Wrong secret → 404 with empty body.

Tool list (names chosen for Cowork ergonomics — verbs it will reach for):

| Tool | Params (JSON Schema types; * = required) | Behavior |
|---|---|---|
| `list_tasks` | `board?` enum, `status?` enum, `priority?` enum, `label?` str, `query?` str (trgm ILIKE on title+description), `due?` enum[overdue,week,month], `archived?` bool (default false), `limit?` int (default 25, max 100), `offset?` int | Compact lines: `#id [board/status] (prio) title — due …`. Returns total count for pagination. |
| `get_task` | `id*` int | Full detail: desc, labels, due, checklists with ☑/☐, comments with author/date, source_url. |
| `create_task` | `board*` enum, `title*` str, `description?`, `status?` (default todo), `priority?`, `labels?` str[], `due?` ISO date, `checklists?` [{name, items:[str]}] | Inserts with `source='mcp'`; returns `#id`. |
| `update_task` | `id*`, any of `title, description, priority, labels, due, board, archived` | Partial patch; returns updated summary. |
| `move_task` | `id*`, `status*` enum, `bucket?` str | status→done sets completed_at + monthly bucket; done→active clears them; bucket override honored. |
| `complete_task` | `id*`, `comment?` str | Sugar for move→done (+optional closing comment). Cowork uses this constantly. |
| `add_comment` | `id*`, `body*`, `author?` (default "Claude") | Appends comment. |
| `set_checklist_item` | `id*`, `item*` str (fuzzy: case-insensitive substring match within task's checklist items), `done*` bool, `checklist?` str to disambiguate | Errors listing candidates if 0 or >1 match. |
| `add_checklist_item` | `id*`, `item*` str, `checklist?` str (default first checklist or creates "Checklist") | Appends item. |
| `get_summary` | `board?` enum | Counts by status/priority, overdue list (top 10), this-month completed count — lets Cowork answer "what's on my plate" in one call. |

No `delete` tool — archive only (`update_task archived:true`); protects the
historical record from an over-eager agent. Every tool description string includes
the enum values so Cowork doesn't guess.

Connector setup for the user: claude.ai → Settings → Connectors → Add custom
connector → paste the secret URL, no OAuth fields. (Per digest: unauthenticated
URL supported; no header field exists; secret-in-path is the practical pattern.)

## 4. UI

Single `index.html` (~600 lines), vanilla ES modules inline, two CDN deps pinned via
jsDelivr: **Chart.js 4** and **marked** (render task descriptions/comments as
Markdown — Trello descs are Markdown). No build step, no framework. Hash routing:

- **`#/board/:board`** (default `#/board/intuitive-intel`) — Trello-style board.
  Header: three area tabs (Personal / Intuitive Intel / VOTF), filter bar
  (priority pills, label dropdown, text search, "show archived" toggle).
  Four columns: ICEBOX, TODO, DOING, DONE. Done column is **grouped by bucket**,
  newest monthly bucket first, collapsed beyond the latest — this *is* the user's
  monthly-done-list view. A fifth collapsible "Reference" rail holds
  `status=reference` cards. Cards show title, priority dot (Jira colors), label
  chips, due badge (red when overdue), checklist progress `3/5`.
  **Movement: no drag-and-drop.** Each card gets a hover `→` menu (Icebox/Todo/
  Doing/Done) and the detail modal has a status select. Rationale: HTML5 DnD is
  the flakiest part of a no-framework UI and Cowork can't use it anyway; buttons
  are testable with curl-level confidence. (Revisit post-launch if it grates.)
- **Task modal** (click card / `#/task/:id`) — editable title, Markdown desc with
  edit toggle, priority select, labels editor, due picker, interactive checklists
  (checkbox → PATCH), comment thread + composer, created/completed/source-URL
  footer ("View in Trello" / "View on GitHub" link).
- **`#/dashboard`** — one `GET /api/stats` payload renders:
  1. Tiles: open tasks per board, overdue count, completed this month, avg age of open tasks (days).
  2. **Stacked bar** — board × status (icebox/todo/doing) for open work.
  3. **Line, 12 months** — created vs completed per month (the Jira created-vs-resolved gadget; uses `created_at`/`completed_at`, which migration preserves, so history is real).
  4. **Doughnut** — open tasks by priority.
  5. **Table** — due next 14 days + overdue, sorted, linked to task modals.
- New-task: `+` affordance at the top of each column → inline title input (Enter
  saves with that board/status), Trello-style.

Auth: none in the page itself — the page is only reachable at
`/pm-app/{UI_SECRET}/`, and all `fetch('api/...')` calls are **relative**, so the
secret rides along automatically. User bookmarks the URL. CDN-failure note: chart
code feature-checks `window.Chart` and shows plain HTML stat tables as fallback.

## 5. Migration pipeline

All scripts in `migration/`, Node, run by the builder agent locally; data enters
the DB through `POST /api/import` on `pm-app` (avoids `execute_sql` payload limits
and SQL-escaping bugs entirely; one code path = the production upsert logic).

1. **`extract.js`** — already built; emits `normalized-trello.json` (674 tasks:
   51 todo / 31 doing / 30 icebox / 88 reference / 474 done).
2. **`extract-github.js`** (new) — builder fetches all 29 issues + their comments
   via the GitHub MCP tools (`list_issues`, `issue_read`) into
   `migration/source/github-issues.json` first, then the script normalizes to the
   same shape as extract.js output. Rules:
   - Skip #24 "TEST" and #27 "__perm_test__" → exactly 27 tasks.
   - `board`: label `in2`→`intuitive-intel`, `votf`→`votf`, `personal`→`personal`;
     no board label → `personal` (and log a warning for manual review).
   - `status`: open + `doing`→doing; open + `tbd`→icebox; open otherwise (incl.
     `todo`)→todo; closed→done with `completed_at = closed_at`,
     `bucket = 'Done ' + Mon YY of closed_at`.
   - `priority`: label `priority:high|medium` wins; else body regex
     `/^\s*Priority:\s*(high|medium|low)/im`; else `none`.
   - `due`: body regex `/^\s*Due:\s*(.+)$/im` → `new Date()` parse; unparseable →
     keep line in description, due null.
   - Consumed labels (`in2`,`votf`,`personal`,`todo`,`doing`,`tbd`,`priority:*`)
     are stripped; anything else survives in `labels`.
   - `source='github'`, `source_id=String(issue.number)`, `source_url=html_url`,
     `created_at=issue.created_at`; issue comments → comments with real
     author/date; body Markdown → description verbatim.
3. **`load.js`** (new) — reads both normalized files, POSTs batches of 100 tasks to
   `/pm-app/{UI_SECRET}/api/import`. The endpoint, per task, in one transaction:
   `INSERT ... ON CONFLICT (source, source_id) DO UPDATE SET <all content cols>`
   (preserving `created_at`/`completed_at` from payload via `overriding system value`
   not needed — they're plain columns), then `DELETE FROM pm.comments WHERE
   task_id=$1 AND source=$2` + re-insert payload comments (wholesale replace makes
   comment import idempotent without per-comment keys). Returns
   `{inserted, updated, comments}` per batch; load.js sums and prints.
4. **`verify.js`** (new) — runs the reconciliation via `/api/stats` + a dedicated
   `/api/import/verify` GET, and the builder double-checks with `execute_sql`:

```sql
select source, count(*) from pm.tasks group by 1;            -- trello=674, github=27
select status, count(*) from pm.tasks where source='trello'
  group by 1;                                                -- 51/31/30/474/88
select board, count(*) from pm.tasks group by 1;             -- 204+gh, 284+gh, 186+gh
select count(*) from pm.comments where source='trello';      -- 161
select count(*) from pm.tasks where source='trello' and source_url is null; -- 0
select count(*) from pm.tasks where created_at is null;      -- 0
```

   Run `load.js` **twice**; second run must report `inserted=0, updated=701` and
   counts unchanged — that's the idempotency proof.

## 6. Testing / verification

1. **MCP protocol via curl** (scripted in `migration/test-mcp.sh`):
   - `initialize` (with and without `MCP-Protocol-Version` header) → check echoed
     version, capabilities.tools present.
   - `notifications/initialized` → expect HTTP 202 empty.
   - `tools/list` → 10 tools, schemas valid JSON Schema.
   - Wrong secret → 404; bad JSON → -32700; unknown method → -32601; GET → 405.
2. **CRUD round-trip via MCP** `tools/call`: create_task → get_task → update_task
   (priority) → add_comment → set_checklist_item → complete_task (verify
   completed_at set + bucket "Done Jun 26") → move_task back to todo (verify
   cleared) → update_task archived:true. Then confirm via `execute_sql`.
3. **UI smoke**: curl the secret URL → 200 + `<title>`; curl `/api/tasks?board=votf&status=todo`
   → JSON array; curl `/api/stats` → all keys present; wrong secret → 404.
   Browser pass by the user (filters, modal edit, dashboard renders).
4. **Migration reconciliation**: §5 queries + double-run idempotency check.
5. **Ops checks**: `get_logs` for both functions after the test pass (no uncaught
   errors); `get_advisors` security scan (expect clean: RLS enabled, nothing in
   `public`).
6. **Cowork end-to-end** (user-assisted): add the connector URL, ask Cowork to
   list todos and create one task; verify it appears on the board.

## 7. Build order, effort, risks

| # | Step | Effort |
|---|---|---|
| 1 | Migration `0001_pm_schema.sql` → `apply_migration`; sanity insert/rollback via `execute_sql` | 30 min |
| 2 | Shared `_shared/db.ts` + `queries.ts` (all SQL in one module) | 45 min |
| 3 | `pm-mcp` function (JSON-RPC shell + 10 tools) → deploy verify_jwt=false → test-mcp.sh green | 1.5 h |
| 4 | `pm-app` API routes + `/api/import` → deploy → curl CRUD green | 1 h |
| 5 | `extract-github.js` (fetch issues via GitHub MCP first) + `load.js` → run, verify counts, run again (idempotency) | 1 h |
| 6 | `index.html` board + modal + filters | 2 h |
| 7 | Dashboard (`/api/stats` + Chart.js) | 1 h |
| 8 | Full test pass (§6), `get_logs`/`get_advisors`, fix-ups | 45 min |
| 9 | Commit everything, README with the two secret-URL setup steps (secrets themselves NOT in repo; deliver URLs to user out-of-band) | 20 min |

Total ≈ 8–9 focused hours; steps 3–4 and 6–7 are independent pairs.

Risks & mitigations:
- **`SUPABASE_DB_URL` shape/pooler quirks** (prepared statements, IPv6): `prepare:false`,
  `max:2`; fallback is supabase-js + moving tables to `public` with a `pm_` prefix —
  schema code is isolated in `db.ts` so the swap is contained. Validate in step 1–2
  with a trivial deployed probe before building on it.
- **Cowork connector rejection**: protocol handler follows the digest's known-good
  pattern exactly (JSON responses, 202 for notifications, version echo); test-mcp.sh
  replicates Cowork's handshake before the user ever tries it.
- **Secret leakage**: secrets only in function env + user-delivered URLs; repo and
  commit messages scrubbed; `run_secret_scanning` before final push.
- **Edge 2s CPU / payload limits**: import batches of 100; list endpoints hard-cap
  limit 100; stats is single aggregate round-trip.
- **Two Renner Trello accounts / member name noise**: extract.js already normalizes;
  assignees are display-text only — no user system needed for a single-user tool.
- **Chart.js CDN outage**: feature-check + plain-table fallback (§4).
