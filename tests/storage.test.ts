import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { Database } from "../src/db.js";
import {
  projectIdSchema,
  sessionIdSchema,
  taskIdSchema,
  recordChangeSchema,
} from "../src/schemas.js";
import { openSqlite } from "../src/sqlite.js";

const projectId = projectIdSchema.parse("storage-test");
const sessionId = sessionIdSchema.parse("session");
const taskId = taskIdSchema.parse("task");

async function storage(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vibecheck-storage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "private", "board.sqlite3");
  return { directory, path, database: new Database(path) };
}

async function seed(database: Database) {
  await database.write(projectId, (tx) => {
    tx.actorId = sessionId;
    tx.putSession(sessionId, {
      vendor: "openai",
      runtime: "codex",
      external_session_id: "session",
      parent_session_id: null,
      model: "astra",
      effort: null,
      last_seen_at: tx.now,
    });
    tx.putTask(taskId, {
      label: "original",
      depends_on: [],
      status: "pending",
      owner_work_id: null,
    });
    tx.flush();
  });
}

test("new storage uses schema 1, WAL, and private filesystem permissions", async (t) => {
  const { path, database } = await storage(t);
  await database.read(projectId, (tx) => {
    assert.deepEqual(
      tx.queryRows(
        z.object({ user_version: z.number() }),
        "PRAGMA user_version",
        [],
      ),
      [{ user_version: 1 }],
    );
    assert.deepEqual(
      tx.queryRows(
        z.object({ journal_mode: z.string() }),
        "PRAGMA journal_mode",
        [],
      ),
      [{ journal_mode: "wal" }],
    );
    assert.equal(tx.cursor(), 0);
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
});

test("read transactions reject writes and asynchronous callbacks cannot commit writes", async (t) => {
  const { database } = await storage(t);
  await assert.rejects(
    database.read(projectId, (tx) =>
      tx.putRequest("actor", "read", "digest", {}),
    ),
  );
  await assert.rejects(
    database.write(projectId, async (tx) => {
      tx.putRequest("actor", "async", "digest", {});
    }),
    /callbacks must be synchronous/,
  );
  await database.read(projectId, (tx) => {
    assert.equal(tx.getRequest("actor", "read"), undefined);
    assert.equal(tx.getRequest("actor", "async"), undefined);
  });
});

test("an aborted transaction rolls back records, change batches, and cached responses", async (t) => {
  const { database } = await storage(t);
  await seed(database);
  await assert.rejects(
    database.write(projectId, (tx) => {
      tx.actorId = sessionId;
      tx.putTask(taskId, { ...tx.getTask(taskId), label: "must roll back" });
      tx.flush();
      tx.putRequest("actor", "aborted", "digest", { result: "must roll back" });
      throw new Error("abort transaction");
    }),
    /abort transaction/,
  );
  await database.read(projectId, (tx) => {
    assert.equal(tx.getTask(taskId).label, "original");
    assert.equal(tx.getTask(taskId).revision, 1);
    assert.equal(tx.cursor(), 1);
    assert.equal(tx.getRequest("actor", "aborted"), undefined);
  });
  await database.write(projectId, (tx) => {
    tx.actorId = sessionId;
    const saved = tx.putTask(taskId, {
      ...tx.getTask(taskId),
      label: "next transaction",
    });
    assert.equal(saved.revision, 2);
    assert.equal(tx.flush(), 2);
  });
});

test("mutating a returned record cannot rewrite its stored row or pending event", async (t) => {
  const { database } = await storage(t);
  await seed(database);
  await database.write(projectId, (tx) => {
    tx.actorId = sessionId;
    const saved = tx.putTask(taskId, { ...tx.getTask(taskId), label: "saved" });
    saved.label = "not saved";
    saved.depends_on.push(taskIdSchema.parse("not-saved-dependency"));
    tx.flush();
  });
  await database.read(projectId, (tx) => {
    assert.equal(tx.getTask(taskId).label, "saved");
    assert.deepEqual(tx.getTask(taskId).depends_on, []);
    const row = tx.queryRows(
      z.object({ body: z.string() }),
      "SELECT body FROM changes WHERE seq = 2",
      [],
    )[0];
    assert.ok(row);
    const event = z
      .array(recordChangeSchema)
      .parse(JSON.parse(row.body))
      .find((change) => change.kind === "task");
    assert.ok(event);
    assert.equal(event.record.label, "saved");
    assert.deepEqual(event.record.depends_on, []);
  });
});

test("SQL rows must pass the caller's boundary schema", async (t) => {
  const { database } = await storage(t);
  await database.read(projectId, (tx) => {
    assert.deepEqual(
      tx.queryRows(z.object({ value: z.number() }), "SELECT ? AS value", [7]),
      [{ value: 7 }],
    );
    assert.throws(
      () =>
        tx.queryRows(z.object({ value: z.string() }), "SELECT ? AS value", [7]),
      z.ZodError,
    );
  });
});

test("unsupported schema versions are rejected without replacing existing data", async (t) => {
  const { path, database } = await storage(t);
  await mkdir(dirname(path));
  const connection = await openSqlite(path);
  connection.exec(
    "PRAGMA user_version = 2; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('retained')",
  );
  connection.close();
  await assert.rejects(
    database.read(projectId, (tx) => tx.cursor()),
    /unsupported database schema version 2/,
  );
  const reopened = await openSqlite(path);
  try {
    assert.deepEqual(
      z
        .array(z.object({ value: z.string() }))
        .parse(reopened.all("SELECT value FROM sentinel", [])),
      [{ value: "retained" }],
    );
    assert.deepEqual(
      z
        .array(z.object({ user_version: z.number() }))
        .parse(reopened.all("PRAGMA user_version", [])),
      [{ user_version: 2 }],
    );
  } finally {
    reopened.close();
  }
});

test("a failed first initialization can recover on the same Database instance", async (t) => {
  const { path, database } = await storage(t);
  await mkdir(path, { recursive: true });
  const attempts = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      database.read(projectId, (tx) => tx.cursor()),
    ),
  );
  assert.ok(attempts.every((result) => result.status === "rejected"));
  await rm(path, { recursive: true });
  await database.write(projectId, (tx) =>
    tx.putRequest("actor", "recovered", "digest", { recovered: true }),
  );
  await database.read(projectId, (tx) => {
    assert.deepEqual(tx.getRequest("actor", "recovered"), {
      digest: "digest",
      response: { recovered: true },
    });
  });
});

