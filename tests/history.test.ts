import assert from "node:assert/strict";
import test from "node:test";
import { openSqlite } from "../src/sqlite.js";
import {
  createLedger,
  join,
  prepare,
  progress,
  PROJECT,
  publish,
  request,
  snapshot,
} from "./helpers.js";

test("history matches an earlier exact scope, combines selectors within one version, and returns current work", async (t) => {
  const { board } = await createLedger(t);
  let state = await prepare(board);
  state = await progress(board, state.session, state.task, state.work, {
    commit: "a".repeat(40),
  });
  state = await progress(board, state.session, state.task, state.work, {
    location: { paths: ["src/new.ts"], branch: "new" },
    commit: "b".repeat(40),
  });
  const old = await board.call("work_history", {
    project_id: PROJECT,
    path: "src/a.ts",
    branch: "feature",
    commit: "a".repeat(40),
    limit: 1,
  });
  assert.equal(old.matched_work_count, 1);
  assert.deepEqual(old.work[0]?.location.paths, ["src/new.ts"]);
  assert.equal(old.has_more, true);
  const mismatch = await board.call("work_history", {
    project_id: PROJECT,
    path: "src/a.ts",
    branch: "new",
  });
  assert.equal(mismatch.matched_work_count, 0);
  const partial = await board.call("work_history", {
    project_id: PROJECT,
    path: "src/a",
  });
  assert.equal(partial.matched_work_count, 0);
  const seen = new Set<number>();
  let cursor = 0;
  let more = true;
  while (more) {
    const page = await board.call("work_history", {
      project_id: PROJECT,
      path: "src/a.ts",
      after: cursor,
      limit: 1,
    });
    for (const batch of page.changes) {
      assert.equal(seen.has(batch.seq), false);
      seen.add(batch.seq);
      assert.ok(batch.records.some((entry) => entry.kind === "work"));
      assert.ok(batch.records.some((entry) => entry.kind === "session"));
    }
    assert.ok(page.cursor > cursor || !page.has_more);
    cursor = page.cursor;
    more = page.has_more;
  }
  assert.equal(seen.size, 3);
});

test("historical session model and effort remain captured after identity refresh", async (t) => {
  const { board } = await createLedger(t);
  const root = await join(board);
  const child = await join(board, "child", root);
  await publish(board, root);
  const claim = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: child,
    task_id: "a",
    expected_revision: 1,
  });
  for (const identity of [
    { name: "root", parent: null },
    { name: "child", parent: root },
  ]) {
    await board.call("project_join", {
      project_id: PROJECT,
      request_id: request(),
      repository: "repo",
      vendor: "openai",
      runtime: "codex",
      external_session_id: identity.name,
      parent_session_id: identity.parent,
      model: `new-${identity.name}`,
      effort: "low",
    });
  }
  const history = await board.call("work_history", {
    project_id: PROJECT,
    task_id: "a",
  });
  assert.deepEqual(
    history.changes.map((batch) => batch.seq),
    [claim.cursor],
  );
  const records = history.changes
    .flatMap((batch) => batch.records)
    .filter((entry) => entry.kind === "session");
  assert.equal(records.length, 2);
  assert.ok(
    records.every(
      (entry) =>
        entry.record.model === "astra" && entry.record.effort === "high",
    ),
  );
  assert.ok(
    history.sessions.every(
      (session) => session.model.startsWith("new-") && session.effort === "low",
    ),
  );
});

test("handoff delta supplies idle recipient and every missing session ancestor", async (t) => {
  const { board } = await createLedger(t);
  const { session, task, work } = await prepare(board);
  const middle = await join(board, "middle", session);
  const recipient = await join(board, "recipient", middle);
  const before = await snapshot(board);
  const handed = await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        expected_task_revision: task.revision,
        action: "handoff",
        handoff_to: recipient,
      },
    ],
  });
  const delta = await board.call("project_status", {
    project_id: PROJECT,
    since: before.cursor,
  });
  assert.ok("changes" in delta);
  assert.deepEqual(
    delta.changes.map((batch) => batch.seq),
    [handed.cursor],
  );
  const records = delta.changes
    .flatMap((batch) => batch.records)
    .filter((entry) => entry.kind === "session");
  for (const id of [middle, recipient]) {
    const entry = records.find((entry) => entry.id === id);
    assert.ok(entry);
    assert.equal(entry.context, true);
  }
  const current = await snapshot(board);
  assert.deepEqual(
    new Set(Object.keys(current.sessions)),
    new Set([session, middle, recipient]),
  );
});

test("paged attempt history bounds summaries and visits every attempt without splitting transactions", async (t) => {
  const { board } = await createLedger(t);
  let { session, task, work } = await prepare(board);
  const expected = new Set([work.id]);
  for (let index = 0; index < 12; index += 1) {
    const claimed = await board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      task_id: "a",
      expected_revision: task.revision,
      replace_work_id: work.id,
    });
    task = claimed.task;
    work = claimed.work;
    expected.add(work.id);
  }
  const seen = new Set<string>();
  let after = 0;
  let more = true;
  while (more) {
    const page = await board.call("work_history", {
      project_id: PROJECT,
      task_id: "a",
      after,
      limit: 1,
    });
    assert.ok(page.work.length <= 2);
    for (const record of page.work) seen.add(record.id);
    assert.ok(page.cursor > after || !page.has_more);
    after = page.cursor;
    more = page.has_more;
  }
  assert.deepEqual(seen, expected);
});

test("all query forms leave SQLite records, events, and retry receipts byte-for-byte unchanged", async (t) => {
  const { board, path } = await createLedger(t);
  const { session } = await prepare(board);
  const connection = await openSqlite(path);
  const dump = () => ({
    records: connection.all(
      "SELECT * FROM records ORDER BY project_id,kind,id",
      [],
    ),
    changes: connection.all("SELECT * FROM changes ORDER BY seq", []),
    requests: connection.all(
      "SELECT * FROM requests ORDER BY project_id,actor_id,request_id",
      [],
    ),
  });
  try {
    const before = dump();
    await snapshot(board);
    await board.call("project_status", { project_id: PROJECT });
    await board.call("project_status", {
      project_id: PROJECT,
      since: 0,
      limit: 1,
    });
    await board.call("project_status", {
      project_id: PROJECT,
      task_ids: ["b"],
    });
    await board.call("work_history", {
      project_id: PROJECT,
      session_id: session,
    });
    await board.call("plan_read", {
      project_id: PROJECT,
      revision: 1,
      compare_to: 0,
    });
    assert.deepEqual(dump(), before);
  } finally {
    connection.close();
  }
});
