# Plan A — "pm" schema + two Edge Functions (MCP + App), edge-function-only API

Author: Planner A, 2026-06-11.
Scope: lightweight PM system on Supabase project `scypfjpovfmgzbdnpwpz` + repo
`rennerskidmore/renner-pm`. No other hosting. Everything deployable today via
`apply_migration` / `deploy_edge_function` / `execute_sql` and git.

Core stance (the one-paragraph version): put all PM objects in a dedicated
Postgres schema `pm` (clean separation from the CRM in `public`, zero PostgREST
exposure questions); never touch PostgREST or RLS from the browser — **all**
reads/writes go through Edge Functions running the service-role key; ship two
functions, `pm-mcp` (stateless streamable-HTTP JSON-RPC for Cowork) and `pm-app`
(serves a single-file vanilla-JS UI + a small JSON API + a bulk-import
endpoint), both gated by secret path segments; migrate by POSTing normalized
JSON to the import endpoint with `ON CONFLICT (source, source_id)` upserts so
the load is idempotent and re-runnable.

---

## 1. Data model

Dedicated schema `pm`. Rationale: the CRM owns `public`; PostgREST exposes only
configured schemas (default `public`), which is irrelevant here because nothing
client-side talks to PostgREST — edge functions use the service-role key and can
query any schema. `pm` gives clean namespacing, easy `pg_dump --schema=pm`
backups, and zero chance of name collisions with CRM tables.

### 1.1 Enums

```sql
create schema if not exists pm;

create type pm.task_status as enum ('icebox','todo','doing','done','reference');
create type pm.priority    as enum ('high','medium','low','none');
```

Status mirrors the extractor's five values exactly (674 tasks already classify
cleanly into them). Jira's 3 status-categories map on top for charts:
todo+icebox → "To Do", doing → "In Progress", done → "Done"; `reference` is
excluded from work stats.

### 1.2 Tables (DDL sketch)

```sql
create table pm.boards (
  key        text primary key,           -- 'personal' | 'intuitive-intel' | 'votf'
  name       text not null,              -- 'Personal', 'Intuitive Intel', 'VOTF'
  color      text not null default '#888',
  sort       int  not null default 0
);
insert into pm.boards (key, name, color, sort) values
  ('personal','Personal','#4f86c6',0),
  ('intuitive-intel','Intuitive Intel','#7b61c4',1),
  ('votf','VOTF','#5aa469',2);

create table pm.tasks (
  id            bigint generated always as identity primary key,
  board         text not null references pm.boards(key),
  title         text not null,
  description   text not null default '',
  status        pm.task_status not null default 'todo',
  bucket        text not null default 'TODO',   -- original list name / done-month bucket
  priority      pm.priority not null default 'none',
  labels        text[] not null default '{}',
  due           timestamptz,
  due_complete  boolean not null default false,
  archived      boolean not null default false,
  position      double precision not null default 65536,  -- Trello-style float ordering
  assignees     text[] not null default '{}',
  checklists    jsonb not null default '[]',
  -- shape: [{"name":"Checklist","items":[{"name":"item","done":false}]}]
  attachments   jsonb not null default '[]',    -- [{"name":"...","url":"..."}]
  source        text not null default 'pm',     -- 'trello' | 'github' | 'pm'
  source_id     text,                           -- trello card id / 'gh-<n>' / null
  source_url    text,                           -- trello shortUrl / github issue url
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  updated_at    timestamptz not null default now()
);

create unique index tasks_source_uq on pm.tasks (source, source_id)
  where source_id is not null;                  -- migration idempotency key
create index tasks_board_status_idx on pm.tasks (board, status) where not archived;
create index tasks_due_idx          on pm.tasks (due) where due is not null and status <> 'done';
create index tasks_completed_idx    on pm.tasks (completed_at);
create index tasks_labels_gin       on pm.tasks using gin (labels);
create extension if not exists pg_trgm;
create index tasks_title_trgm       on pm.tasks using gin (title gin_trgm_ops);

create table pm.comments (
  id         bigint generated always as identity primary key,
  task_id    bigint not null references pm.tasks(id) on delete cascade,
  author     text not null default 'Renner Skidmore',
  body       text not null,
  created_at timestamptz not null default now(),
  source     text not null default 'pm',
  source_key text                                -- '<source_id>:<n>' for migrated rows
);
create unique index comments_source_uq on pm.comments (source, source_key)
  where source_key is not null;
create index comments_task_idx on pm.comments (task_id, created_at);

create table pm.app_config (        -- secrets readable only by service role
  key text primary key, value text not null
);
-- insert two generated 32-hex-char secrets: 'mcp_secret', 'ui_secret'

alter table pm.tasks    enable row level security;  -- no policies = deny anon/authenticated;
alter table pm.comments enable row level security;  -- service role bypasses RLS
alter table pm.boards   enable row level security;
alter table pm.app_config enable row level security;
```

