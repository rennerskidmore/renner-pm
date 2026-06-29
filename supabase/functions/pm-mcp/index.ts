// pm-mcp: stateless streamable-HTTP MCP server for the renner-pm system.
// Endpoint: POST /pm-mcp/{MCP_SECRET}   (verify_jwt=false; secret path = auth)
// Implements: initialize, ping, tools/list, tools/call; notifications -> 202.
// All responses are single application/json objects (no SSE, no sessions).
import {
  addComment, createTask, getTask, listTasks, PRIORITIES, secretMatches,
  sql, STATUSES, taskRow, updateTask,
} from './db.ts';

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const BOARDS = ['personal', 'intuitive-intel', 'votf'];

// ---------- tool definitions ----------

const TOOLS = [
  {
    name: 'list_boards',
    description: 'List the boards (Personal, Intuitive Intel, VOTF) with open task counts by status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_tasks',
    description:
      'Search and filter tasks. Returns compact one-line summaries plus a total count. ' +
      'Statuses: icebox, todo, doing, done, reference. Priorities: high, medium, low, none.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', enum: BOARDS },
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        label: { type: 'string', description: 'exact label match' },
        query: { type: 'string', description: 'text search in title and description' },
        due: { type: 'string', enum: ['overdue', 'week', 'month'], description: 'due-date window for open tasks' },
        archived: { type: 'boolean', description: 'include archived tasks (default false)' },
        limit: { type: 'integer', default: 25, maximum: 100 },
        offset: { type: 'integer', default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Get full task detail: description, labels, due, checklists, comments, links.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    description: 'Create a task. Defaults: status todo, priority none.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', enum: BOARDS },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: STATUSES, default: 'todo' },
        priority: { type: 'string', enum: PRIORITIES, default: 'none' },
        labels: { type: 'array', items: { type: 'string' } },
        due: { type: 'string', description: 'ISO 8601 date or datetime' },
        checklists: {
          type: 'array',
          description: 'e.g. [{"name":"Steps","items":["first","second"]}]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              items: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'items'],
          },
        },
      },
      required: ['board', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_task',
    description: 'Partially update a task. Only provided fields change. Use move_task/complete_task to change status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: PRIORITIES },
        labels: { type: 'array', items: { type: 'string' } },
        due: { type: ['string', 'null'], description: 'ISO 8601, or null to clear' },
        due_complete: { type: 'boolean' },
        board: { type: 'string', enum: BOARDS },
        archived: { type: 'boolean', description: 'true archives (soft-deletes) the task' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_task',
    description:
      'Move a task to a status (board column). Moving to done stamps completed_at and files it ' +
      'into the current monthly bucket (e.g. "Done Jun 26"); moving out of done clears them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: STATUSES },
        bucket: { type: 'string', description: 'optional bucket override' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done (with optional closing comment). Shortcut for move_task to done.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        comment: { type: 'string', description: 'optional closing comment' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        body: { type: 'string' },
        author: { type: 'string', default: 'Claude' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_checklist',
    description: 'Create or wholly replace a named checklist on a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string', description: 'checklist name' },
        items: {
          type: 'array',
          description: 'strings (not done) or {name, done} objects',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { name: { type: 'string' }, done: { type: 'boolean' } },
                required: ['name'],
              },
            ],
          },
        },
      },
      required: ['id', 'name', 'items'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_checklist_item',
    description: 'Append one item to a checklist (first checklist by default; creates "Checklist" if none).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        item: { type: 'string' },
        checklist: { type: 'string', description: 'checklist name (optional)' },
      },
      required: ['id', 'item'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_item',
    description:
      'Check or uncheck a checklist item by case-insensitive substring match. ' +
      'Errors with candidates if the match is ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        item: { type: 'string', description: 'substring of the item text' },
        done: { type: 'boolean', default: true },
      },
      required: ['id', 'item'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_summary',
    description:
      'Dashboard summary: open counts by status and priority, overdue tasks, completed this month. ' +
      'Use this to answer "what is on my plate" in one call.',
    inputSchema: {
      type: 'object',
      properties: { board: { type: 'string', enum: BOARDS } },
      additionalProperties: false,
    },
  },
];

// ---------- tool helpers ----------

const fmtDue = (d: string | null) => (d ? String(d).slice(0, 10) : '');

function taskLine(t: Record<string, unknown>): string {
  const bits = [
    `#${t.id}`,
    `[${t.board}/${t.status}]`,
    t.priority !== 'none' ? `(${t.priority})` : '',
    String(t.title).slice(0, 120),
    t.due ? `— due ${fmtDue(t.due as string)}` : '',
    (t.archived as boolean) ? '[archived]' : '',
  ];
  return bits.filter(Boolean).join(' ');
}

