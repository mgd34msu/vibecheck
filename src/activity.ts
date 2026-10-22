import { randomUUID } from "node:crypto";
import { z } from "zod";
import { workIdSchema, sessionIdSchema } from "./schemas.js";
import type { Board } from "./board.js";
import { encode, type Transaction } from "./db.js";
import { BoardError } from "./errors.js";
import { compactStatus } from "./queries.js";
import { projectIdSchema, type ProjectId } from "./schemas.js";
import {
  activityEventSchema,
  activitySessionSchema,
  artifactSchema,
  ingestSchema,
  sourceSchema,
  worktreeSchema,
  type ActivityEvent,
  type ActivitySession,
} from "./activity-contracts.js";

const bodyRow = z.object({ body: z.string() });
const eventRow = z.object({
  seq: z.number(),
  received_at: z.string(),
  body: z.string(),
});
const counterRow = z.object({ cursor: z.number() });
const valueRow = z.object({ value: z.string() });
const eventsQuerySchema = z.strictObject({
  since: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
  session_id: z.string().optional(),
  worktree_id: z.string().optional(),
  paths: z.array(z.string()).max(500).optional(),
  instance_id: z.string().optional(),
});
function instance(tx: Transaction): string {
  const row = tx.queryRows(
    valueRow,
    "SELECT value FROM activity_meta WHERE key='instance_id'",
    [],
  )[0];
  if (!row) throw new Error("Missing activity instance identity");
  return row.value;
}
function cursor(tx: Transaction): number {
  return (
    tx.queryRows(
      counterRow,
      "SELECT COALESCE(MAX(seq),0) AS cursor FROM activity_events WHERE project_id=?",
      [tx.projectId],
    )[0]?.cursor ?? 0
  );
}
function rowBody<T>(
  tx: Transaction,
  schema: z.ZodType<T>,
  table: string,
  id: string,
): T {
  const row = tx.queryRows(
    bodyRow,
    `SELECT body FROM ${table} WHERE project_id=? AND id=?`,
    [tx.projectId, id],
  )[0];
  if (!row) throw new BoardError("not_found", "Activity record was not found");
  return schema.parse(JSON.parse(row.body));
}
export class ActivityStore {
  constructor(readonly board: Board) {}
  private project(value: string): ProjectId {
    return projectIdSchema.parse(value);
  }
  async initialize(): Promise<void> {
    await this.board.database.write(
      this.project("activity-initialization"),
      (tx) => {
        const version = tx.queryRows(
          valueRow,
          "SELECT value FROM activity_meta WHERE key='schema_version'",
          [],
        )[0];
        if (version && version.value !== "1")
          throw new Error("Unsupported activity schema version");
        tx.execute(
          "INSERT OR IGNORE INTO activity_meta VALUES ('schema_version','1')",
          [],
        );
        tx.execute(
          "INSERT OR IGNORE INTO activity_meta VALUES ('instance_id',?)",
          [randomUUID()],
        );
      },
    );
  }
  async source(project: string, input: unknown) {
    const source = sourceSchema.parse(input);
    return this.board.database.write(this.project(project), (tx) => {
      tx.getProject(tx.projectId);
      tx.execute(
        "INSERT INTO activity_sources VALUES (?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
        [tx.projectId, source.id, encode(source), tx.now],
      );
      return source;
    });
  }
  async worktree(project: string, input: unknown) {
    const tree = worktreeSchema.parse(input);
    return this.board.database.write(this.project(project), (tx) => {
      if (tx.getProject(tx.projectId).repository !== tree.repository)
        throw new BoardError(
          "conflict",
          "Worktree repository does not match project",
        );
      const prior = tx.queryRows(
        bodyRow,
        "SELECT body FROM activity_worktrees WHERE project_id=? AND id=?",
        [tx.projectId, tree.id],
      )[0];
      if (prior) {
        const previous = worktreeSchema.parse(JSON.parse(prior.body));
        if (
          previous.root !== tree.root ||
          previous.repository !== tree.repository
        )
          throw new BoardError(
            "conflict",
            "Worktree identity cannot be reassigned",
          );
      }
      tx.execute(
        "INSERT INTO activity_worktrees VALUES (?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body",
        [tx.projectId, tree.id, encode(tree)],
      );
      return tree;
    });
  }
  async ingest(project: string, input: unknown) {
    const request = ingestSchema.parse(input);
    return this.board.database.write(this.project(project), (tx) => {
      tx.getProject(tx.projectId);
      let inserted = 0;
      for (const event of request.events) {
        tx.getSession(event.session_id);
        if (event.actor_id) tx.getSession(event.actor_id);
        if (
          event.work_id &&
          tx.getWork(event.work_id).session_id !== event.session_id
        )
          throw new BoardError(
            "conflict",
            "Activity work belongs to another session",
          );
        rowBody(tx, sourceSchema, "activity_sources", event.source_id);
        rowBody(tx, worktreeSchema, "activity_worktrees", event.worktree_id);
        const body = encode(event);
        const prior = tx.queryRows(
          bodyRow,
          "SELECT body FROM activity_events WHERE project_id=? AND id=?",
          [tx.projectId, event.id],
        )[0];
        if (prior) {
          if (prior.body !== body)
            throw new BoardError(
              "conflict",
              "Activity event ID was reused with different content",
            );
          continue;
        }
        tx.execute(
          "INSERT INTO activity_events(project_id,id,source_id,session_id,worktree_id,occurred_at,received_at,body) VALUES (?,?,?,?,?,?,?,?)",
          [
            tx.projectId,
            event.id,
            event.source_id,
            event.session_id,
            event.worktree_id,
            event.occurred_at,
            tx.now,
            body,
          ],
        );
        this.updateSession(tx, event);
        inserted++;
      }
      return { inserted, cursor: cursor(tx), instance_id: instance(tx) };
    });
  }
  private updateSession(tx: Transaction, event: ActivityEvent) {
    const prior = tx.queryRows(
      bodyRow,
      "SELECT body FROM activity_sessions WHERE project_id=? AND id=?",
      [tx.projectId, event.session_id],
    )[0];
    const old = prior
      ? activitySessionSchema.parse(JSON.parse(prior.body))
      : undefined;
    if (old && Date.parse(old.updated_at) > Date.parse(event.occurred_at))
      return;
    const next: ActivitySession = {
      session_id: event.session_id,
      source_id: event.source_id,
      worktree_id: event.worktree_id,
      state: event.state ?? old?.state ?? "unknown",
      started_at: old?.started_at ?? event.occurred_at,
      updated_at: event.occurred_at,
      summary: event.summary || old?.summary || "",
      ...(event.run_id
        ? { run_id: event.run_id }
        : old?.run_id
          ? { run_id: old.run_id }
          : {}),
      ...(event.kind === "operation_finished" || event.kind === "turn_finished"
        ? {}
        : event.operation
          ? { operation: event.operation }
          : old?.operation
            ? { operation: old.operation }
            : {}),
    };
    tx.execute(
      "INSERT INTO activity_sessions VALUES (?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body",
      [tx.projectId, event.session_id, encode(next)],
    );
  }
  snapshot(project: string) {
    return this.board.database.read(this.project(project), (tx) => {
      const ledger = compactStatus(tx, {
        project_id: tx.projectId,
        full: true,
      });
      const sources = tx
        .queryRows(
          z.object({ body: z.string(), updated_at: z.string() }),
          "SELECT body,updated_at FROM activity_sources WHERE project_id=? ORDER BY id",
          [tx.projectId],
        )
        .map((row) => ({
          ...sourceSchema.parse(JSON.parse(row.body)),
          updated_at: row.updated_at,
        }));
      const worktrees = tx
        .queryRows(
          bodyRow,
          "SELECT body FROM activity_worktrees WHERE project_id=? ORDER BY id",
          [tx.projectId],
        )
        .map((row) => worktreeSchema.parse(JSON.parse(row.body)));
      const activity = tx
        .queryRows(
          bodyRow,
          "SELECT body FROM activity_sessions WHERE project_id=? ORDER BY id",
          [tx.projectId],
        )
        .map((row) => activitySessionSchema.parse(JSON.parse(row.body)));
      const files = tx
        .queryRows(
          bodyRow,
          "SELECT body FROM activity_events WHERE project_id=? AND json_array_length(body,'$.paths')>0 ORDER BY julianday(occurred_at) DESC,seq DESC LIMIT 10001",
          [tx.projectId],
        )
        .map((row) => activityEventSchema.parse(JSON.parse(row.body)))
        .filter((event) => event.paths.length > 0);
      const retention = tx.queryRows(
        bodyRow,
        "SELECT body FROM activity_checkpoints WHERE project_id=? AND id='history-retention'",
        [tx.projectId],
      )[0];
      return {
        version: 1,
        instance_id: instance(tx),
        activity_cursor: cursor(tx),
        ...ledger,
        sources,
        worktrees,
        activity,
        files: files.slice(0, 10000),
        files_limited: files.length > 10000,
        ...(retention ? { history_retention: JSON.parse(retention.body) } : {}),
      };
    });
  }
  async assertCollectorActor(
    project: string,
    request: Record<string, unknown>,
  ) {
    if (request.take_over_from != null)
      throw new BoardError(
        "forbidden",
        "Collectors cannot change project coordination",
      );
    return this.board.database.read(this.project(project), (tx) => {
      const existing = tx
        .allSessions()
        .find(
          (session) =>
            session.id === request.session_id ||
            (session.vendor === request.vendor &&
              session.runtime === request.runtime &&
              session.external_session_id === request.external_session_id),
        );
      if (existing?.actor_kind === "human")
        throw new BoardError(
          "forbidden",
          "Collector cannot act as a human operator",
        );
    });
  }
  events(project: string, input: unknown) {
    const request = eventsQuerySchema.parse(input);
    return this.board.database.read(this.project(project), (tx) => {
      tx.getProject(tx.projectId);
      if (
        (request.instance_id && request.instance_id !== instance(tx)) ||
        request.since > cursor(tx)
      )
        throw new BoardError(
          "conflict",
          "Activity cursor reset; request a complete snapshot",
        );
      const rows = tx.queryRows(
        eventRow,
        "SELECT seq,received_at,body FROM activity_events WHERE project_id=? AND seq>? AND (? IS NULL OR session_id=?) AND (? IS NULL OR worktree_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(activity_events.body,'$.paths') p WHERE p.value IN (SELECT value FROM json_each(?)))) ORDER BY seq LIMIT ?",
        [
          tx.projectId,
          request.since,
          request.session_id ?? null,
          request.session_id ?? null,
          request.worktree_id ?? null,
          request.worktree_id ?? null,
          request.paths ? encode(request.paths) : null,
          request.paths ? encode(request.paths) : null,
          request.limit + 1,
        ],
      );
      const page = rows.slice(0, request.limit).map((row) => ({
        seq: row.seq,
        received_at: row.received_at,
        ...activityEventSchema.parse(JSON.parse(row.body)),
      }));
      return {
        instance_id: instance(tx),
        events: page,
        cursor: page.at(-1)?.seq ?? request.since,
        has_more: rows.length > request.limit,
      };
    });
  }
  async artifact(project: string, input: unknown) {
    const artifact = artifactSchema.parse(input);
    return this.board.database.write(this.project(project), (tx) => {
      tx.getSession(artifact.session_id);
      if (
        artifact.work_id &&
        tx.getWork(artifact.work_id).session_id !== artifact.session_id
      )
        throw new BoardError(
          "conflict",
          "Artifact work belongs to another session",
        );
      const prior = tx.queryRows(
        bodyRow,
        "SELECT body FROM activity_artifacts WHERE project_id=? AND id=?",
        [tx.projectId, artifact.id],
      )[0];
      if (prior && prior.body !== encode(artifact))
        throw new BoardError("conflict", "Artifact versions are immutable");
      tx.execute(
        "INSERT OR IGNORE INTO activity_artifacts VALUES (?,?,?,?,?)",
        [
          tx.projectId,
          artifact.id,
          artifact.session_id,
          tx.now,
          encode(artifact),
        ],
      );
      return { id: artifact.id };
    });
  }
  async prune(project: string, days: number) {
    const retained = z.number().int().min(1).max(3650).parse(days);
    const cutoff = new Date(Date.now() - retained * 86400000).toISOString();
    return this.board.database.write(this.project(project), (tx) => {
      tx.getProject(tx.projectId);
      tx.execute(
        "DELETE FROM activity_events WHERE project_id=? AND received_at<?",
        [tx.projectId, cutoff],
      );
      tx.execute(
        "DELETE FROM activity_artifacts WHERE project_id=? AND created_at<?",
        [tx.projectId, cutoff],
      );
      tx.execute(
        "INSERT INTO activity_checkpoints VALUES (?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body",
        [
          tx.projectId,
          "history-retention",
          JSON.stringify({ retained_from: cutoff, days: retained }),
        ],
      );
      return { retained_from: cutoff, days: retained };
    });
  }
  getArtifact(project: string, id: string) {
    return this.board.database.read(this.project(project), (tx) =>
      rowBody(tx, artifactSchema, "activity_artifacts", id),
    );
  }
  artifacts(project: string, input: unknown) {
    const request = z
      .strictObject({
        work_id: workIdSchema.optional(),
        session_id: sessionIdSchema.optional(),
        after: z.string().default(""),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .parse(input);
    return this.board.database.read(this.project(project), (tx) => {
      tx.getProject(tx.projectId);
      if (request.work_id) tx.getWork(request.work_id);
      if (request.session_id) tx.getSession(request.session_id);
      const rows = tx.queryRows(
        bodyRow,
        `SELECT body FROM activity_artifacts WHERE project_id=? AND id>?
        AND (? IS NULL OR session_id=?) AND (? IS NULL OR json_extract(body,'$.work_id')=?)
        ORDER BY id LIMIT ?`,
        [
          tx.projectId,
          request.after,
          request.session_id ?? null,
          request.session_id ?? null,
          request.work_id ?? null,
          request.work_id ?? null,
          request.limit + 1,
        ],
      );
      const artifacts = rows.slice(0, request.limit).map((row) => {
        const { text: _text, ...metadata } = artifactSchema.parse(
          JSON.parse(row.body),
        );
        return metadata;
      });
      return {
        artifacts,
        cursor: artifacts.at(-1)?.id ?? request.after,
        has_more: rows.length > request.limit,
      };
    });
  }
  checkpoint(project: string, id: string) {
    return this.board.database.read(
      this.project(project),
      (tx) =>
        tx.queryRows(
          bodyRow,
          "SELECT body FROM activity_checkpoints WHERE project_id=? AND id=?",
          [tx.projectId, id],
        )[0]?.body,
    );
  }
  saveCheckpoint(project: string, id: string, body: string) {
    return this.board.database.write(this.project(project), (tx) => {
      tx.execute(
        "INSERT INTO activity_checkpoints VALUES (?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body",
        [tx.projectId, id, body],
      );
    });
  }
}
