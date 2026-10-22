import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Board } from "./board.js";
import { ActivityStore } from "./activity.js";
import { CodexCollector } from "./codex-collector.js";
import { BoardError } from "./errors.js";
import { worktreeSchema } from "./activity-contracts.js";

export type AccessRole = "manager" | "collector" | "observer";
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new BoardError("invalid", "Use application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 2_000_000)
      throw new BoardError("invalid", "Request exceeds 2 MB");
    chunks.push(bytes);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}
export class ActivityHttp {
  readonly store: ActivityStore;
  private initialization: Promise<void> | undefined;
  private collectors = new Map<string, CodexCollector>();
  private streams = new Set<ServerResponse>();
  constructor(
    readonly board: Board,
    readonly projects?: ReadonlySet<string>,
  ) {
    this.store = new ActivityStore(board);
  }
  async close() {
    for (const response of this.streams) response.end();
    await Promise.all([...this.collectors.values()].map((c) => c.close()));
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    role: AccessRole,
  ): Promise<void> {
    const send = (status: number, result: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(result));
    };
    try {
      await (this.initialization ??= this.store.initialize());
      const url = new URL(request.url ?? "/", "http://localhost");
      const match =
        /^\/v1\/projects\/([^/]+)\/(snapshot|events|stream|setup|command|sources|worktrees|activity|artifacts|codex|prune)(?:\/([^/]+))?$/.exec(
          url.pathname,
        );
      if (!match) {
        send(404, { error: "not_found" });
        return;
      }
      const project = decodeURIComponent(match[1] ?? "");
      const route = match[2];
      if (this.projects && !this.projects.has(project))
        throw new BoardError(
          "forbidden",
          "Project is not permitted by this server",
        );
      if (request.method !== "GET" && request.method !== "POST") {
        send(405, { error: "method_not_allowed" });
        return;
      }
      if (
        request.method === "POST" &&
        (role === "observer" ||
          (role === "collector" &&
            !["activity", "artifacts", "sources", "command"].includes(
              route ?? "",
            )))
      )
        throw new BoardError(
          "forbidden",
          "This credential cannot manage project work",
        );
      if (request.method === "GET") {
        if (route === "snapshot") {
          await this.restore(project);
          send(200, await this.store.snapshot(project));
          return;
        }
        if (route === "events") {
          send(
            200,
            await this.store.events(project, {
              since: Number(url.searchParams.get("since") ?? 0),
              limit: Number(url.searchParams.get("limit") ?? 100),
              ...(url.searchParams.has("session_id")
                ? { session_id: url.searchParams.get("session_id") }
                : {}),
              ...(url.searchParams.has("instance_id")
                ? { instance_id: url.searchParams.get("instance_id") }
                : {}),
            }),
          );
          return;
        }
        if (route === "artifacts" && match[3]) {
          send(
            200,
            await this.store.getArtifact(project, decodeURIComponent(match[3])),
          );
          return;
        }
        if (route === "stream") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          this.streams.add(response);
          let previous = "",
            busy = false;
          const update = async () => {
            if (busy || response.destroyed) return;
            busy = true;
            try {
              const snapshot = await this.store.snapshot(project);
              const next = JSON.stringify({
                instance_id: snapshot.instance_id,
                cursor: snapshot.cursor,
                activity_cursor: snapshot.activity_cursor,
                sources: snapshot.sources,
              });
              if (next !== previous) {
                previous = next;
                response.write("event: change\ndata: " + next + "\n\n");
              } else response.write(": heartbeat\n\n");
            } catch {
              response.write("event: reset\ndata: {}\n\n");
            } finally {
              busy = false;
            }
          };
          await update();
          const timer = setInterval(() => void update(), 1000);
          response.on("close", () => {
            clearInterval(timer);
            this.streams.delete(response);
          });
          return;
        }
        send(404, { error: "not_found" });
        return;
      }
      const input = await body(request);
      if (route === "setup") {
        const config = z
          .strictObject({
            repository: z.string().min(1).max(500),
            workspace_id: z.string().min(1).max(200),
            root: z.string().min(1).max(500),
            display_name: z
              .string()
              .min(1)
              .max(500)
              .default("Workspace operator"),
          })
          .parse(input);
        const joined = await this.board.call("project_join", {
          project_id: project,
          request_id: randomUUID(),
          repository: config.repository,
          vendor: "local",
          runtime: "operator",
          external_session_id: config.workspace_id,
          model: "not-applicable",
          actor_kind: "human",
          display_name: config.display_name,
        });
        const tree = await this.store.worktree(project, {
          id: "worktree:" + config.workspace_id,
          repository: config.repository,
          root: config.root,
        });
        send(200, { operator_id: joined.session_id, worktree: tree });
        return;
      }
      if (route === "command") {
        const command = z
          .strictObject({
            tool: z.string(),
            request: z.record(z.string(), z.unknown()),
          })
          .parse(input);
        if (command.request.project_id !== project)
          throw new BoardError("invalid", "Command project mismatch");
        if (
          role === "collector" &&
          (![
            "project_join",
            "work_claim",
            "work_update",
            "plan_ack",
            "project_status",
            "plan_read",
            "work_history",
          ].includes(command.tool) ||
            command.request.actor_kind === "human")
        )
          throw new BoardError(
            "forbidden",
            "Collector cannot manage plans or act as a human operator",
          );
        send(200, await this.board.call(command.tool, command.request));
        return;
      }
      if (route === "prune") {
        const retention = z
          .strictObject({ days: z.number().int().min(1).max(3650) })
          .parse(input);
        send(200, await this.store.prune(project, retention.days));
        return;
      }
      if (route === "sources") {
        send(200, await this.store.source(project, input));
        return;
      }
      if (route === "worktrees") {
        send(200, await this.store.worktree(project, input));
        return;
      }
      if (route === "activity") {
        send(200, await this.store.ingest(project, input));
        return;
      }
      if (route === "artifacts") {
        send(200, await this.store.artifact(project, input));
        return;
      }
      if (route === "codex") {
        const config = z
          .strictObject({ enabled: z.boolean(), worktree_id: z.string() })
          .parse(input);
        await this.collectors.get(project)?.close();
        this.collectors.delete(project);
        await this.store.saveCheckpoint(
          project,
          "codex:config",
          JSON.stringify(config),
        );
        if (config.enabled) await this.restore(project);
        else
          await this.store.source(project, {
            id: "codex",
            name: "Codex local sessions",
            capabilities: [],
            status: "disconnected",
            detail: "Collection disabled",
          });
        send(200, { enabled: config.enabled });
        return;
      }
      send(404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const code =
        error instanceof BoardError
          ? error.code
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? "invalid"
            : "internal";
      send(
        code === "forbidden"
          ? 403
          : code === "not_found"
            ? 404
            : code === "conflict"
              ? 409
              : code === "invalid"
                ? 400
                : 500,
        {
          error: {
            code,
            message:
              error instanceof BoardError
                ? error.message
                : code === "invalid"
                  ? "Invalid activity request"
                  : "Internal server error",
          },
        },
      );
    }
  }
  private async restore(project: string) {
    if (this.collectors.has(project)) return;
    const saved = await this.store.checkpoint(project, "codex:config");
    if (!saved) return;
    const config = z
      .object({ enabled: z.boolean(), worktree_id: z.string() })
      .parse(JSON.parse(saved));
    if (!config.enabled) return;
    const snapshot = await this.store.snapshot(project);
    const tree = snapshot.worktrees.find((t) => t.id === config.worktree_id);
    if (!tree)
      throw new BoardError("not_found", "Configured worktree is unavailable");
    const collector = new CodexCollector(
      this.store,
      project,
      worktreeSchema.parse(tree),
    );
    this.collectors.set(project, collector);
    collector.start();
  }
}