### 1.3 Modeling decisions, stated plainly

- **Buckets** = `bucket` text column holding the original Trello list name
  ("Done March 26", "ICEBOX", …). `status` is the derived canonical state. New
  tasks get bucket auto-set from status (TODO/DOING/ICEBOX); when a task is
  completed, bucket is auto-set to `"Done <Mon YY>"` (e.g. "Done Jun 26") from
  `completed_at` — this preserves the user's monthly-done muscle memory with
  zero manual effort, and the board view groups Done columns by this bucket.
- **Checklists as JSONB on the task**, not a child table. They are small
  (≤ a few dozen items), always read/written with the task, and Cowork edits
  them via dedicated tools that rewrite the JSON atomically. Avoids two extra
  tables and join fan-out at Trello scale. Comments DO get a table because they
  are append-mostly with author/date identity and feed a chart.
- **Priority**: Jira's ladder minus "Highest/Lowest" → `high/medium/low/none`,
  matching what the data actually contains (extractor emits exactly these).
- **Labels**: `text[]` + GIN. No label table — labels here are free tags
  ("Design", "Maint", "Install"…); a lookup table buys nothing at this scale.
- **ID strategy**: bigint identity → short human IDs ("task 123") that Cowork
  and the user can say out loud. `(source, source_id)` partial unique index is
  the migration idempotency key; app-created tasks have `source='pm'`,
  `source_id=null` (excluded from the index by the WHERE clause).
- **updated_at**: classic trigger.

```sql
create function pm.touch_updated_at() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;
create trigger tasks_touch before update on pm.tasks
  for each row execute function pm.touch_updated_at();
```

- **Completion invariants** enforced in one place (a `pm.move_task` SQL
  function used by both API and MCP): status→'done' sets
  `completed_at = coalesce(completed_at, now())` and the monthly bucket;
  status away from 'done' clears `completed_at` and sets bucket=upper(status).

## 2. API layer

**Decision: edge-function API with the service-role key. No PostgREST from the
browser, no anon key, no RLS policy authoring.**

Trade-offs considered:
- *PostgREST + anon key + RLS*: free CRUD, but (a) `pm` schema would need to be
  added to PostgREST's exposed schemas — a project-level config change touching
  the CRM's API surface; (b) anon-key access means writing real RLS policies,
  and "anyone with the anon key can edit" is the same security as a secret URL
  but with more moving parts; (c) computed views (dashboard aggregates,
  done-by-month) get awkward.
- *Edge function with service role* (chosen): one trust boundary (the secret
  path), arbitrary SQL/aggregates, identical code path for UI-API, MCP, and
  import. Cost: we write ~10 small handlers ourselves. Fine.

Both functions create one module-scope client:
`createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { db: { schema: 'pm' } })`
(env vars are auto-injected into edge functions). Secrets for path-gating are
read from `pm.app_config` at cold start and cached — no dependency on setting
custom function secrets, which the MCP admin tooling can't do.

`pm-app` routes (all under `/functions/v1/pm-app/<UI_SECRET>/…`, deployed with
`verify_jwt=false`):

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | the single-page UI (HTML string in the function bundle) |
| `/api/tasks` | GET | list; query params `board,status,priority,label,q,archived,due_before,limit,offset` |
| `/api/tasks` | POST | create |
| `/api/tasks/:id` | GET | full detail incl. comments |
| `/api/tasks/:id` | PATCH | partial update (uses `pm.move_task` when status changes) |
| `/api/tasks/:id/comments` | POST | add comment |
| `/api/stats` | GET | all dashboard aggregates in one round trip (see §4) |
| `/api/import` | POST | bulk upsert ≤50 normalized tasks (migration; idempotent) |

Wrong/missing secret → `404` (not 401, to avoid advertising the endpoint).

## 3. MCP server (`pm-mcp` edge function)

Stateless streamable-HTTP per the research digest. Endpoint:
`https://scypfjpovfmgzbdnpwpz.supabase.co/functions/v1/pm-mcp/<MCP_SECRET>`,
deployed `verify_jwt=false`. Hand-rolled JSON-RPC (no SDK — the method surface
is four methods; fewer deps, no bundling questions on Deno).

