import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Board } from "../src/board.js";
import { Database } from "../src/db.js";
import {
  normalizeLocation,
  planRevisionSchema,
  projectIdSchema,
  projectStatusSchema,
  sessionIdSchema,
  taskIdSchema,
  workIdSchema,
  type TaskFields,
  type TaskState,
  type WorkFields,
  type WorkState,
} from "../src/schemas.js";
import { projectStatus, type CompactSession } from "../src/queries.js";
import { createLedger, join, publish, request } from "./helpers.js";

const project = projectIdSchema.parse("test");
const root = sessionIdSchema.parse("root");

type SeedTask = { id: string; fields: TaskFields };
type SeedWork = { id: string; fields: WorkFields };

function task(
  id: string,
  status: TaskState = "pending",
  dependencies: string[] = [],
  owner: string | null = null,
  label = id,
): SeedTask {
  return {
    id,
    fields: {
      label,
      status,
      depends_on: dependencies.map((value) => taskIdSchema.parse(value)),
      owner_work_id: owner === null ? null : workIdSchema.parse(owner),
    },
  };
}

function work(
  id: string,
  taskId: string,
  status: WorkState = "in_progress",
  sessionId = "root",
  role: WorkFields["role"] = "owner",
  paths: string[] = [],
): SeedWork {
  return {
    id,
    fields: {
      task_id: taskIdSchema.parse(taskId),
      session_id: sessionIdSchema.parse(sessionId),
      role,
      status,
      parent_work_id: null,
      predecessor_work_id: null,
      location: normalizeLocation({ paths }),
      blocker: status === "blocked" ? "waiting for an external report" : null,
      commit: null,
      integration_commit: null,
      integration_required: false,
    },
  };
}

async function seed(
  t: TestContext,
  tasks: SeedTask[],
  works: SeedWork[] = [],
  parents: Record<string, string | null> = {},
) {
  const { board, path } = await createLedger(t);
  const database = new Database(path);
  await database.write(project, (tx) => {
    tx.actorId = root;
    tx.putProject(project, {
      repository: "repo",
      coordinator_session_id: root,
      plan_revision: planRevisionSchema.parse(1),
    });
    for (const [id, parent] of Object.entries({ root: null, ...parents })) {
      tx.putSession(sessionIdSchema.parse(id), {
        vendor: "openai",
        runtime: "codex",
        external_session_id: id,
        model: "test-model",
        effort: "high",
        parent_session_id:
          parent === null ? null : sessionIdSchema.parse(parent),
        last_seen_at: tx.now,
        acknowledged_plan_revision: planRevisionSchema.parse(0),
      });
    }
    for (const record of tasks)
      tx.putTask(taskIdSchema.parse(record.id), record.fields);
    for (const record of works)
      tx.putWork(workIdSchema.parse(record.id), record.fields);
    tx.flush();
  });
  return { board, database };
}

