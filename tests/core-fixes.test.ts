import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { Board } from "../src/board.js";
import { workUpdateResponseSchema } from "../src/responses.js";
import {
  jsonValueSchema,
  projectIdSchema,
  workClaimSchema,
  workUpdateSchema,
} from "../src/schemas.js";
import { openSqlite } from "../src/sqlite.js";
import {
  createLedger,
  join,
  PROJECT,
  publish,
  rejectsCode,
  request,
} from "./helpers.js";

test("acknowledgment and heartbeat share one committed session revision", async (t) => {
  const { board } = await createLedger(t);
  const original = Date.prototype.toISOString;
  let now = "2026-10-21T12:00:00.000Z";
  Date.prototype.toISOString = () => now;
  try {
    const session = await join(board);
    now = "2026-10-21T12:00:01.000Z";
    await publish(board, session);
    now = "2026-10-21T12:00:02.000Z";
    await board.call("plan_ack", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      plan_revision: 1,
    });
    const delta = await board.call("project_status", {
      project_id: PROJECT,
      since: 0,
    });
    assert.ok("changes" in delta);
    const versions = delta.changes.flatMap((batch) =>
      batch.records
        .filter((entry) => entry.kind === "session" && entry.id === session)
        .map((entry) => entry.record),
    );
    assert.deepEqual(
      versions.map((record) => record.revision),
      [1, 2, 3],
    );
    const current = await board.database.read(
      projectIdSchema.parse(PROJECT),
      (tx) => tx.getSession(session),
    );
    assert.deepEqual(versions.at(-1), current);
    assert.equal(current.last_seen_at, "2026-10-21T12:00:02.000000+00:00");
    assert.equal(current.acknowledged_at, current.last_seen_at);
    assert.equal(current.acknowledged_plan_revision, 1);
  } finally {
    Date.prototype.toISOString = original;
  }
});

for (const length of [40, 64]) {
  test(`SHA-${length === 40 ? "1" : "256"} casing preserves history matches and integration proof`, async (t) => {
    const { board } = await createLedger(t);
    const session = await join(board);
    await publish(board, session);
    const claimed = await board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      task_id: "a",
      expected_revision: 1,
      location: { target_branch: "main", base_commit: "C".repeat(length) },
    });
    assert.equal(claimed.work.location.base_commit, "c".repeat(length));
    const updated = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        {
          work_id: claimed.work.id,
          expected_revision: claimed.work.revision,
          expected_task_revision: claimed.task.revision,
          status: "awaiting_integration",
          commit: "A".repeat(length),
          integration_commit: "B".repeat(length),
        },
      ],
    });
    const work = updated.work[0];
    assert.ok(work);
    assert.equal(work.commit, "a".repeat(length));
    assert.equal(work.integration_commit, "b".repeat(length));
    for (const letter of ["a", "b", "c", "A", "B", "C"]) {
      const history = await board.call("work_history", {
        project_id: PROJECT,
        commit: letter.repeat(length),
      });
      assert.equal(history.matched_work_count, 1);
      assert.equal(history.work[0]?.id, work.id);
    }
    const unchanged = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        {
          work_id: work.id,
          expected_revision: work.revision,
          commit: "A".repeat(length),
          integration_commit: "B".repeat(length),
          location: { base_commit: "C".repeat(length) },
        },
      ],
    });
    assert.deepEqual(unchanged.work, []);
    const completed = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [
        {
          work_id: work.id,
          expected_revision: work.revision,
          expected_task_revision: updated.tasks[0]?.revision,
          status: "complete",
        },
      ],
    });
    assert.equal(completed.work[0]?.integration_commit, "b".repeat(length));
    assert.equal(completed.tasks[0]?.status, "complete");
  });
}

test("1.0.2 uppercase records retain their retry receipts, integration proof, and original history", async (t) => {
  const { board, path } = await createLedger(t);
  const fixtures = joinPath(process.cwd(), "tests", "fixtures");
  const connection = await openSqlite(path);
  try {
    connection.exec(
      await readFile(joinPath(fixtures, "v1.0.2-uppercase.sql"), "utf8"),
    );
    const historyBefore = connection.all(
      "SELECT * FROM changes ORDER BY seq",
      [],
    );
    const fixture = z
      .object({
        claim_request: workClaimSchema,
        claim_response: jsonValueSchema,
        update_request: workUpdateSchema,
        update_response: workUpdateResponseSchema,
      })
      .parse(
        JSON.parse(
          await readFile(joinPath(fixtures, "v1.0.2-uppercase.json"), "utf8"),
        ),
      );
    assert.deepEqual(
      await board.call("work_claim", fixture.claim_request),
      fixture.claim_response,
    );
    assert.deepEqual(
      await board.call("work_update", fixture.update_request),
      fixture.update_response,
    );
    for (const commit of ["a".repeat(40), "b".repeat(64), "c".repeat(64)]) {
      for (const selector of [commit, commit.toUpperCase()]) {
        const found = await board.call("work_history", {
          project_id: "uppercase",
          commit: selector,
        });
        assert.equal(found.matched_work_count, 1);
      }
    }
    const work = fixture.update_response.work[0];
    assert.ok(work);
    const change = {
      work_id: work.id,
      expected_revision: work.revision,
      commit: "a".repeat(40),
    };
    await rejectsCode(
      board.call("work_update", {
        ...fixture.update_request,
        updates: [change],
      }),
      "conflict",
    );
    const updated = await board.call("work_update", {
      project_id: "uppercase",
      request_id: request(),
      session_id: fixture.update_request.session_id,
      updates: [change],
    });
    assert.equal(updated.work[0]?.commit, "a".repeat(40));
    assert.equal(updated.work[0]?.integration_commit, "b".repeat(64));
    assert.equal(updated.work[0]?.location.base_commit, "c".repeat(64));
    assert.deepEqual(
      connection.all("SELECT * FROM changes ORDER BY seq LIMIT ?", [
        historyBefore.length,
      ]),
      historyBefore,
    );
    assert.throws(
      () => connection.exec("DELETE FROM changes"),
      /history is immutable/,
    );
  } finally {
    connection.close();
  }
});

