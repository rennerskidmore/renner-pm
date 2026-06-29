# PM System — Context Brief

Prepared 2026-06-11 as the shared input for planning. The goal: replace the ad-hoc
GitHub-issues-as-tasks setup with a real, lightweight PM system.

## User requirements (verbatim intent)

- Buckets (grouping of tasks — Trello lists / Jira statuses-or-epics style)
- Priority labels
- Dashboards (stats/charts)
- Must contain all tasks from the past year (3 Trello board exports) plus current
  GitHub issues from `rennerskidmore/renner-pm`
- Simple UI (Trello-grade simplicity, not Jira-grade complexity)
- Claude Cowork must be able to add and edit tasks through a **custom MCP server**
- Informed by how Trello and Jira structure their systems; prebuilt OSS repos considered

## Available infrastructure (hard constraints)

1. **GitHub repo** `rennerskidmore/renner-pm` (currently ~empty; working branch
   `claude/clever-ptolemy-bct9cd`). GitHub Pages is plausibly available.
2. **Supabase project** `scypfjpovfmgzbdnpwpz` (https://scypfjpovfmgzbdnpwpz.supabase.co)
   reachable via MCP admin tools: can create Postgres tables (via migrations),
   run SQL, and deploy **Deno Edge Functions**. It currently hosts a small CRM
   (companies, contacts, opportunities, activities, follow_ups, engagements,
   invoices, sync_runs — all RLS-enabled). No edge functions deployed yet.
   PM tables would share this database (acceptable; prefix or separate them cleanly).
3. **No other hosting.** No Docker host, no VPS, no confirmed Vercel/Netlify/Fly.
   Whatever ships must run on (1) and/or (2).
4. The builder agent has full shell + the Supabase MCP admin tools + GitHub MCP
   tools scoped to this repo. It does NOT have `gh` CLI.

## Data to migrate

### A. GitHub issues on rennerskidmore/renner-pm (29 issues)
- Labels in use: `in2`, `votf`, `personal` (board/area), `todo`, `doing`, `tbd`
  (status), `priority:high`, `priority:medium`.
- 2 throwaway test issues (#24 "TEST", #27 "__perm_test__") — exclude.
- Some bodies carry "Priority: X" / "Due: ..." text.
- These are the *current/live* tasks (created 2026-06-08..11).

### B. Trello exports (in `migration/source/`), archived 2026-06-08
Action history was backfilled via the Trello API, so `actions` is complete.

| Board | Cards | Lists | Labels | Actions | Checklists | Members |
|---|---|---|---|---|---|---|
| Personal (`personal.json`) | 204 | 14 | 6 (all unnamed colors) | 1372 | 35 | 1 |
| Intuitive Intel (`intuitive-intel.json`) | 284 | 15 | 12 (some named: Priority, Design, Marketing, Project Requires Design) | 1892 | 33 | 3 |
| VOTF (`votf.json`) | 186 | 13 | 7 (named: Maint, Install, Schedule, Invoice, 1, 2) | 1469 | 25 | 4 |

- Lists follow a pattern: planning lists (Team Info, Project Overview, Goals),
  ICEBOX, TODO, DOING, then **monthly "Done" lists** (e.g. "Done March 26",
  "DONE Oct 13th - Nov 13th") plus catch-all DONE. Some lists archived.
- Cards have: name, desc (~145 non-empty), due (~331), dueComplete, labels,
  checklists with item states, closed (archived) flag, dateLastActivity, pos,
  shortUrl, idMembers.
- Actions worth preserving: `createCard` (true creation date), `commentCard`
  (161 comments w/ text+author+date), `updateCard` with listAfter/listBefore
  (movement history → can derive completion dates), checklist item state changes.
- Members across boards: Renner Skidmore (2 accounts), Matthew Nelson,
  Cassie Andews, Jennifer Stark.
- Attachments are URLs to trello.com (cards may become inaccessible later;
  preserve URLs as-is).

## Migration expectations

- Three boards/areas should survive as first-class groupings: Personal,
  Intuitive Intel, VOTF (GitHub label `in2` = Intuitive Intel).
- The monthly-done-list convention is the user's "buckets" muscle memory —
  the design should honor it (e.g., bucket field, or completed-date grouping
  that can render the same view).
- Preserve: creation dates, completion info, descriptions, due dates, labels,
  checklists (+item states), comments (with author/date), archived status,
  Trello short URLs for traceability.
- Priority must become a first-class field. Trello had only weak priority
  signals (a "Priority" label on Intuitive Intel, "1"/"2" labels on VOTF,
  GitHub `priority:high|medium` labels). Defaulting unlabeled to "none/medium"
  is acceptable; do not invent priorities.

## Deliverable shape

The plan must specify: data model, where each component runs, the MCP server
design (tools list + transport + auth compatible with Claude Cowork custom
connectors), the UI (views: board/kanban by bucket, filtering, dashboards with
charts), the migration pipeline (idempotent, verifiable counts), and a test/
verification step. Everything must be deployable by the builder agent today,
with code committed to this repo.
