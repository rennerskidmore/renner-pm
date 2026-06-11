// pm-app: serves the PM web UI and its JSON API under a secret path segment.
//   /pm-app/{UI_SECRET}/            -> single-page UI
//   /pm-app/{UI_SECRET}/api/...     -> JSON API (see routes below)
// Deployed with verify_jwt=false; the secret path is the trust boundary.
import {
  addComment, createTask, getStats, getTask, listTasks, secretMatches,
  sql, updateTask,
} from './db.ts';
import html from './html.ts';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const notFound = () => new Response('Not found', { status: 404 });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // Path arrives as /pm-app/... (the /functions/v1 prefix is stripped by the
  // platform; tolerate it anyway).
  const parts = url.pathname.replace(/^\/functions\/v1/, '').split('/').filter(Boolean);
  if (parts[0] !== 'pm-app' || !parts[1]) return notFound();
  const secret = parts[1];
  if (!(await secretMatches(secret, 'ui_secret'))) return notFound();
  const rest = parts.slice(2);

  try {
    // UI — served from pm.app_config('ui_html') so UI updates need no
    // function redeploy (PUT /api/ui below); bundled placeholder as fallback.
    if (rest.length === 0) {
      if (!url.pathname.endsWith('/')) {
        // Relative fetches in the page need the trailing slash. The platform
        // rewrites the URL internally, so build the external URL from the
        // project's public base (SUPABASE_URL is auto-injected).
        return new Response(null, {
          status: 301,
          headers: { Location: `${Deno.env.get('SUPABASE_URL')}/functions/v1/pm-app/${secret}/` },
        });
      }
      const rows = await sql`select value from pm.app_config where key = 'ui_html'`;
      return new Response(rows[0]?.value ?? html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (rest[0] !== 'api') return notFound();
    const route = rest.slice(1);
    const q = url.searchParams;

    // GET /api/boards
    if (req.method === 'GET' && route[0] === 'boards' && route.length === 1) {
      const boards = await sql`
        select b.key, b.name, b.color, b.sort,
          (select count(*)::int from pm.tasks t
            where t.board = b.key and not archived and status in ('icebox','todo','doing')) as open_count
        from pm.boards b order by sort`;
      return json(boards);
    }

    // GET /api/labels
    if (req.method === 'GET' && route[0] === 'labels' && route.length === 1) {
      const rows = await sql`
        select distinct unnest(labels) as label from pm.tasks
        ${q.get('board') ? sql`where board = ${q.get('board')}` : sql``}
        order by 1`;
      return json(rows.map((r) => r.label));
    }

    // GET /api/tasks
    if (req.method === 'GET' && route[0] === 'tasks' && route.length === 1) {
      const result = await listTasks({
        board: q.get('board') ?? undefined,
        status: q.get('status') ?? undefined,
        priority: q.get('priority') ?? undefined,
        label: q.get('label') ?? undefined,
        q: q.get('q') ?? undefined,
        archived: q.get('archived') === 'true',
        due: q.get('due') ?? undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
        offset: q.get('offset') ? Number(q.get('offset')) : undefined,
      });
      return json(result);
    }

    // POST /api/tasks
    if (req.method === 'POST' && route[0] === 'tasks' && route.length === 1) {
      const body = await req.json();
      if (!body.board || !body.title) return json({ error: 'board and title are required' }, 400);
      return json(await createTask({ ...body, source: 'pm' }), 201);
    }

    const id = route[0] === 'tasks' && route[1] ? Number(route[1]) : NaN;

    // GET /api/tasks/:id
    if (req.method === 'GET' && route[0] === 'tasks' && route.length === 2 && Number.isFinite(id)) {
      const task = await getTask(id);
      return task ? json(task) : json({ error: `task ${id} not found` }, 404);
    }

    // PATCH /api/tasks/:id
    if (req.method === 'PATCH' && route[0] === 'tasks' && route.length === 2 && Number.isFinite(id)) {
      return json(await updateTask(id, await req.json()));
    }

    // POST /api/tasks/:id/comments
    if (req.method === 'POST' && route[0] === 'tasks' && route[2] === 'comments' && Number.isFinite(id)) {
      const body = await req.json();
      if (!body.body) return json({ error: 'body is required' }, 400);
      return json(await addComment(id, body.body, body.author ?? 'Renner Skidmore'), 201);
    }

    // GET /api/stats
    if (req.method === 'GET' && route[0] === 'stats') {
      return json(await getStats(q.get('board') ?? undefined));
    }

    // PUT /api/ui — upload a new UI build (body = full HTML document).
    if (req.method === 'PUT' && route[0] === 'ui') {
      const body = await req.text();
      if (!body.toLowerCase().includes('<!doctype html')) {
        return json({ error: 'body must be a full HTML document' }, 400);
      }
      await sql`
        insert into pm.app_config (key, value) values ('ui_html', ${body})
        on conflict (key) do update set value = excluded.value`;
      return json({ ok: true, bytes: body.length });
    }

    // POST /api/import — bulk idempotent upsert used by the migration loader.
    if (req.method === 'POST' && route[0] === 'import') {
      const tasks = await req.json();
      if (!Array.isArray(tasks) || tasks.length > 50) {
        return json({ error: 'expected an array of <= 50 normalized tasks' }, 400);
      }
      let inserted = 0, updated = 0, comments = 0;
      for (const t of tasks) {
        const rows = await sql`
          insert into pm.tasks (board, title, description, status, bucket, priority,
                                labels, due, due_complete, archived, position, assignees,
                                checklists, attachments, source, source_id, source_url,
                                created_at, completed_at)
          values (${t.board}, ${t.title}, ${t.description ?? ''},
                  ${t.status}::pm.task_status, ${t.bucket ?? 'TODO'},
                  ${t.priority ?? 'none'}::pm.priority, ${t.labels ?? []},
                  ${t.due ?? null}, ${!!t.due_complete}, ${!!t.archived},
                  ${t.position ?? 65536}, ${t.assignees ?? []},
                  ${sql.json(t.checklists ?? [])},
                  ${sql.json(t.attachments ?? [])},
                  ${t.source}, ${t.source_id}, ${t.source_url ?? null},
                  ${t.created_at ?? new Date().toISOString()}, ${t.completed_at ?? null})
          on conflict (source, source_id) where source_id is not null do update set
            board = excluded.board, title = excluded.title,
            description = excluded.description, status = excluded.status,
            bucket = excluded.bucket, priority = excluded.priority,
            labels = excluded.labels, due = excluded.due,
            due_complete = excluded.due_complete, archived = excluded.archived,
            position = excluded.position, assignees = excluded.assignees,
            checklists = excluded.checklists, attachments = excluded.attachments,
            source_url = excluded.source_url, created_at = excluded.created_at,
            completed_at = excluded.completed_at
          returning id, (xmax = 0) as is_insert`;
        const taskId = rows[0].id;
        if (rows[0].is_insert) inserted++; else updated++;
        const cs = t.comments ?? [];
        for (let i = 0; i < cs.length; i++) {
          const c = cs[i];
          await sql`
            insert into pm.comments (task_id, author, body, created_at, source, source_key)
            values (${taskId}, ${c.author ?? 'Unknown'}, ${c.text ?? c.body ?? ''},
                    ${c.date ?? c.created_at ?? new Date().toISOString()},
                    ${t.source}, ${`${t.source_id}:${i}`})
            on conflict (source, source_key) where source_key is not null do update set
              author = excluded.author, body = excluded.body, created_at = excluded.created_at`;
          comments++;
        }
      }
      return json({ inserted, updated, comments });
    }

    return notFound();
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
