import assert from "node:assert/strict";
import test from "node:test";
import { Board } from "../src/board.js";
import {
  createLedger,
  join,
  prepare,
  progress,
  PROJECT,
  publish,
  rejectsCode,
  request,
  snapshot,
} from "./helpers.js";

const resultCommit = "a".repeat(40);
const integrationCommit = "b".repeat(40);

test("retries survive reopening and reject changed supplied defaults without writes", async (t) => {
  const { board, path } = await createLedger(t);
  const session = await join(board);
  await publish(board, session);
  const input = {
    project_id: PROJECT,
    request_id: "claim-once",
    session_id: session,
    task_id: "a",
    expected_revision: 1,
  };
  const first = await board.call("work_claim", input);
  const before = await snapshot(board);
  assert.deepEqual(await new Board(path).call("work_claim", input), first);
  await rejectsCode(
    board.call("work_claim", { ...input, location: {} }),
    "conflict",
  );
  assert.deepEqual(await snapshot(board), before);
});

test("session identities preserve parent and repository while explicit root takeover changes authority", async (t) => {
  const { board } = await createLedger(t);
  const root = await join(board);
  assert.equal(await join(board), root);
  const child = await join(board, "child", root);
  await rejectsCode(join(board, "child"), "conflict");
  const base = {
    project_id: PROJECT,
    request_id: request(),
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "next",
    model: "astra",
    take_over_from: root,
  };
  await rejectsCode(
    board.call("project_join", { ...base, parent_session_id: child }),
    "forbidden",
  );
  await rejectsCode(
    board.call("project_join", { ...base, repository: "different" }),
    "conflict",
  );
  const next = await board.call("project_join", base);
  assert.equal((await snapshot(board)).coordinator_session_id, next.session_id);
  await rejectsCode(publish(board, root), "forbidden");
  await rejectsCode(
    board.call("project_join", {
      ...base,
      request_id: request(),
      external_session_id: "third",
    }),
    "conflict",
  );
});

test("batch failure rolls back records, heartbeats, history and request receipt then permits retry", async (t) => {
  const { board } = await createLedger(t);
  const { session, task, work } = await prepare(board);
  const before = await snapshot(board);
  const input = {
    project_id: PROJECT,
    session_id: session,
    request_id: "atomic-retry",
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        commit: resultCommit,
      },
      { work_id: "missing", expected_revision: 1, status: "complete" },
    ],
  };
  await rejectsCode(board.call("work_update", input), "not_found");
  assert.deepEqual(await snapshot(board), before);
  const success = await board.call("work_update", {
    ...input,
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        expected_task_revision: task.revision,
        status: "blocked",
        blocker: "waiting",
      },
    ],
  });
  assert.equal(success.work[0]?.status, "blocked");
  const delta = await board.call("project_status", {
    project_id: PROJECT,
    since: before.cursor,
  });
  assert.ok("changes" in delta);
  assert.equal(delta.changes.length, 1);
});

test("work and task compare-and-swap versions independently reject stale updates", async (t) => {
  const { board } = await createLedger(t);
  const state = await prepare(board);
  const before = await snapshot(board);
  await rejectsCode(
    board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: state.session,
      updates: [
        {
          work_id: state.work.id,
          expected_revision: state.work.revision,
          expected_task_revision: 1,
          status: "complete",
        },
      ],
    }),
    "conflict",
  );
  assert.deepEqual(await snapshot(board), before);
  await progress(board, state.session, state.task, state.work, {
    location: { branch: "new" },
  });
  await rejectsCode(
    progress(board, state.session, state.task, state.work, {
      blocker: "stale",
    }),
    "conflict",
  );
});

test("replacement abandons an attempt and prevents obsolete or unrelated owners from writing", async (t) => {
  const { board } = await createLedger(t);
  const state = await prepare(board);
  const next = await join(board, "next");
  const input = {
    project_id: PROJECT,
    request_id: request(),
    session_id: next,
    task_id: "a",
    expected_revision: state.task.revision,
  };
  await rejectsCode(board.call("work_claim", input), "conflict");
  const replacement = await board.call("work_claim", {
    ...input,
    replace_work_id: state.work.id,
  });
  assert.equal(replacement.work.predecessor_work_id, state.work.id);
  assert.equal(replacement.task.owner_work_id, replacement.work.id);
  await assert.rejects(
    progress(board, state.session, state.task, state.work, {
      status: "complete",
    }),
  );
  const stranger = await join(board, "stranger");
  await rejectsCode(
    progress(board, stranger, replacement.task, replacement.work, {
      blocker: "foreign",
    }),
    "forbidden",
  );
  const history = await board.call("work_history", {
    project_id: PROJECT,
    task_id: "a",
  });
  assert.equal(
    history.work.find((work) => work.id === state.work.id)?.status,
    "abandoned",
  );
});