Protocol handling:
- `POST` only. `GET`/`DELETE` → `405`. Bad secret → `404`.
- `initialize` → echo client `protocolVersion` if it's one we know
  (`2025-06-18`, `2025-03-26`), else return `2025-03-26`; capabilities
  `{tools:{}}`; serverInfo `{name:"renner-pm", version:"1.0.0"}`. No
  `Mcp-Session-Id` header (stateless mode).
- Any `notifications/*` (no `id`) → `202 Accepted`, empty body.
- `ping` → `{}`. `tools/list` → array below. `tools/call` → dispatch.
- Unknown method → JSON-RPC `-32601`; malformed JSON → `-32700`; bad params →
  `-32602`. Responses always `Content-Type: application/json`, single object.
- Tool execution failures (task not found, bad enum value, DB error) →
  **successful** JSON-RPC response with `result.isError: true` and a plain-text
  explanation in `content` — per MCP spec, so the model can self-correct.
- Every mutating tool returns the full updated task as pretty JSON text content
  so Cowork sees the effect without a follow-up read.

Tool list (11 tools — enough verbs that Cowork rarely needs two calls):

| Tool | Params (JSON Schema sketch) | Notes |
|---|---|---|
| `list_boards` | `{}` | boards + live counts per status |
| `list_tasks` | `{board?: enum[personal,intuitive-intel,votf], status?: enum, priority?: enum, label?: string, due_before?: string(date), q?: string, archived?: bool=false, limit?: int=25, offset?: int=0}` | compact rows: id, board, title, status, priority, due, labels; sorted status,position |
| `get_task` | `{id: integer (required)}` | full detail: desc, checklists, comments, dates, source_url |
| `create_task` | `{board (required), title (required), description?, status?='todo', priority?='none', labels?: string[], due?: string, checklists?: [{name, items:[string]}]}` | returns created task with its new id |
| `update_task` | `{id (required), title?, description?, priority?, labels?, due?, due_complete?, archived?}` | partial; only sent fields change |
| `move_task` | `{id (required), status (required), board?}` | applies completion invariants (§1.3); board move allowed |
| `complete_task` | `{id (required)}` | sugar for move_task→done; high-frequency verb |
| `add_comment` | `{id (required), body (required), author?='Claude'}` | |
| `set_checklist` | `{id (required), checklist_name (required), items: [{name, done?}] (required)}` | creates or wholly replaces one named checklist |
| `check_item` | `{id (required), item (required: substring match), done?: bool=true}` | toggles first matching item across checklists; errors listing candidates if ambiguous |
| `pm_stats` | `{board?}` | open counts by status/priority, due-soon list, created-vs-done last 12 months — lets Cowork answer "how's the week look" in one call |

Auth: 32-hex-char secret path segment generated once, stored in
`pm.app_config`, committed nowhere except that table; the connector URL with
the secret is given to the user out-of-band. Rotation = update the row (cached
copy refreshes on next cold start; force with a redeploy).

## 4. UI

One HTML file (~700 lines) inlined into `pm-app`, also committed at
`web/index.html` (the deploy step inlines it). Vanilla JS + two CDN libs:
**Chart.js 4** (jsdelivr) for dashboards, **marked** (jsdelivr) for rendering
task descriptions/comments as markdown. No build step, no framework. Hash
routing: `#board` (default) and `#dashboard`.

**Board view**
- Top bar: board tabs **All / Personal / Intuitive Intel / VOTF**, priority
  filter chips (color-coded Jira-style: high=orange, medium=yellow, low=grey,
  none=light grey), label dropdown (distinct labels for current board), text
  search box (debounced, server-side ILIKE), "show archived" and
  "show reference" toggles, **+ Add task** button.
- Columns: **ICEBOX | TODO | DOING | DONE**. The Done column shows the latest
  monthly bucket expanded and prior months as collapsed headers with counts
  ("Done May 26 · 31") that expand on click — the monthly-done convention,
  rendered. In "All boards" mode, cards carry a colored board badge.
- Cards: title, priority pill, due chip (red when overdue), label dots,
  checklist progress (3/5), comment count.
