import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { ActivityStore } from "./activity.js";
import {
  activityEventSchema,
  type ActivityEvent,
  type ActivityWorktree,
} from "./activity-contracts.js";
import { sessionIdSchema, type SessionId } from "./schemas.js";

const object = z.record(z.string(), z.unknown());
const checkpointSchema = z.object({
  offset: z.number(),
  session_id: sessionIdSchema,
  external_id: z.string(),
  model: z.string(),
  backfill_offset: z.number().int().nonnegative().optional(),
  backfill_end: z.number().int().nonnegative().optional(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
const CHUNK_BYTES = 2_000_000;
const MAX_RECORD_BYTES = 64_000_000;
const short = (value: unknown, limit = 4000) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function sessionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isSymbolicLink()) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(file)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files.sort();
}
/** Observed Codex JSONL format. Unsupported records, instructions and reasoning are excluded. */
export class CodexCollector {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private registered = false;
  readonly directory: string;
  constructor(
    readonly store: ActivityStore,
    readonly project: string,
    readonly worktree: ActivityWorktree,
    directory?: string,
  ) {
    this.directory =
      directory ??
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  }
  start() {
    this.timer = setInterval(() => void this.poll(), 1000);
    void this.poll();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async poll() {
    if (this.running || this.stopped) return;
    this.running = this.collect()
      .catch(async (error) => {
        await this.store
          .source(this.project, {
            id: "codex",
            name: "Codex local sessions",
            capabilities: [
              "identity",
              "lifecycle",
              "files",
              "messages",
              "tools",
            ],
            status: "error",
            detail: short(
              error instanceof Error ? error.message : "Collector failed",
              500,
            ),
          })
          .catch(() => {});
      })
      .finally(() => {
        this.running = undefined;
      });
    await this.running;
  }
  private async collect() {
    const root = await realpath(this.worktree.root);
    if (!this.registered) {
      await this.store.source(this.project, {
        id: "codex",
        name: "Codex local sessions",
        capabilities: ["identity", "lifecycle", "files", "messages", "tools"],
        status: "connected",
        detail: "Checking local session records.",
      });
      this.registered = true;
    }
    const files = await sessionFiles(this.directory);
    const errors: string[] = [];
    let matched = 0,
      backfilling = false;
    for (const file of files) {
      if (this.stopped) return;
      const handle = await open(file, "r").catch((error: unknown) => {
        errors.push(
          error instanceof Error
            ? error.message
            : "Unable to open Codex session.",
        );
        return null;
      });
      if (!handle) continue;
      try {
        const first = Buffer.alloc(262144);
        const { bytesRead } = await handle.read(first, 0, first.length, 0);
        const firstLine = first
          .subarray(0, bytesRead)
          .toString("utf8")
          .split("\n")[0];
        if (!firstLine) continue;
        let header: Record<string, unknown>;
        try {
          const parsed = object.parse(JSON.parse(firstLine));
          if (parsed.type !== "session_meta") continue;
          header = object.parse(parsed.payload);
        } catch {
          continue;
        }
        if (
          typeof header.cwd !== "string" ||
          (await realpath(header.cwd).catch(() => "")) !== root
        )
          continue;
        const externalId = short(header.session_id) || short(header.id);
        if (!externalId) continue;
        matched++;
        const checkpointId = "codex:" + digest(file + firstLine).slice(0, 32);
        const saved = await this.store.checkpoint(this.project, checkpointId);
        let checkpoint = saved
          ? checkpointSchema.parse(JSON.parse(saved))
          : undefined;
        const stats = await handle.stat();
        if (checkpoint && checkpoint.offset > stats.size)
          throw new Error(
            "A Codex session file was truncated; history requires reconciliation.",
          );
        if (!checkpoint) {
          const joined = await this.store.board.call("project_join", {
            project_id: this.project,
            request_id: "codex-join:" + digest(externalId).slice(0, 32),
            repository: this.worktree.repository,
            vendor: "openai",
            runtime: "codex",
            external_session_id: externalId,
            model: "unknown",
            actor_kind: "agent",
            display_name: "Codex " + externalId.slice(0, 8),
          });
          checkpoint = {
            offset: Buffer.byteLength(firstLine) + 1,
            session_id: joined.session_id,
            external_id: externalId,
            model: "unknown",
          };
        }
        // Follow the live tail first, while preserving a separate historical cursor.
        // Existing checkpoints upgrade in place; replay retains byte-offset event IDs.
        if (stats.size - checkpoint.offset > CHUNK_BYTES * 2) {
          const seek = stats.size - CHUNK_BYTES;
          const tail = Buffer.alloc(CHUNK_BYTES);
          const read = await handle.read(tail, 0, tail.length, seek);
          const newline = tail.subarray(0, read.bytesRead).indexOf(10);
          if (newline >= 0) {
            checkpoint.backfill_offset ??= checkpoint.offset;
            checkpoint.backfill_end = seek + newline + 1;
            checkpoint.offset = checkpoint.backfill_end;
          }
        }
        const ingestRange = async (
          checkpoint: Checkpoint,
          endOffset: number,
          isLive: boolean,
        ) => {
          // Most chunks stay small. A single complete record may be larger than
          // a chunk (for example a tool output or compacted context record).
          let budget = CHUNK_BYTES;
          let bytes: Buffer;
          let end: number;
          for (;;) {
            bytes = Buffer.alloc(
              Math.min(budget, Math.max(0, endOffset - checkpoint.offset)),
            );
            if (!bytes.length) return;
            const read = await handle.read(
              bytes,
              0,
              bytes.length,
              checkpoint.offset,
            );
            end = bytes.subarray(0, read.bytesRead).lastIndexOf(10);
            if (end >= 0) break;
            if (read.bytesRead < budget) return; // Incomplete trailing record.
            if (budget >= MAX_RECORD_BYTES)
              throw new Error(
                "A Codex session record exceeds the 64 MB ingestion limit.",
              );
            budget = Math.min(MAX_RECORD_BYTES, budget * 2);
          }
          const lines = bytes
            .subarray(0, end + 1)
            .toString("utf8")
            .split("\n");
          const events: ActivityEvent[] = [];
          for (const line of lines) {
            if (!line) continue;
            const offset = checkpoint.offset;
            checkpoint.offset += Buffer.byteLength(line) + 1;
            let record: Record<string, unknown>;
            try {
              record = object.parse(JSON.parse(line));
            } catch {
              continue;
            }
            const payload = object.safeParse(record.payload);
            if (!payload.success) continue;
            const data = payload.data;
            if (
              isLive &&
              record.type === "turn_context" &&
              typeof data.model === "string" &&
              data.model !== checkpoint.model
            ) {
              await this.store.board.call("project_join", {
                project_id: this.project,
                request_id:
                  "codex-model:" + digest(externalId + data.model).slice(0, 32),
                repository: this.worktree.repository,
                vendor: "openai",
                runtime: "codex",
                external_session_id: externalId,
                model: data.model,
                ...(typeof data.effort === "string"
                  ? { effort: data.effort }
                  : {}),
              });
              checkpoint.model = data.model;
            }
            const translated = this.translate(
              record,
              data,
              checkpoint.session_id,
              externalId,
              offset,
              root,
            );
            const firstEvent = translated[0];
            if (
              firstEvent &&
              ["message", "operation_started", "operation_finished"].includes(
                firstEvent.kind,
              )
            ) {
              let text = "";
              if (firstEvent.kind === "message") {
                const parts = z.array(z.unknown()).safeParse(data.content);
                if (parts.success)
                  text = parts.data
                    .flatMap((part) => {
                      const parsed = object.safeParse(part);
                      return parsed.success &&
                        typeof parsed.data.text === "string"
                        ? [parsed.data.text]
                        : [];
                    })
                    .join("\n");
              } else if (firstEvent.kind === "operation_started")
                text = short(data.input ?? data.arguments, 1_000_000);
              else
                text =
                  typeof data.output === "string"
                    ? data.output
                    : (JSON.stringify(data.output) ?? "");
              const id =
                "codex-artifact:" +
                digest(externalId + ":" + offset).slice(0, 48);
              if (text) {
                await this.store.artifact(this.project, {
                  id,
                  session_id: checkpoint.session_id,
                  kind:
                    firstEvent.kind === "message" ? "message" : "tool_output",
                  title:
                    firstEvent.kind +
                    (text.length > 1_000_000 ? " (truncated at 1 MB)" : ""),
                  text: text.slice(0, 1_000_000),
                });
                firstEvent.artifact_id = id;
              }
            }
            events.push(...translated);
            if (events.length >= 150)
              await this.store.ingest(this.project, {
                events: events.splice(0),
              });
          }
          if (events.length) await this.store.ingest(this.project, { events });
        };
        await ingestRange(checkpoint, stats.size, true);
        // Commit live progress even if a historical record cannot be imported.
        await this.store.saveCheckpoint(
          this.project,
          checkpointId,
          JSON.stringify(checkpoint),
        );
        if (
          checkpoint.backfill_offset !== undefined &&
          checkpoint.backfill_end !== undefined
        ) {
          const history = { ...checkpoint, offset: checkpoint.backfill_offset };
          await ingestRange(history, checkpoint.backfill_end, false);
          checkpoint.backfill_offset = history.offset;
          if (history.offset >= checkpoint.backfill_end) {
            delete checkpoint.backfill_offset;
            delete checkpoint.backfill_end;
          }
        }
        backfilling ||= checkpoint.backfill_offset !== undefined;
        await this.store.saveCheckpoint(
          this.project,
          checkpointId,
          JSON.stringify(checkpoint),
        );
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error.message
            : "Codex session import failed.",
        );
      } finally {
        await handle.close();
      }
    }
    await this.store.source(this.project, {
      id: "codex",
      name: "Codex local sessions",
      capabilities: ["identity", "lifecycle", "files", "messages", "tools"],
      status: errors.length || !files.length ? "error" : "connected",
      detail: errors.length
        ? short(errors.join("; "), 500)
        : !files.length
          ? "No local Codex session records are available."
          : !matched
            ? "No Codex sessions match this workspace root."
            : backfilling
              ? "Collecting live activity; importing older session history in the background."
              : `Following ${matched} Codex session${matched === 1 ? "" : "s"} for this workspace.`,
    });
  }
  private translate(
    record: Record<string, unknown>,
    data: Record<string, unknown>,
    session: SessionId,
    externalId: string,
    offset: number,
    root: string,
  ): ActivityEvent[] {
    const time = z.iso.datetime({ offset: true }).safeParse(record.timestamp);
    if (!time.success) return [];
    const common = {
      source_id: "codex",
      session_id: session,
      worktree_id: this.worktree.id,
      occurred_at: time.data,
      basis: "host_event",
    };
    const events: unknown[] = [];
    if (
      record.type === "event_msg" &&
      (data.type === "task_started" || data.type === "task_complete")
    )
      events.push({
        ...common,
        kind: data.type === "task_started" ? "turn_started" : "turn_finished",
        state: data.type === "task_started" ? "running" : "idle",
        ...(typeof data.turn_id === "string" ? { run_id: data.turn_id } : {}),
        summary:
          data.type === "task_started" ? "Turn started" : "Turn completed",
      });
    if (
      record.type === "response_item" &&
      data.type === "message" &&
      (data.role === "user" ||
        (data.role === "assistant" &&
          (data.phase === "commentary" ||
            data.phase === "final_answer" ||
            data.phase === "final")))
    ) {
      const content = z.array(z.unknown()).safeParse(data.content);
      const text = content.success
        ? content.data
            .flatMap((part) => {
              const p = object.safeParse(part);
              return p.success && typeof p.data.text === "string"
                ? [p.data.text]
                : [];
            })
            .join("\n")
        : "";
      if (text)
        events.push({ ...common, kind: "message", summary: short(text) });
    }
    if (
      record.type === "response_item" &&
      (data.type === "custom_tool_call" || data.type === "function_call")
    ) {
      const name = short(data.name, 500) || "Tool";
      const input = short(data.input ?? data.arguments, 500000);
      events.push({
        ...common,
        kind: "operation_started",
        operation: name,
        summary: short(name + "\n" + input),
      });
      // Parse only explicit patch headers. Shell commands and filesystem changes never establish their writer.
      for (const match of input.matchAll(
        /\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)(?:\\n|\n)/g,
      )) {
        const named = match[1]?.trim();
        if (!named) continue;
        const local = named.startsWith("/") ? relative(root, named) : named;
        if (
          !local ||
          local.startsWith("../") ||
          local.startsWith("/") ||
          local.includes("\\") ||
          local.split("/").some((p) => p === ".." || p === ".")
        )
          continue;
        events.push({
          ...common,
          kind: "operation_started",
          operation: "Requested patch",
          paths: [local],
          summary:
            "Patch requested by the host tool; successful byte changes are not established by this event.",
        });
      }
    }
    if (
      record.type === "response_item" &&
      (data.type === "custom_tool_call_output" ||
        data.type === "function_call_output")
    ) {
      const output =
        typeof data.output === "string"
          ? data.output
          : JSON.stringify(data.output);
      events.push({
        ...common,
        kind: "operation_finished",
        summary: short(output),
      });
    }
    return events.map((event, index) =>
      activityEventSchema.parse({
        ...object.parse(event),
        id:
          "codex:" +
          digest(externalId + ":" + offset + ":" + index).slice(0, 48),
      }),
    );
  }
}