function taskDetail(t: Record<string, unknown>): string {
  const lines = [
    `#${t.id}: ${t.title}`,
    `board: ${t.board} | status: ${t.status} | bucket: ${t.bucket} | priority: ${t.priority}${t.archived ? ' | ARCHIVED' : ''}`,
  ];
  const labels = t.labels as string[];
  if (labels?.length) lines.push(`labels: ${labels.join(', ')}`);
  if (t.due) lines.push(`due: ${t.due}${t.due_complete ? ' (complete)' : ''}`);
  lines.push(`created: ${String(t.created_at).slice(0, 10)}${t.completed_at ? ` | completed: ${String(t.completed_at).slice(0, 10)}` : ''}`);
  if (t.description) lines.push('', String(t.description));
  const cls = t.checklists as { name: string; items: { name: string; done: boolean }[] }[];
  for (const cl of cls ?? []) {
    lines.push('', `checklist "${cl.name}":`);
    for (const it of cl.items) lines.push(`  ${it.done ? '[x]' : '[ ]'} ${it.name}`);
  }
  const comments = t.comments as { author: string; body: string; created_at: string }[] | undefined;
  if (comments?.length) {
    lines.push('', 'comments:');
    for (const c of comments) lines.push(`  ${String(c.created_at).slice(0, 10)} ${c.author}: ${c.body}`);
  }
  const atts = t.attachments as { name: string; url: string }[];
  if (atts?.length) {
    lines.push('', 'attachments:');
    for (const a of atts) lines.push(`  ${a.name ?? a.url}: ${a.url}`);
  }
  if (t.source_url) lines.push('', `source: ${t.source_url}`);
  return lines.join('\n');
}

async function requireTask(id: number) {
  const t = await getTask(id);
  if (!t) throw new Error(`Task #${id} not found.`);
  return t;
}

// ---------- tool implementations ----------

const HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
  async list_boards() {
    const rows = await sql`
      select b.key, b.name, t.status::text, count(t.id)::int as n
      from pm.boards b
      left join pm.tasks t on t.board = b.key and not t.archived
      group by b.key, b.name, b.sort, t.status order by b.sort`;
    const byBoard: Record<string, string[]> = {};
    for (const r of rows) {
      (byBoard[r.name as string] ??= []).push(r.status ? `${r.status}: ${r.n}` : 'empty');
    }
    return Object.entries(byBoard)
      .map(([name, counts]) => `${name} — ${counts.join(', ')}`)
      .join('\n');
  },

  async list_tasks(a) {
    const { tasks, total } = await listTasks({
      board: a.board as string,
      status: a.status as string,
      priority: a.priority as string,
      label: a.label as string,
      q: a.query as string,
      due: a.due as string,
      archived: !!a.archived,
      limit: (a.limit as number) ?? 25,
      offset: (a.offset as number) ?? 0,
    });
    if (!tasks.length) return 'No tasks match.';
    const shown = tasks.map(taskLine).join('\n');
    return `${total} task(s) total${total > tasks.length ? `, showing ${tasks.length}` : ''}:\n${shown}`;
  },

  async get_task(a) {
    return taskDetail(await requireTask(a.id as number));
  },

  async create_task(a) {
    if (!BOARDS.includes(a.board as string)) throw new Error(`board must be one of: ${BOARDS.join(', ')}`);
    const checklists = ((a.checklists as { name: string; items: string[] }[]) ?? []).map((cl) => ({
      name: cl.name,
      items: cl.items.map((s) => ({ name: s, done: false })),
    }));
    const t = await createTask({ ...a, checklists, source: 'mcp' });
    return `Created:\n${taskLine(t)}`;
  },

  async update_task(a) {
    const { id, ...patch } = a;
    await requireTask(id as number);
    const t = await updateTask(id as number, patch);
    return `Updated:\n${taskLine(t)}`;
  },

  async move_task(a) {
    await requireTask(a.id as number);
    const rows = await sql`select * from pm.move_task(${a.id as number}::bigint, ${a.status as string}::pm.task_status, ${(a.bucket as string) ?? null})`;
    const t = taskRow(rows[0]);
    return `Moved:\n${taskLine(t)}${t.status === 'done' ? `\nfiled under "${t.bucket}"` : ''}`;
  },

  async complete_task(a) {
    await requireTask(a.id as number);
    if (a.comment) await addComment(a.id as number, a.comment as string, 'Claude', 'mcp');
    const rows = await sql`select * from pm.move_task(${a.id as number}::bigint, 'done')`;
    const t = taskRow(rows[0]);
    return `Completed #${t.id} "${t.title}" — filed under "${t.bucket}".`;
  },

  async add_comment(a) {
    await requireTask(a.id as number);
    await addComment(a.id as number, a.body as string, (a.author as string) ?? 'Claude', 'mcp');
    return `Comment added to #${a.id}.`;
  },

  async set_checklist(a) {
    const t = await requireTask(a.id as number);
    const items = (a.items as (string | { name: string; done?: boolean })[]).map((it) =>
      typeof it === 'string' ? { name: it, done: false } : { name: it.name, done: !!it.done }
    );
    const cls = (t.checklists as { name: string; items: unknown[] }[]).filter((c) => c.name !== a.name);
    cls.push({ name: a.name as string, items });
    const updated = await updateTask(a.id as number, { checklists: cls });
    return `Checklist "${a.name}" set on #${a.id} (${items.length} items).\n${taskLine(updated)}`;
  },

  async add_checklist_item(a) {
    const t = await requireTask(a.id as number);
    const cls = t.checklists as { name: string; items: { name: string; done: boolean }[] }[];
    let target = a.checklist
      ? cls.find((c) => c.name.toLowerCase() === String(a.checklist).toLowerCase())
      : cls[0];
    if (a.checklist && !target) throw new Error(`No checklist named "${a.checklist}" on #${a.id}. Existing: ${cls.map((c) => c.name).join(', ') || 'none'}`);
    if (!target) {
      target = { name: 'Checklist', items: [] };
      cls.push(target);
    }
    target.items.push({ name: a.item as string, done: false });
    await updateTask(a.id as number, { checklists: cls });
    return `Added "${a.item}" to checklist "${target.name}" on #${a.id}.`;
  },

  async check_item(a) {
    const t = await requireTask(a.id as number);
    const cls = t.checklists as { name: string; items: { name: string; done: boolean }[] }[];
    const needle = String(a.item).toLowerCase();
    const matches: { cl: string; idx: number; name: string }[] = [];
    cls.forEach((cl) =>
      cl.items.forEach((it, idx) => {
        if (it.name.toLowerCase().includes(needle)) matches.push({ cl: cl.name, idx, name: it.name });
      })
    );
    if (!matches.length) throw new Error(`No checklist item on #${a.id} matches "${a.item}".`);
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous — ${matches.length} items match "${a.item}":\n` +
          matches.map((m) => `  [${m.cl}] ${m.name}`).join('\n') +
          '\nUse a more specific substring.'
      );
    }
    const done = a.done !== false;
    const cl = cls.find((c) => c.name === matches[0].cl)!;
    cl.items[matches[0].idx].done = done;
    await updateTask(a.id as number, { checklists: cls });
    return `${done ? 'Checked' : 'Unchecked'} "${matches[0].name}" on #${a.id}.`;
  },

  async get_summary(a) {
    const b = (a.board as string) ?? null;
    const byStatus = await sql`
      select status::text, count(*)::int as n from pm.tasks
      where not archived and (${b}::text is null or board = ${b})
      group by 1 order by 1`;
    const byPriority = await sql`
      select priority::text, count(*)::int as n from pm.tasks
      where status in ('icebox','todo','doing') and not archived and (${b}::text is null or board = ${b})
      group by 1`;
    const overdue = await sql`
      select id, board, title, status::text, priority::text, due from pm.tasks
      where status in ('icebox','todo','doing') and not archived and due < now()
        and (${b}::text is null or board = ${b})
      order by due limit 10`;
    const [dm] = await sql`
      select count(*)::int as n from pm.tasks
      where status = 'done' and date_trunc('month', completed_at) = date_trunc('month', now())
        and (${b}::text is null or board = ${b})`;
    const lines = [
      `Summary${b ? ` for ${b}` : ' (all boards)'}:`,
      `by status: ${byStatus.map((r) => `${r.status}=${r.n}`).join(', ')}`,
      `open by priority: ${byPriority.map((r) => `${r.priority}=${r.n}`).join(', ') || 'none open'}`,
      `completed this month: ${dm.n}`,
    ];
    if (overdue.length) {
      lines.push('overdue:');
      for (const t of overdue) lines.push(`  ${taskLine(taskRow(t))}`);
    } else {
      lines.push('overdue: none');
    }
    return lines.join('\n');
  },
};

// ---------- JSON-RPC plumbing ----------

const rpcResult = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
const rpcError = (id: unknown, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/functions\/v1/, '').split('/').filter(Boolean);
  if (parts[0] !== 'pm-mcp' || !parts[1]) return new Response('Not found', { status: 404 });
  if (!(await secretMatches(parts[1], 'mcp_secret'))) return new Response('Not found', { status: 404 });

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  }

  // Notifications (no id) are acknowledged and ignored.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 });
  }

  try {
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion as string | undefined;
        const protocolVersion =
          requested && PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-03-26';
        return rpcResult(msg.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'renner-pm', version: '1.0.0' },
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name as string;
        const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
        const handler = HANDLERS[name];
        if (!handler) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        try {
          const text = await handler(args);
          return rpcResult(msg.id, { content: [{ type: 'text', text }] });
        } catch (e) {
          // Tool-level failure: in-band isError so the model can self-correct.
          return rpcResult(msg.id, {
            content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
            isError: true,
          });
        }
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    console.error(e);
    return rpcError(msg.id, -32603, `Internal error: ${(e as Error).message}`);
  }
});