async function read(
  board: Board,
  options: {
    full?: boolean;
    include_map?: boolean;
    known_plan_revision?: number;
    task_ids?: string[];
  } = {},
) {
  const result = await board.call("project_status", {
    project_id: project,
    ...options,
  });
  assert.ok("tasks" in result);
  return result;
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertContext(result: Awaited<ReturnType<typeof read>>): void {
  for (const [id, record] of Object.entries(result.work)) {
    const parentTask = result.tasks[record.task_id];
    assert.ok(parentTask);
    if (record.role === "owner") assert.equal(parentTask.owner_work_id, id);
    let sessionId: string | null | undefined = record.session_id;
    const seen = new Set<string>();
    while (sessionId != null) {
      assert.ok(!seen.has(sessionId), "session ancestry must terminate");
      seen.add(sessionId);
      const session: CompactSession | undefined = result.sessions[sessionId];
      assert.ok(session);
      sessionId = session.parent_session_id;
    }
  }
}

test("compact status exposes operational facts and preserves full and focused recovery", async (t) => {
  const { board } = await seed(
    t,
    [
      task("done", "complete", [], "done-work"),
      task("ready", "pending", ["done"]),
      task("waiting", "pending", ["ready"]),
      task("cancelled", "cancelled"),
      task("waiting-cancelled", "pending", ["cancelled"]),
      task("active", "in_progress", [], "active-work"),
    ],
    [work("done-work", "done", "complete"), work("active-work", "active")],
    { idle: null },
  );
  const result = await read(board);
  assert.deepEqual(
    new Set(Object.keys(result.tasks)),
    new Set(["ready", "active"]),
  );
  assert.deepEqual(result.tasks.ready, {
    revision: 1,
    status: "pending",
    available: true,
  });
  assert.deepEqual(result.dependency_states, { done: "complete" });
  assert.deepEqual(result.counts.by_status, {
    pending: 3,
    in_progress: 1,
    complete: 1,
    cancelled: 1,
  });
  assert.equal(result.counts.total, 6);
  assert.equal(result.counts.eligible, 2);
  assert.equal(result.counts.included, 2);
  assert.equal(result.counts.available, 1);
  assert.equal(result.counts.waiting, 2);
  assert.deepEqual(result.counts.sessions, {
    total: 2,
    eligible: 1,
    included: 1,
  });
  assert.equal(result.limited, false);
  for (const key of ["task_map", "project", "repository"])
    assert.ok(!(key in result));
  for (const record of Object.values(result.tasks)) {
    assert.ok(!("label" in record));
    assert.ok(!("depends_on" in record));
  }
  const active = result.work["active-work"];
  assert.ok(active);
  assert.ok("updated_at" in active);
  assert.equal(active.integration_required, false);
  assert.ok(!("location" in active));
  assert.equal(result.sessions.root?.acknowledged_plan_revision, 0);
  assert.ok(!("parent_session_id" in (result.sessions.root ?? {})));
  assertContext(result);
  const full = await read(board, { full: true });
  assert.equal(Object.keys(full.tasks).length, 6);
  assert.equal(Object.keys(full.task_map ?? {}).length, 6);
  assert.deepEqual(
    new Set(Object.keys(full.sessions)),
    new Set(["root", "idle"]),
  );
  assert.equal(full.repository, "repo");
  assert.equal(full.limited, false);
  const focused = await read(board, { task_ids: ["waiting-cancelled"] });
  assert.deepEqual(
    new Set(Object.keys(focused.tasks)),
    new Set(["waiting-cancelled", "cancelled"]),
  );
  assert.deepEqual(focused.dependency_states, { cancelled: "cancelled" });
  assert.equal(focused.limited, false);
  await assert.rejects(
    read(board, { task_ids: ["missing"] }),
    /not found|does not exist/,
  );
});

test("oversized UTF-8 task maps are wholly omitted until explicit full recovery", async (t) => {
  const { board } = await seed(
    t,
    Array.from({ length: 1500 }, (_, index) =>
      task(
        `task-${String(index).padStart(4, "0")}`,
        "pending",
        [],
        null,
        "é".repeat(500),
      ),
    ),
  );
  const current = await read(board, { known_plan_revision: 1 });
  assert.equal(current.map_changed, false);
  assert.ok(!("task_map" in current));
  for (const options of [{ include_map: true }, { known_plan_revision: 0 }]) {
    const result = await read(board, options);
    assert.ok(size(result) <= 65_536);
    assert.equal(result.limited, true);
    assert.equal(result.map_omitted, true);
    assert.ok(!("task_map" in result));
    assert.equal(result.full_hint, "full:true");
    assert.equal(result.counts.eligible, 1500);
    assert.equal(result.counts.included, Object.keys(result.tasks).length);
    assert.ok(result.counts.included < 1500);
    if ("known_plan_revision" in options)
      assert.equal(result.map_changed, true);
  }
  const full = await read(board, { full: true });
  assert.equal(Object.keys(full.tasks).length, 1500);
  assert.equal(Object.keys(full.task_map ?? {}).length, 1500);
  assert.ok(size(full) > 65_536);
  assert.equal(full.limited, false);
  await assert.rejects(read(board, { known_plan_revision: 2 }), /above/);
});

test("budget drops a whole task and all contributors without orphaning ancestry", async (t) => {
  const paths = Array.from(
    { length: 200 },
    (_, index) => `source/${"é".repeat(400)}/${index}`,
  );
  const { board } = await seed(
    t,
    [task("large", "in_progress", [], "owner"), task("small")],
    [
      work("owner", "large"),
      work("contributor", "large", "blocked", "leaf", "contributor", paths),
    ],
    { middle: "root", leaf: "middle" },
  );
  const compact = await read(board);
  assert.ok(size(compact) <= 65_536);
  assert.equal(compact.limited, true);
  assert.deepEqual(Object.keys(compact.tasks), ["small"]);
  assert.deepEqual(compact.work, {});
  assert.deepEqual(Object.keys(compact.sessions), ["root"]);
  assert.deepEqual(compact.counts.work, { eligible: 2, included: 0 });
  assert.deepEqual(compact.counts.sessions, {
    total: 3,
    eligible: 3,
    included: 1,
  });
  const full = await read(board, { full: true });
  assert.deepEqual(full.work.contributor?.location?.paths, paths);
  assert.deepEqual(
    new Set(Object.keys(full.work)),
    new Set(["owner", "contributor"]),
  );
  assertContext(full);
});

for (const state of ["pending", "complete", "cancelled"]) {
  test(`open contributor keeps ${state} parent visible`, async (t) => {
    const { board } = await seed(
      t,
      [
        task("dependency"),
        task(
          "parent",
          state === "complete"
            ? "complete"
            : state === "cancelled"
              ? "cancelled"
              : "pending",
          ["dependency"],
        ),
      ],
      [work("contributor", "parent", "blocked", "child", "contributor")],
      { child: "root" },
    );
    const result = await read(board);
    assert.ok(result.tasks.parent);
    assert.ok(result.work.contributor);
    assert.ok("blocked_task_ids" in result.blocking_path);
    assert.deepEqual(result.blocking_path.blocked_task_ids, ["parent"]);
    assert.equal(result.limited, false);
    assertContext(result);
  });
}

test("blocking path passes through a recorded blocker even when another path is longer", async (t) => {
  const tasks = [
    task("b0"),
    task("b1", "blocked", ["b0"], "blocked-work"),
    task("b2", "pending", ["b1"]),
  ];
  tasks.push(
    ...Array.from({ length: 6 }, (_, index) =>
      task(`u${index}`, "pending", index === 0 ? [] : [`u${index - 1}`]),
    ),
  );
  const { board } = await seed(t, tasks, [
    work("blocked-work", "b1", "blocked"),
  ]);
  assert.deepEqual((await read(board)).blocking_path, {
    length: 3,
    blocked_count: 1,
    task_ids: ["b0", "b1", "b2"],
    blocked_task_ids: ["b1"],
  });
});

test(
  "ten thousand node chain is iterative and explicitly omits oversized path",
  { timeout: 60_000 },
  async (t) => {
    const tasks = Array.from({ length: 10_000 }, (_, index) =>
      task(
        `task-${String(index).padStart(5, "0")}`,
        index === 5000 ? "blocked" : "pending",
        index === 0 ? [] : [`task-${String(index - 1).padStart(5, "0")}`],
        index === 5000 ? "blocked-work" : null,
      ),
    );
    const { board } = await seed(t, tasks, [
      work("blocked-work", "task-05000", "blocked"),
    ]);
    const result = await read(board);
    assert.ok(size(result) <= 65_536);
    assert.deepEqual(result.blocking_path, {
      length: 10_000,
      blocked_count: 1,
      omitted: true,
    });
    assert.equal(result.limited, true);
    assert.equal(result.full_hint, "full:true");
    assert.deepEqual(
      new Set(Object.keys(result.tasks)),
      new Set(["task-00000", "task-05000"]),
    );
    const full = await read(board, { full: true });
    assert.ok("task_ids" in full.blocking_path);
    assert.deepEqual(
      full.blocking_path.task_ids,
      tasks.map((record) => record.id),
    );
    assert.deepEqual(full.blocking_path.blocked_task_ids, ["task-05000"]);
    assert.equal(Object.keys(full.tasks).length, 10_000);
    assert.equal(Object.keys(full.task_map ?? {}).length, 10_000);
    assert.equal(full.limited, false);
  },
);

test("owned pending work stays visible and unavailable", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  await publish(board, session, [{ id: "task", label: "Task" }]);
  const claim = await board.call("work_claim", {
    project_id: project,
    request_id: request(),
    session_id: session,
    task_id: "task",
    expected_revision: 1,
  });
  await board.call("work_update", {
    project_id: project,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claim.work.id,
        expected_revision: claim.work.revision,
        expected_task_revision: claim.task.revision,
        status: "pending",
      },
    ],
  });
  const result = await read(board);
  assert.equal(result.tasks.task?.status, "pending");
  assert.equal(result.tasks.task?.owner_work_id, claim.work.id);
  assert.ok(!("available" in (result.tasks.task ?? {})));
  assert.equal(result.work[claim.work.id]?.status, "pending");
  assert.equal(result.counts.eligible, 1);
  assert.equal(result.counts.included, 1);
  assert.equal(result.counts.by_status.pending, 1);
  assert.equal(result.counts.waiting, 0);
  assert.equal(result.limited, false);
});