test("contributor nesting requires immediate session parent and never changes task ownership", async (t) => {
  const { board } = await createLedger(t);
  const { session, task, work } = await prepare(board);
  const child = await join(board, "child", session);
  const grandchild = await join(board, "grandchild", child);
  const base = {
    project_id: PROJECT,
    request_id: request(),
    task_id: "a",
    expected_revision: task.revision,
    parent_work_id: work.id,
  };
  await rejectsCode(
    board.call("work_claim", { ...base, session_id: grandchild }),
    "forbidden",
  );
  const contribution = await board.call("work_claim", {
    ...base,
    session_id: child,
  });
  assert.deepEqual(contribution.task, task);
  assert.equal(contribution.work.role, "contributor");
  const nested = await board.call("work_claim", {
    ...base,
    request_id: request(),
    session_id: grandchild,
    parent_work_id: contribution.work.id,
  });
  const completed = await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: grandchild,
    updates: [
      {
        work_id: nested.work.id,
        expected_revision: nested.work.revision,
        status: "complete",
      },
    ],
  });
  assert.deepEqual(completed.tasks, []);
  assert.deepEqual((await snapshot(board)).tasks.a, {
    revision: task.revision,
    status: task.status,
    owner_work_id: task.owner_work_id,
  });
});

test("location patches merge, explicit null clears, and awaiting integration requires proof", async (t) => {
  const { board } = await createLedger(t);
  let state = await prepare(board);
  state = await progress(board, state.session, state.task, state.work, {
    location: { checkout: "/tmp/checkout" },
    blocker: "old",
  });
  assert.deepEqual(state.work.location.paths, ["src/a.ts"]);
  assert.equal(state.work.location.target_branch, "main");
  state = await progress(board, state.session, state.task, state.work, {
    status: "awaiting_integration",
    commit: resultCommit,
    blocker: null,
    location: { branch: null },
  });
  assert.equal(state.work.blocker, null);
  assert.equal(state.work.location.branch, null);
  await assert.rejects(
    progress(board, state.session, state.task, state.work, {
      status: "complete",
    }),
    /integration commit/,
  );
  state = await progress(board, state.session, state.task, state.work, {
    status: "complete",
    integration_commit: integrationCommit,
  });
  assert.equal(state.task.status, "complete");
  await assert.rejects(
    progress(board, state.session, state.task, state.work, {
      blocker: "terminal",
    }),
  );
});

for (const intermediate of ["in_progress", "blocked"]) {
  test(`integration requirement survives ${intermediate} and handoff`, async (t) => {
    const { board } = await createLedger(t);
    let state = await prepare(board);
    const recipient = await join(board, "recipient");
    state = await progress(board, state.session, state.task, state.work, {
      status: "awaiting_integration",
      commit: resultCommit,
    });
    const updated = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: state.session,
      updates: [
        {
          work_id: state.work.id,
          expected_revision: state.work.revision,
          expected_task_revision: state.task.revision,
          status: intermediate,
          blocker: "review",
        },
      ],
    });
    const current = updated.work[0];
    const task = updated.tasks[0];
    assert.ok(current && task);
    assert.equal(current.integration_required, true);
    const handoff = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: state.session,
      updates: [
        {
          work_id: current.id,
          expected_revision: current.revision,
          expected_task_revision: task.revision,
          action: "handoff",
          handoff_to: recipient,
        },
      ],
    });
    const successor = handoff.work.find((entry) => entry.id !== current.id);
    const handedTask = handoff.tasks[0];
    assert.ok(successor && handedTask);
    assert.equal(successor.predecessor_work_id, current.id);
    assert.deepEqual(successor.location, current.location);
    assert.ok(handoff.work.every((entry) => entry.integration_required));
    await assert.rejects(
      progress(board, recipient, handedTask, successor, { status: "complete" }),
      /integration commit/,
    );
    const released = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: recipient,
      updates: [
        {
          work_id: successor.id,
          expected_revision: successor.revision,
          expected_task_revision: handedTask.revision,
          action: "release",
        },
      ],
    });
    assert.equal(released.tasks[0]?.owner_work_id, null);
    assert.equal(released.tasks[0]?.status, "pending");
  });
}

