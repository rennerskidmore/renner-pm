// Shared DB helpers for the pm-* edge functions. Kept identical in
// pm-app/ and pm-mcp/ (the deploy tool uploads per-function file sets).
import postgres from 'npm:postgres@3.4.5';

export const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
});

let secrets: Record<string, string> | null = null;

export async function getSecret(key: string): Promise<string> {
  if (!secrets) {
    const rows = await sql`select key, value from pm.app_config`;
    secrets = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  return secrets[key] ?? '';
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compare via hashes so the comparison itself leaks no prefix-timing info.
export async function secretMatches(given: string, key: string): Promise<boolean> {
  const expected = await getSecret(key);
  if (!expected) return false;
  return (await sha256hex(given)) === (await sha256hex(expected));
}

export const STATUSES = ['icebox', 'todo', 'doing', 'done', 'reference'];
export const PRIORITIES = ['high', 'medium', 'low', 'none'];

export function taskRow(t: Record<string, unknown>) {
  // postgres-js already gives JS types; normalize dates to ISO strings.
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  const arr = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    ...t,
    id: Number(t.id),
    due: iso(t.due),
    created_at: iso(t.created_at),
    completed_at: iso(t.completed_at),
    updated_at: iso(t.updated_at),
    checklists: arr(t.checklists),
    attachments: arr(t.attachments),
  };
}

export interface ListFilters {
  board?: string;
  status?: string;
  priority?: string;
  label?: string;
  q?: string;
  archived?: boolean;
  due?: string; // 'overdue' | 'week' | 'month'
  limit?: number;
  offset?: number;
}

export async function listTasks(f: ListFilters) {
  const limit = Math.min(Math.max(f.limit ?? 500, 1), 1000);
  const offset = Math.max(f.offset ?? 0, 0);
  const conds = [];
  conds.push(f.archived ? sql`true` : sql`not archived`);
  if (f.board) conds.push(sql`board = ${f.board}`);
  if (f.status) conds.push(sql`status = ${f.status}::pm.task_status`);
  if (f.priority) conds.push(sql`priority = ${f.priority}::pm.priority`);
  if (f.label) conds.push(sql`${f.label} = any(labels)`);
  if (f.q) conds.push(sql`(title ilike ${'%' + f.q + '%'} or description ilike ${'%' + f.q + '%'})`);
  if (f.due === 'overdue') conds.push(sql`due < now() and status not in ('done','reference')`);
  if (f.due === 'week') conds.push(sql`due < now() + interval '7 days' and status not in ('done','reference')`);
  if (f.due === 'month') conds.push(sql`due < now() + interval '30 days' and status not in ('done','reference')`);
  let where = conds[0];
  for (const c of conds.slice(1)) where = sql`${where} and ${c}`;

  const rows = await sql`
    select id, board, title, status, bucket, priority, labels, due, due_complete,
           archived, position, created_at, completed_at,
           jsonb_array_length(checklists) as n_checklists,
           (select count(*)::int from pm.comments c where c.task_id = t.id) as n_comments,
           (select coalesce(sum(jsonb_array_length(cl->'items')),0)::int
              from jsonb_array_elements(checklists) cl) as n_items,
           (select coalesce(sum((select count(*) from jsonb_array_elements(cl->'items') it
                                  where (it->>'done')::bool)),0)::int
              from jsonb_array_elements(checklists) cl) as n_items_done
    from pm.tasks t
    where ${where}
    order by status, position, id
    limit ${limit} offset ${offset}`;
  const [{ count }] = await sql`select count(*)::int from pm.tasks t where ${where}`;
  return { tasks: rows.map(taskRow), total: count };
}

export async function getTask(id: number) {
  const rows = await sql`select * from pm.tasks where id = ${id}`;
  if (!rows.length) return null;
  const comments = await sql`
    select id, author, body, created_at, source from pm.comments
    where task_id = ${id} order by created_at`;
  return {
    ...taskRow(rows[0]),
    comments: comments.map((c) => ({
      ...c,
      id: Number(c.id),
      created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at,
    })),
  };
}

const WRITABLE = new Set([
  'board', 'title', 'description', 'priority', 'labels', 'due', 'due_complete',
  'archived', 'position', 'assignees', 'checklists', 'attachments', 'bucket',
]);

export async function createTask(input: Record<string, unknown>) {
  const status = STATUSES.includes(input.status as string) ? (input.status as string) : 'todo';
  const bucket = (input.bucket as string) || (status === 'done' ? null : status.toUpperCase());
  const rows = await sql`
    insert into pm.tasks (board, title, description, status, bucket, priority,
                          labels, due, due_complete, archived, position,
                          assignees, checklists, attachments, source, source_id, source_url)
    values (${input.board as string}, ${input.title as string},
            ${(input.description as string) ?? ''}, ${status}::pm.task_status,
            ${bucket ?? 'TODO'}, ${PRIORITIES.includes(input.priority as string) ? input.priority as string : 'none'}::pm.priority,
            ${(input.labels as string[]) ?? []}, ${(input.due as string) ?? null},
            ${!!input.due_complete}, ${!!input.archived},
            ${(input.position as number) ?? Date.now() / 1000},
            ${(input.assignees as string[]) ?? []},
            ${sql.json((input.checklists as object[]) ?? [])},
            ${sql.json((input.attachments as object[]) ?? [])},
            ${(input.source as string) ?? 'pm'}, ${(input.source_id as string) ?? null},
            ${(input.source_url as string) ?? null})
    returning *`;
  let task = taskRow(rows[0]);
  if (status === 'done' && !input.bucket) {
    const moved = await sql`select * from pm.move_task(${task.id}::bigint, 'done')`;
    task = taskRow(moved[0]);
  }
  return task;
}

export async function updateTask(id: number, patch: Record<string, unknown>) {
  // status changes route through pm.move_task to keep completion invariants.
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status as string)) throw new Error(`invalid status: ${patch.status}`);
    await sql`select pm.move_task(${id}::bigint, ${patch.status as string}::pm.task_status, ${(patch.bucket as string) ?? null})`;
    delete patch.status;
    delete patch.bucket;
  }
  const keys = Object.keys(patch).filter((k) => WRITABLE.has(k));
  if (keys.length) {
    const sets: Record<string, unknown> = {};
    for (const k of keys) {
      sets[k] = k === 'checklists' || k === 'attachments' ? sql.json(patch[k] as object) : patch[k];
    }
    await sql`update pm.tasks set ${sql(sets)} where id = ${id}`;
  }
  const rows = await sql`select * from pm.tasks where id = ${id}`;
  if (!rows.length) throw new Error(`task ${id} not found`);
  return taskRow(rows[0]);
}