test(
  "waiting for a write lock leaves timers responsive",
  { timeout: 5_000 },
  async (t) => {
    const { path, database } = await storage(t);
    await database.read(projectId, (tx) => tx.cursor());
    const holder = await openSqlite(path);
    holder.exec("BEGIN IMMEDIATE");
    let released = false;
    const start = performance.now();
    const release = setTimeout(100).then(() => {
      holder.exec("COMMIT");
      released = true;
    });
    try {
      await database.write(projectId, (tx) => {
        assert.equal(released, true);
        tx.putRequest("actor", "after-lock", "digest", {});
      });
      await release;
      assert.ok(
        performance.now() - start < 2_000,
        "lock wait blocked the event loop",
      );
    } finally {
      await release;
      holder.close();
    }
  },
);

function runChild(
  t: TestContext,
  command: string,
  args: string[],
): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const timer = globalThis.setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`${command} exceeded the storage test's 10 second deadline`),
      );
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

test(
  "Bun and Node processes share one WAL database without losing writes",
  { timeout: 20_000 },
  async (t) => {
    const { directory, path, database } = await storage(t);
    let modules = fileURLToPath(new URL("../src/", import.meta.url));
    if (import.meta.url.endsWith(".ts")) {
      const projectRoot = fileURLToPath(new URL("../", import.meta.url));
      modules = join(directory, "compiled");
      await runChild(t, "bun", [
        join(projectRoot, "node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        ...["db", "sqlite", "schemas", "errors"].map((name) =>
          join(projectRoot, "src", `${name}.ts`),
        ),
        "--outDir",
        modules,
        "--module",
        "NodeNext",
        "--target",
        "ES2023",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node,bun",
      ]);
      await symlink(
        join(projectRoot, "node_modules"),
        join(directory, "node_modules"),
      );
      await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    }
    const worker = join(directory, "worker.mjs");
    await writeFile(
      worker,
      `
import { Database } from ${JSON.stringify(pathToFileURL(join(modules, "db.js")).href)};
import { projectIdSchema } from ${JSON.stringify(pathToFileURL(join(modules, "schemas.js")).href)};
const database = new Database(process.argv[2]);
const project = projectIdSchema.parse("storage-test");
for (let index = 0; index < 100; index++) {
  await database.write(project, (tx) => tx.putRequest(String(process.pid), String(index), "digest", { index }));
}
`,
    );
    await Promise.all(
      ["bun", "node", "bun", "node"].map((runtime) =>
        runChild(t, runtime, [worker, path]),
      ),
    );
    await database.read(projectId, (tx) => {
      assert.deepEqual(
        tx.queryRows(
          z.object({ count: z.number() }),
          "SELECT COUNT(*) AS count FROM requests",
          [],
        ),
        [{ count: 400 }],
      );
      assert.deepEqual(
        tx.queryRows(
          z.object({ count: z.number() }),
          "SELECT COUNT(DISTINCT actor_id) AS count FROM requests",
          [],
        ),
        [{ count: 4 }],
      );
    });
  },
);
