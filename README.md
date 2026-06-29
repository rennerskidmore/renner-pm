# renner-pm

A lightweight project-management system replacing Trello (and the
GitHub-issues-as-tasks stopgap). Built 2026-06-11. Three boards — **Personal**,
**Intuitive Intel**, **VOTF** — with the full year of task history migrated in.

## View your PM in the browser

The board + dashboard run as a web app — no install, works on desktop and phone.

**Recommended — GitHub Pages:** https://rennerskidmore.github.io/renner-pm/

On your **first** visit, append your access key once:

```
https://rennerskidmore.github.io/renner-pm/?key=<UI_SECRET>
```

The page saves the key to the browser's localStorage and strips it from the
address bar, so every later visit just needs the bare URL above. If the browser
data is cleared, it re-prompts for the key. (On mobile, open it once with `?key=`
then "Add to Home Screen" for an app-like icon.)

**Direct link (bypasses Pages, serves the UI straight from the API):**

```
https://scypfjpovfmgzbdnpwpz.supabase.co/functions/v1/pm-app/<UI_SECRET>/
```

`<UI_SECRET>` is the capability key — it *is* the auth, so treat it like a
password (don't commit or share it; a wrong key returns 404). Retrieve the
current value with:

```sql
select value from pm.app_config where key = 'ui_secret';
```

To rotate it, update that row (see "Where everything lives" below).

## Where everything lives

| Component | Location |
|---|---|
| Database | Supabase project `scypfjpovfmgzbdnpwpz`, schema `pm` (tables: `boards`, `tasks`, `comments`, `app_config`) |
| Web UI + JSON API | Edge function **`pm-app`** at `…/functions/v1/pm-app/{UI_SECRET}/` |
| MCP server (for Claude Cowork) | Edge function **`pm-mcp`** at `…/functions/v1/pm-mcp/{MCP_SECRET}` |
| Secrets | `select * from pm.app_config` (`ui_secret`, `mcp_secret`) — never committed |

The secret path segment is the only auth (capability URL). Wrong secret → 404.
Anyone with a URL has full access to that surface — treat the URLs like passwords.
Rotate by updating `pm.app_config` (functions cache secrets per isolate; force a
redeploy to flush immediately).

## Concepts

- **Status** (board columns): `icebox`, `todo`, `doing`, `done`, plus
  `reference` for non-work notes (Team Info, Project Overview, goals lists).
- **Bucket**: the original Trello list name. Completing a task auto-files it
  into a monthly bucket ("Done Jun 26") — the Done column groups by these,
  preserving the old monthly-done-list workflow with zero effort.
- **Priority**: `high` / `medium` / `low` / `none` (Jira-style colors).
- **Labels**: free-form tags (Maint, Install, Design, Marketing, …).
- Checklists and attachments are JSON on the task; comments are first-class
  rows with author + date. Tasks are archived, never deleted.

## UI

Single-file vanilla-JS app (`web/index.html`) served from the database
(`pm.app_config.ui_html`), so UI changes deploy with
`PM_APP_URL=… ./scripts/update-ui.sh` — no function redeploy.

- **Board view**: tabs (All / per board), ICEBOX–TODO–DOING–DONE columns,
  monthly-bucket grouping in Done, drag-and-drop between columns, priority/label
  filters, search, archived + reference toggles, inline add, Trello-style card
  modal (markdown description, checklists, comments, due, source links).
- **Dashboard**: open/overdue/done-this-month/avg-age tiles, open-by-board×status
  stacked bar, priority doughnut, created-vs-completed 12-month line, due-in-14-days
  table. Chart.js from CDN with plain-table fallback.

## Claude Cowork / claude.ai connector

claude.ai → **Settings → Connectors → Add custom connector** → paste the MCP
URL (`…/functions/v1/pm-mcp/{MCP_SECRET}`). No OAuth needed (leave Advanced
settings empty). Works across claude.ai, Claude Desktop, mobile, and Cowork.

12 tools: `list_boards`, `list_tasks`, `get_task`, `create_task`, `update_task`,
`move_task`, `complete_task`, `add_comment`, `set_checklist`,
`add_checklist_item`, `check_item`, `get_summary`. Stateless streamable-HTTP
JSON-RPC (plain JSON responses); protocol tests in `tests/mcp-smoke.sh`.

## Migration (done, idempotent, re-runnable)

`migration/` contains the full pipeline and source exports:

1. `extract.js` — normalizes the three Trello board exports
   (`migration/source/*.json`, full action history) → 674 tasks with buckets,
   labels, due dates, checklists+states, 162 comments, archived flags,
   creation/completion timestamps, Trello URLs.
2. `extract-github.js` — normalizes the 29 GitHub issues (2 test issues
   skipped) → 27 tasks; labels mapped (`in2`→Intuitive Intel, `votf`, `personal`;
   `todo`/`doing`; `priority:*` and "Priority:/Due:" body text parsed).
3. `load.js` — POSTs batches of 50 to `/api/import`, which upserts on
   `(source, source_id)`. Running twice converges (verified: second run
   inserted=0). Also the restore path.

Verified counts: 701 tasks (674 Trello + 27 GitHub), status split
51 todo / 31 doing / 30 icebox / 474 done / 88 reference (Trello), 162 comments,
85 tasks with checklists, 331 with due dates, 207 archived — all matching the
source exports exactly.

## Development

- Schema: `supabase/migrations/*.sql` (applied via the Supabase MCP tools).
- Functions: `supabase/functions/pm-app`, `supabase/functions/pm-mcp`
  (`db.ts` is shared and kept identical in both).
- Tests: `tests/mcp-smoke.sh` (14 protocol checks) — run with
  `PM_MCP_URL=<mcp url> tests/mcp-smoke.sh`.
- Plans and research that produced this design: `docs/` (context brief,
  research digest, plan A, plan B, reconciled final plan).