- **Moving tasks: native HTML5 drag-and-drop between columns** (dragstart/
  drop on column containers — ~40 lines, no library), plus a ▸ move menu on
  each card (Icebox/Todo/Doing/Done/Archive) as the reliable fallback and the
  mobile path. Drop persists via `PATCH /api/tasks/:id {status}`; optimistic
  update with revert on error. Within-column ordering uses float `position`
  (midpoint insertion) but is a nice-to-have — ship cross-column moves first.
- Clicking a card opens the **task modal** (Trello card-back style): editable
  title, markdown description (click-to-edit textarea), priority select, due
  picker, labels editor, checklists with checkbox toggles (PATCHes the
  `checklists` JSONB) and add-item input, comment thread + add-comment box,
  created/completed dates, link to the original Trello card / GitHub issue.

**Dashboard view** (`#dashboard`, board filter applies) — one
`GET /api/stats` call, five widgets chosen from the Jira "high-signal gadgets"
finding:
1. **Doughnut: open tasks by status** (icebox/todo/doing) — Chart.js doughnut.
2. **Stacked bar: open tasks by board × priority** — Chart.js bar.
3. **Line: created vs completed per month, trailing 12 months** — two-series
   Chart.js line (Jira's created-vs-resolved; the migrated `created_at`/
   `completed_at` history makes this immediately interesting).
4. **Due soon table**: open tasks with due ≤ 14 days, sorted, overdue in red.
5. **Stat cards**: open count, done-this-month, average age of open tasks
   (days), overdue count.

**UI auth**: the secret is the path — the UI is served *from*
`/pm-app/<UI_SECRET>/`, so all its relative `api/...` fetches inherit the
secret automatically; no token handling in JS at all. Bookmark = login.
`<meta name="robots" content="noindex">` on the page.

## 5. Migration pipeline

All scripts in `migration/`, Node, run by the builder agent locally; data flows
into the DB through `POST /api/import` (same validation/upsert code path the
app uses — one implementation to trust).

1. **`extract.js`** — already built. Produces `normalized-trello.json`
   (674 tasks; 51 todo / 31 doing / 30 icebox / 88 reference / 474 done).
2. **`fetch-github.js`** — the builder agent pulls all 29 issues + their
   comments via the GitHub MCP tools (`list_issues`, `issue_read`) and writes
   `migration/source/github-issues.json` (raw). No `gh` CLI needed.