test("SQLite automatic rollback preserves the original constraint error and undoes partial writes", async (t) => {
  const { board } = await createLedger(t);
  const project = projectIdSchema.parse(PROJECT);
  await board.database.write(project, (tx) => {
    tx.execute(
      "CREATE TABLE unique_values (value TEXT UNIQUE ON CONFLICT ROLLBACK)",
      [],
    );
  });
  await assert.rejects(
    board.database.write(project, (tx) => {
      tx.putRequest("actor", "partial", "digest", {});
      tx.execute("INSERT INTO unique_values VALUES ('duplicate')", []);
      tx.execute("INSERT INTO unique_values VALUES ('duplicate')", []);
    }),
    /UNIQUE constraint failed: unique_values.value/,
  );
  await board.database.read(project, (tx) => {
    assert.equal(tx.getRequest("actor", "partial"), undefined);
    assert.deepEqual(
      tx.queryRows(
        z.object({ value: z.string() }),
        "SELECT * FROM unique_values",
        [],
      ),
      [],
    );
  });
  await board.database.write(project, (tx) => {
    tx.execute("INSERT INTO unique_values VALUES ('recovered')", []);
  });
});

test("history guards reject SQL updates and deletes while later changes still append", async (t) => {
  const { board, path } = await createLedger(t);
  await join(board);
  const connection = await openSqlite(path);
  try {
    const before = connection.all("SELECT * FROM changes ORDER BY seq", []);
    for (const sql of [
      "UPDATE changes SET body = '[]'",
      "DELETE FROM changes",
    ]) {
      assert.throws(() => connection.exec(sql), /history is immutable/);
    }
    await join(board, "another-session");
    assert.deepEqual(
      connection.all("SELECT * FROM changes ORDER BY seq LIMIT ?", [
        before.length,
      ]),
      before,
    );
    assert.equal(
      connection.all("SELECT * FROM changes", []).length,
      before.length + 1,
    );
  } finally {
    connection.close();
  }
});

const receiptRow = z.object({ project_id: z.string(), request_id: z.string() });
const timestamp = (milliseconds: number) =>
  new Date(milliseconds).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");

test("30-day cleanup is project scoped, preserves recent receipts, and skips failures and retries", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const project = projectIdSchema.parse(PROJECT);
  const input = {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [],
  };
  const first = await board.call("work_update", input);
  const now = Date.now();
  await board.database.write(project, (tx) => {
    for (const [projectId, id, ageDays] of [
      [PROJECT, "expired", 31],
      [PROJECT, "recent", 29],
      ["other", "other-expired", 31],
    ] satisfies [string, string, number][]) {
      tx.execute(
        "INSERT INTO requests VALUES (?, 'archived', ?, 'digest', '{}', ?)",
        [projectId, id, timestamp(now - ageDays * 24 * 60 * 60 * 1000)],
      );
    }
  });
  const archived = () =>
    board.database.read(project, (tx) =>
      tx.queryRows(
        receiptRow,
        "SELECT project_id, request_id FROM requests WHERE actor_id = 'archived' ORDER BY project_id, request_id",
        [],
      ),
    );
  const before = await archived();
  assert.deepEqual(await board.call("work_update", input), first);
  await rejectsCode(
    board.call("plan_ack", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      plan_revision: 1,
    }),
    "invalid",
  );
  assert.deepEqual(await archived(), before);
  await board.call("work_update", { ...input, request_id: request() });
  assert.deepEqual(await archived(), [
    { project_id: "other", request_id: "other-expired" },
    { project_id: PROJECT, request_id: "recent" },
  ]);
  assert.deepEqual(await board.call("work_update", input), first);
});

for (const retentionMs of [60_000, null]) {
  test(`receipt retention ${retentionMs === null ? "can be disabled" : "uses its configured duration"}`, async (t) => {
    const { path } = await createLedger(t);
    const board = new Board(path, { requestRetentionMs: retentionMs });
    const session = await join(board);
    const project = projectIdSchema.parse(PROJECT);
    await board.database.write(project, (tx) => {
      tx.execute(
        "INSERT INTO requests VALUES (?, 'archived', 'old', 'digest', '{}', ?)",
        [PROJECT, timestamp(Date.now() - 120_000)],
      );
    });
    await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      updates: [],
    });
    assert.equal(
      await board.database.read(
        project,
        (tx) => tx.getRequest("archived", "old") !== undefined,
      ),
      retentionMs === null,
    );
  });
}

test("unexpected stdio tool failures log their cause while clients receive a sanitized error", async (t) => {
  const { path } = await createLedger(t);
  const connection = await openSqlite(path);
  connection.exec("PRAGMA user_version = 2");
  connection.close();
  const cli = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../src/cli.ts" : "../src/cli.js",
      import.meta.url,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--database", path],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "error-diagnostics", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: PROJECT } },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "internal", message: "Internal server error." },
  });
  await client.close();
  assert.match(
    stderr,
    /vibecheck: tool call failed: .*unsupported database schema version 2/,
  );
  assert.equal(JSON.stringify(result).includes(path), false);
});