export async function addComment(taskId: number, body: string, author = 'Renner Skidmore', source = 'pm') {
  const rows = await sql`
    insert into pm.comments (task_id, author, body, source)
    values (${taskId}, ${author}, ${body}, ${source}) returning *`;
  const c = rows[0];
  return { ...c, id: Number(c.id), task_id: Number(c.task_id), created_at: c.created_at.toISOString() };
}

export async function getStats(board?: string) {
  const b = board ?? null;
  const open = sql`status in ('icebox','todo','doing') and not archived and (${b}::text is null or board = ${b})`;
  const tiles = await sql`
    select
      (select count(*)::int from pm.tasks where ${open}) as open_count,
      (select count(*)::int from pm.tasks where ${open} and due < now()) as overdue,
      (select count(*)::int from pm.tasks
        where status = 'done' and date_trunc('month', completed_at) = date_trunc('month', now())
          and (${b}::text is null or board = ${b})) as done_this_month,
      (select coalesce(round(avg(extract(epoch from now() - created_at) / 86400))::int, 0)
        from pm.tasks where ${open}) as avg_age_days`;
  const byBoardStatus = await sql`
    select board, status::text, count(*)::int as n from pm.tasks
    where ${open} group by 1, 2`;
  const byPriority = await sql`
    select priority::text, count(*)::int as n from pm.tasks
    where ${open} group by 1`;
  const monthly = await sql`
    with months as (select generate_series(date_trunc('month', now()) - interval '11 months',
                                           date_trunc('month', now()), '1 month') as m)
    select to_char(m, 'Mon YY') as month,
      (select count(*)::int from pm.tasks
        where date_trunc('month', created_at) = m and (${b}::text is null or board = ${b})) as created,
      (select count(*)::int from pm.tasks
        where date_trunc('month', completed_at) = m and (${b}::text is null or board = ${b})) as completed
    from months order by m`;
  const dueSoon = await sql`
    select id, board, title, status::text, priority::text, due from pm.tasks
    where status in ('icebox','todo','doing') and not archived and due is not null
      and due < now() + interval '14 days' and (${b}::text is null or board = ${b})
    order by due limit 30`;
  return {
    tiles: tiles[0],
    byBoardStatus,
    byPriority,
    monthly,
    dueSoon: dueSoon.map((t) => ({ ...t, id: Number(t.id), due: t.due.toISOString() })),
  };
}
