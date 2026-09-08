#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { Board } from "./board.js";
import { identifierSchema } from "./schemas.js";
import { createHttpApp, createServer } from "./server.js";
import { version } from "./version.js";

export class CliUsageError extends Error {}

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}

export function defaultDatabase(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.PROJECT_BOARD_DB)
    return expandHome(environment.PROJECT_BOARD_DB);
  const base = environment.XDG_DATA_HOME
    ? expandHome(environment.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  return join(base, "project-board", "board.sqlite3");
}

const configurationSchema = z
  .object({
    transport: z.enum(["stdio", "streamable-http"]),
    database: z.string(),
    host: z
      .string()
      .min(1)
      .regex(/^[^\s/]+$/u, "--host must be a hostname or IP address"),
    port: z
      .string()
      .regex(/^[+-]?\d+$/, "--port must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    allowedHosts: z.array(
      z
        .string()
        .min(1)
        .regex(
          /^[^\s/]+$/u,
          "--allowed-host must be a Host value, optionally with a port",
        ),
    ),
    token: z.string(),
  })
  .superRefine((config, context) => {
    if (
      config.transport === "streamable-http" &&
      (!config.token || /\s/u.test(config.token))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "HTTP requires PROJECT_BOARD_TOKEN with a nonempty token containing no whitespace",
      });
    }
  });
export type CliOptions = z.infer<typeof configurationSchema> & {
  projects: ReadonlySet<string> | undefined;
};

export function parseArgs(
  arguments_: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        transport: { type: "string", default: "stdio" },
        database: { type: "string", default: defaultDatabase(environment) },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8765" },
        "allowed-host": { type: "string", multiple: true, default: [] },
      },
    }));
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : "Invalid arguments.",
    );
  }
  const parsed = configurationSchema.safeParse({
    ...values,
    allowedHosts: values["allowed-host"],
    token: environment.PROJECT_BOARD_TOKEN ?? "",
  });
  if (!parsed.success)
    throw new CliUsageError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  let projects: ReadonlySet<string> | undefined;
  if (environment.PROJECT_BOARD_PROJECTS !== undefined) {
    const identifiers = z
      .array(identifierSchema)
      .safeParse(
        environment.PROJECT_BOARD_PROJECTS.split(",").map((value) =>
          value.trim(),
        ),
      );
    if (!identifiers.success)
      throw new CliUsageError(
        "PROJECT_BOARD_PROJECTS must be a comma-separated list of nonempty project IDs",
      );
    projects = new Set(identifiers.data);
  }
  return {
    ...parsed.data,
    database: expandHome(parsed.data.database),
    projects,
  };
}

const help = `A passive MCP ledger for project work.

Usage: vibecheck [options]
  --transport stdio|streamable-http   Default: stdio
  --database PATH                    SQLite database path
  --host HOST                        Default: 127.0.0.1
  --port PORT                        Default: 8765
  --allowed-host HOST[:PORT]          Additional allowed Host; repeat as needed
  --version                          Print version
  --help                             Print this help

HTTP requires PROJECT_BOARD_TOKEN. PROJECT_BOARD_DB sets the default database.
PROJECT_BOARD_PROJECTS restricts access to comma-separated project IDs.
`;

export async function main(
  arguments_: string[] = process.argv.slice(2),
): Promise<void> {
  if (arguments_.includes("--version")) {
    process.stdout.write(`vibecheck ${version}\n`);
    return;
  }
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  const options = parseArgs(arguments_);
  const board = new Board(options.database);
  const http =
    options.transport === "stdio"
      ? undefined
      : createHttpApp(board, {
          token: options.token,
          host: options.host,
          allowedHosts: options.allowedHosts,
          ...(options.projects === undefined
            ? {}
            : { projects: options.projects }),
        });
  const lifecycle =
    http ??
    serveStdio(() => createServer(board, options.projects), {
      onerror: () => process.stderr.write("MCP transport error.\n"),
    });
  try {
    if (http !== undefined)
      await new Promise<void>((resolveListening, reject) => {
        const failed = (error: Error) => reject(error);
        http.server.once("error", failed);
        http.server.listen(options.port, options.host, () => {
          http.server.off("error", failed);
          resolveListening();
        });
      });
    await new Promise<void>((resolveStopped) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.stdin.off("end", stop);
        resolveStopped();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (options.transport === "stdio") {
        process.stdin.once("end", stop);
        if (process.stdin.readableEnded) stop();
      }
    });
  } finally {
    await lifecycle.close();
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(entry)).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      error instanceof CliUsageError
        ? `${error.message}\n`
        : "Unable to run the project ledger.\n",
    );
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  }
}