test("paginated delta plan revision matches the returned cursor", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  for (let revision = 0; revision < 2; revision++) {
    await board.call("plan_publish", {
      project_id: project,
      request_id: request(),
      session_id: session,
      expected_revision: revision,
      tasks: [{ id: "task", label: `revision-${revision + 1}` }],
    });
  }
  let cursor = 0;
  for (let revision = 0; revision < 3; revision++) {
    const page = await board.call("project_status", {
      project_id: project,
      since: cursor,
      limit: 1,
    });
    assert.ok("changes" in page);
    assert.equal(page.plan_revision, revision);
    assert.equal(page.has_more, revision < 2);
    assert.equal(page.changes.length, 1);
    assert.ok(page.cursor > cursor);
    cursor = page.cursor;
  }
  const empty = await board.call("project_status", {
    project_id: project,
    since: cursor,
  });
  assert.ok("changes" in empty);
  assert.equal(empty.cursor, cursor);
  assert.deepEqual(empty.changes, []);
  await assert.rejects(
    board.call("project_status", { project_id: project, since: cursor + 1 }),
    /above/,
  );
});

test("delta pagination preserves complete batches across other project sequence gaps", async (t) => {
  const { board } = await createLedger(t);
  const coordinator = await join(board);
  const first = await board.call("project_status", {
    project_id: project,
    since: 0,
    limit: 1,
  });
  assert.ok("changes" in first);
  assert.equal(first.changes.length, 1);
  assert.ok((first.changes[0]?.records.length ?? 0) >= 2);
  await board.call("project_join", {
    project_id: "other",
    request_id: request(),
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "other-root",
    model: "test-model",
  });
  const publication = await publish(board, coordinator, [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ]);
  const page = await board.call("project_status", {
    project_id: project,
    since: first.cursor,
    limit: 1,
  });
  assert.ok("changes" in page);
  assert.equal(page.cursor, publication.cursor);
  assert.ok(page.cursor > first.cursor + 1);
  assert.equal(page.has_more, false);
  assert.equal(page.changes.length, 1);
  assert.deepEqual(
    new Set(
      page.changes.flatMap((batch) =>
        batch.records
          .filter((record) => record.kind === "task")
          .map((record) => record.id),
      ),
    ),
    new Set(["a", "b"]),
  );
});