for (const location of [
  { target_branch: "release" },
  { repository: "other" },
]) {
  test(`changing integration destination ${JSON.stringify(location)} clears stale proof`, async (t) => {
    const { board } = await createLedger(t);
    let state = await prepare(board);
    state = await progress(board, state.session, state.task, state.work, {
      status: "awaiting_integration",
      commit: resultCommit,
      integration_commit: integrationCommit,
    });
    state = await progress(board, state.session, state.task, state.work, {
      location,
    });
    assert.equal(state.work.integration_commit, null);
    await assert.rejects(
      progress(board, state.session, state.task, state.work, {
        status: "complete",
      }),
      /integration commit/,
    );
    state = await progress(board, state.session, state.task, state.work, {
      status: "complete",
      integration_commit: "c".repeat(40),
    });
    assert.equal(state.task.status, "complete");
  });
}

test("changing source commit invalidates integration proof while equivalent repository and source details retain it", async (t) => {
  const { board } = await createLedger(t);
  let state = await prepare(board);
  state = await progress(board, state.session, state.task, state.work, {
    status: "awaiting_integration",
    commit: resultCommit,
    integration_commit: integrationCommit,
  });
  state = await progress(board, state.session, state.task, state.work, {
    location: {
      repository: "repo",
      branch: "other",
      base_commit: "c".repeat(40),
    },
  });
  assert.equal(state.work.integration_commit, integrationCommit);
  state = await progress(board, state.session, state.task, state.work, {
    status: "in_progress",
    commit: "d".repeat(40),
  });
  assert.equal(state.work.integration_commit, null);
  assert.equal(state.work.integration_required, true);
  await assert.rejects(
    progress(board, state.session, state.task, state.work, {
      status: "complete",
    }),
    /integration commit/,
  );
});

for (const fields of [
  { status: "blocked" },
  { status: "awaiting_integration" },
  { integration_required: false },
  { location: { paths: ["../escape"] } },
  { location: { paths: ["x", "x"] } },
  { commit: "short" },
  { action: "release", status: "complete" },
]) {
  test(`invalid work facts do not write ${JSON.stringify(fields)}`, async (t) => {
    const { board } = await createLedger(t);
    const { session, task, work } = await prepare(board);
    const before = await snapshot(board);
    await assert.rejects(
      board.call("work_update", {
        project_id: PROJECT,
        request_id: request(),
        session_id: session,
        updates: [
          {
            work_id: work.id,
            expected_revision: work.revision,
            expected_task_revision: task.revision,
            ...fields,
          },
        ],
      }),
    );
    assert.deepEqual(await snapshot(board), before);
  });
}

test("request IDs are scoped by session and projects isolate identities, plans, and history", async (t) => {
  const { board } = await createLedger(t);
  const root = await join(board);
  const child = await join(board, "child", root);
  await publish(board, root, [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ]);
  const first = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: "shared",
    session_id: root,
    task_id: "a",
    expected_revision: 1,
  });
  const second = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: "shared",
    session_id: child,
    task_id: "b",
    expected_revision: 1,
  });
  assert.notEqual(first.work.id, second.work.id);
  const foreign = await board.call("project_join", {
    project_id: "other",
    request_id: "shared",
    repository: "other-repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "root",
    model: "astra",
  });
  await rejectsCode(
    board.call("work_update", {
      project_id: "other",
      request_id: request(),
      session_id: foreign.session_id,
      updates: [
        {
          work_id: first.work.id,
          expected_revision: first.work.revision,
          blocker: "cross-project",
        },
      ],
    }),
    "not_found",
  );
  const history = await board.call("work_history", {
    project_id: "other",
    task_id: "a",
  });
  assert.equal(history.matched_work_count, 0);
  const status = await board.call("project_status", {
    project_id: "other",
    full: true,
  });
  assert.ok("tasks" in status);
  assert.deepEqual(status.tasks, {});
  assert.equal(status.repository, "other-repo");
  assert.equal((await snapshot(board)).repository, "repo");
});