3. **`normalize-github.js`** → `normalized-github.json`, mapping rules:
   - Skip issues #24 ("TEST") and #27 ("__perm_test__") → 27 tasks.
   - Board: label `in2`→`intuitive-intel`, `votf`→`votf`, `personal`→`personal`;
     none of the three → `personal` + add label `unmapped` (flag, don't guess).
   - Status: open + `doing`→doing; open + `todo`→todo; open + `tbd`→icebox;
     open + none→todo; closed→done with `completed_at = closed_at`.
   - Priority: label `priority:high|medium` wins; else body regex
     `/^\s*Priority:\s*(high|medium|low)/im`; else `none`.
   - Due: body regex `/^\s*Due:\s*(.+)$/im` → `Date.parse`; unparseable → keep
     text in description, due=null.
   - Bucket: upper(status) for open; `"Done <Mon YY>"` from closed_at for done.
   - `source='github'`, `source_id='gh-'+number`, `source_url=html_url`,
     `created_at=createdAt`; remaining labels (minus board/status/priority
     labels) kept as task labels; issue comments → comments array with
     author/date, `source_key='gh-<n>:<i>'`.
4. **`load.js`** — reads both normalized files, POSTs batches of 50 to
   `/api/import`. The endpoint upserts:
   `insert ... on conflict (source, source_id) do update set <all content cols>`
   for tasks, then upserts comments by `(source, source_key)`. Trello comment
   `source_key = '<card_id>:<index-in-date-order>'`. Fully idempotent:
   re-running converges (701 tasks, no dupes); also our restore path.
5. **`verify.js`** — runs the reconciliation queries below via the API's stats
   + a dedicated `/api/import/verify` response, and exits nonzero on mismatch.

Verification queries (run via `execute_sql` and recorded in the PR):

```sql
select source, count(*) from pm.tasks group by source;
-- expect trello=674, github=27
select status, count(*) from pm.tasks where source='trello' group by status;
-- expect todo=51, doing=31, icebox=30, reference=88, done=474
select board, count(*) from pm.tasks group by board;     -- 204/284/186 + gh split
select count(*) from pm.comments where source='trello';  -- expect 161
select count(*) from pm.tasks where source='trello' and checklists <> '[]';
select count(*) from pm.tasks where due is not null and source='trello'; -- ~331
select count(*) from pm.tasks t where archived;          -- spot-check vs extractor
```

Plus 3 hand-picked spot checks (a card with checklists+comments, an archived
card, a GitHub issue with "Due:" in body) fetched by `source_id` and eyeballed.

## 6. Testing / verification plan

**MCP protocol tests (curl, scripted in `tests/mcp-smoke.sh`):**
1. `initialize` → 200, JSON object, `protocolVersion` echoed, `tools` capability.
2. `notifications/initialized` → 202 empty.
3. `ping` → `{"result":{}}`. 4. `tools/list` → 11 tools, valid inputSchemas.
5. Bad secret path → 404. `GET` → 405. Unknown method → `-32601`. Garbage body → `-32700`.

**CRUD round-trip via `tools/call`:** `create_task` (board=personal,
title="MCP smoke test") → `get_task` → `update_task` (priority=high) →
`add_comment` → `set_checklist` → `check_item` → `move_task` doing →
`complete_task` (assert completed_at set + bucket "Done Jun 26") →
`update_task {archived:true}`. Assert each response reflects the change.
Finally `list_tasks {q:"MCP smoke"}` finds it; clean up by archiving.

**UI smoke:** curl the UI URL → 200 + `text/html` + contains `id="board"`;
curl `/api/tasks?board=votf&status=todo` → JSON array; curl `/api/stats` →
keys for all five widgets; wrong secret → 404. Then a manual click-through:
open board, filter by priority, drag a card TODO→DOING, open modal, tick a
checklist item, add a comment, load `#dashboard` and see four charts render.

**Migration reconciliation:** `verify.js` (§5) green; re-run `load.js` and
re-verify counts unchanged (idempotency proof).

**Connector test:** add the MCP URL in claude.ai Settings → Connectors, then in
Cowork: "list my VOTF todos", "create a test task", "complete it" — done by the
user; the curl suite is the pre-flight that makes this boring.

## 7. Build order, effort, risks

| # | Step | Effort |
|---|---|---|
| 1 | Migration 0001: schema, enums, tables, indexes, triggers, `move_task` fn, seed boards, generate+insert secrets (`apply_migration`) | 30 min |
| 2 | `supabase/functions/_shared/db.ts` + `pm-app` function: router, secret gate, task CRUD, stats, import endpoint; deploy; curl API tests | 2 h |
| 3 | `fetch-github.js` + `normalize-github.js` + `load.js` + `verify.js`; run load; run verification SQL; record counts | 1.5 h |
| 4 | `pm-mcp` function: JSON-RPC core + 11 tools (reusing `_shared` query helpers); deploy; run `tests/mcp-smoke.sh` + CRUD round-trip | 2 h |
| 5 | `web/index.html` board view (columns, filters, modal, DnD + move menu); inline into `pm-app`, redeploy, manual smoke | 2.5 h |
| 6 | Dashboard view + `/api/stats` wiring (Chart.js) | 1 h |
| 7 | README (URLs-with-secrets handed over separately), commit everything on `claude/clever-ptolemy-bct9cd`, final end-to-end pass | 30 min |

Total ≈ 10 hours of focused build.

**Risks & mitigations**
- *Edge function limits (2s CPU / 150s wall):* paginate `list_tasks` (default
  25), compute dashboard aggregates in SQL not JS, import in batches of 50.
- *Cowork connector handshake quirks:* implement the digest's known-good
  pattern exactly (echo protocolVersion, 202 for notifications, plain JSON
  responses, no session id); curl suite replicates the client byte-for-byte
  before the user ever connects.
- *Secret exposure:* secrets live only in `pm.app_config` and the user's
  connector/bookmark; never committed. 404-on-bad-secret avoids discovery.
  Accepted residual risk: capability URLs are bearer tokens — documented.
- *CRM collision:* separate `pm` schema; migrations named `pm_0001_…`; no
  changes to `public` or PostgREST config at all.
- *Bulk import size limits:* import goes through HTTP batches, not giant SQL
  strings — no `execute_sql` payload-size cliff; idempotent so partial-failure
  recovery is "run it again".
- *Drag-and-drop flakiness:* move menu on every card is the guaranteed path;
  DnD is progressive enhancement.
- *Checklists-as-JSONB regret (if per-item querying ever matters):* the only
  consumer is the modal + two MCP tools; if needed later, a one-time
  `jsonb_array_elements` migration to a child table is mechanical.
