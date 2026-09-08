import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import type { Board } from "./board.js";
import { BoardError } from "./errors.js";
import { requestSchemas } from "./schemas.js";
import { version } from "./version.js";

export type Ledger = Pick<Board, "call">;

export function createServer(
  board: Ledger,
  projects?: ReadonlySet<string>,
): McpServer {
  const server = new McpServer(
    { name: "project-board", version },
    {
      instructions:
        "Passive project ledger. Use project_join to establish a session, then project_status for compact current work. The coordinator publishes or edits the shared plan. Use plan_read for a plan revision or revision comparison and plan_ack to record the revision you observed. Claim and update work explicitly. Request full=true for complete current status, or include_map=true for the task map. This server never executes or schedules work.",
    },
  );
  async function invoke(
    projectId: string,
    call: () => Promise<object>,
  ): Promise<CallToolResult> {
    try {
      if (projects !== undefined && !projects.has(projectId)) {
        throw new BoardError(
          "forbidden",
          "Project is not permitted by this server.",
        );
      }
      const result = { ...(await call()) };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      };
    } catch (error) {
      const result = {
        error:
          error instanceof BoardError
            ? error.asDict()
            : { code: "internal", message: "Internal server error." },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: true,
      };
    }
  }
  const write: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
  server.registerTool(
    "project_join",
    {
      description:
        "Join with explicit session identity and optional parent; return compact status with map recovery.",
      inputSchema: z.object({ request: requestSchemas.project_join }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("project_join", request)),
  );
  server.registerTool(
    "plan_publish",
    {
      description:
        "Publish the coordinator's complete task plan using its expected revision.",
      inputSchema: z.object({ request: requestSchemas.plan_publish }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_publish", request)),
  );
  server.registerTool(
    "plan_edit",
    {
      description:
        "Atomically add or update plan tasks using the coordinator's expected revision.",
      inputSchema: z.object({ request: requestSchemas.plan_edit }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_edit", request)),
  );
  server.registerTool(
    "plan_ack",
    {
      description: "Record the plan revision this session explicitly observed.",
      inputSchema: z.object({ request: requestSchemas.plan_ack }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_ack", request)),
  );
  server.registerTool(
    "plan_read",
    {
      description:
        "Read a complete plan revision, or use compare_to for differences without full maps.",
      inputSchema: z.object({ request: requestSchemas.plan_read }),
      annotations: read,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("plan_read", request)),
  );
  server.registerTool(
    "work_claim",
    {
      description:
        "Claim task ownership or record a delegated contribution with a revision check.",
      inputSchema: z.object({ request: requestSchemas.work_claim }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("work_claim", request)),
  );
  server.registerTool(
    "work_update",
    {
      description:
        "Atomically report progress, release work, or hand work to another session.",
      inputSchema: z.object({ request: requestSchemas.work_update }),
      annotations: write,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("work_update", request)),
  );
  server.registerTool(
    "project_status",
    {
      description:
        "Read compact current work; full includes all current records and the task map.",
      inputSchema: z.object({ request: requestSchemas.project_status }),
      annotations: read,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("project_status", request)),
  );
  server.registerTool(
    "work_history",
    {
      description:
        "Find recorded work and its history by task, session, path, branch, or commit.",
      inputSchema: z.object({ request: requestSchemas.work_history }),
      annotations: read,
    },
    ({ request }) =>
      invoke(request.project_id, () => board.call("work_history", request)),
  );
  return server;
}

export interface HttpOptions {
  token: string;
  host?: string;
  allowedHosts?: readonly string[];
  projects?: ReadonlySet<string>;
}

function validHostAuthority(host: string): boolean {
  const match = /^(\[[^\]]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(host);
  const hostname = match?.[1];
  const port = match?.[2];
  if (
    hostname === undefined ||
    (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
  )
    return false;
  if (hostname.startsWith("[")) return isIP(hostname.slice(1, -1)) === 6;
  if (/^[0-9.]+$/.test(hostname)) return isIP(hostname) === 4;
  return (
    hostname.length <= 253 &&
    hostname
      .replace(/\.$/, "")
      .split(".")
      .every((label) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      )
  );
}

export function matchesHost(
  host: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (!host || !validHostAuthority(host)) return false;
  return allowedHosts.some(
    (allowed) =>
      allowed === host ||
      (allowed.endsWith(":*") && host.startsWith(allowed.slice(0, -1))),
  );
}

function headerCount(request: IncomingMessage, name: string): number {
  return request.rawHeaders.filter(
    (header, index) => index % 2 === 0 && header.toLowerCase() === name,
  ).length;
}

export function bearerGate(
  token: string,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  if (!token || /\s/u.test(token))
    throw new Error(
      "PROJECT_BOARD_TOKEN must be nonempty and contain no whitespace.",
    );
  const expected = Buffer.from(token);
  return (request, response) => {
    const authorization =
      headerCount(request, "authorization") === 1
        ? request.headers.authorization
        : undefined;
    const separator = authorization?.indexOf(" ") ?? -1;
    const scheme = authorization?.slice(0, separator).toLowerCase();
    const supplied = Buffer.from(authorization?.slice(separator + 1) ?? "");
    if (
      scheme === "bearer" &&
      separator > 0 &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    )
      return true;
    response.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
    });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  };
}

export function createHttpApp(board: Ledger, options: HttpOptions) {
  const authenticate = bearerGate(options.token);
  const host = options.host ?? "127.0.0.1";
  const allowedHosts = [
    "127.0.0.1",
    "127.0.0.1:*",
    "localhost",
    "localhost:*",
    "[::1]",
    "[::1]:*",
  ];
  if (host !== "0.0.0.0" && host !== "::") {
    const value =
      host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    allowedHosts.push(value, `${value}:*`);
  }
  allowedHosts.push(...(options.allowedHosts ?? []));
  const handler = createMcpHandler(
    () => createServer(board, options.projects),
    { legacy: "reject" },
  );
  const legacyServers = new Set<McpServer>();
  const nodeHandler = toNodeHandler({
    async fetch(request: Request): Promise<Response> {
      if (
        request.method === "POST" &&
        !isJsonContentType(request.headers.get("content-type"))
      ) {
        return new Response("Unsupported Content-Type", { status: 415 });
      }
      if (!(await isLegacyRequest(request))) return handler.fetch(request);
      if (request.method === "GET" || request.method === "DELETE") {
        return new Response("Method not allowed.", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      const legacy = createServer(board, options.projects);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      legacyServers.add(legacy);
      const abort = () => {
        void legacy.close().catch(() => {});
      };
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        await legacy.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        request.signal.removeEventListener("abort", abort);
        legacyServers.delete(legacy);
        await legacy.close();
      }
    },
  });
  const validateOrigin = originValidation([]);
  const server = createHttpServer((request, response) => {
    if (!authenticate(request, response)) return;
    if (
      headerCount(request, "host") !== 1 ||
      !matchesHost(request.headers.host, allowedHosts)
    ) {
      response.writeHead(421, { "Content-Type": "text/plain" });
      response.end("Invalid Host header");
      return;
    }
    if (!validateOrigin(request, response)) return;
    const path = request.url?.split("?")[0];
    if (path !== "/mcp" && path !== "/mcp/") {
      response.writeHead(404);
      response.end();
      return;
    }
    void nodeHandler(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
      },
      response,
    ).catch(() => {
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded)
        response.end(JSON.stringify({ error: "Internal server error." }));
    });
  });
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      closing ??= (async () => {
        await handler.close();
        await Promise.all([...legacyServers].map((legacy) => legacy.close()));
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
      })();
      return closing;
    },
  };
}