test("normal status does not decode terminal owner documents", async (t) => {
  const tasks = Array.from({ length: 30 }, (_, index) =>
    task(`done-${index}`, "complete", [], `old-${index}`),
  );
  const works = tasks.map((record, index) =>
    work(
      `old-${index}`,
      record.id,
      "complete",
      "root",
      "owner",
      Array.from(
        { length: 500 },
        (_, pathIndex) => `large/${"x".repeat(400)}/${pathIndex}`,
      ),
    ),
  );
  tasks.push(task("active", "in_progress", [], "active-work"));
  works.push(work("active-work", "active"));
  const { database } = await seed(t, tasks, works);
  const input = projectStatusSchema.parse({ project_id: project });
  const decoded: string[] = [];
  const result = await database.read(project, (tx) => {
    const parse = JSON.parse;
    JSON.parse = (text, reviver): unknown => {
      const value: unknown = parse(text, reviver);
      if (
        typeof value === "object" &&
        value !== null &&
        "role" in value &&
        value.role === "owner" &&
        "id" in value &&
        typeof value.id === "string"
      )
        decoded.push(value.id);
      return value;
    };
    try {
      return projectStatus(tx, input);
    } finally {
      JSON.parse = parse;
    }
  });
  assert.ok("tasks" in result);
  assert.deepEqual(decoded, ["active-work"]);
  assert.deepEqual(Object.keys(result.tasks), ["active"]);
  assert.equal(result.limited, false);
});
