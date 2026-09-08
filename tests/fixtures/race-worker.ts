import { z } from "zod";
import { Board } from "../../src/board.js";
import { BoardError } from "../../src/errors.js";

const environment = z
  .object({
    VIBECHECK_DB_PATH: z.string().min(1),
    VIBECHECK_TOOL: z.enum(["project_join", "work_claim", "plan_edit"]),
    VIBECHECK_REQUEST: z.string().min(1),
  })
  .parse(process.env);

process.stdout.write("ready\n");
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
});
process.stdin.pause();

async function run() {
  const board = new Board(environment.VIBECHECK_DB_PATH);
  const payload: unknown = JSON.parse(environment.VIBECHECK_REQUEST);
  switch (environment.VIBECHECK_TOOL) {
    case "project_join": {
      const result = await board.call("project_join", payload);
      return {
        id: result.session_id,
        cursor: result.cursor,
        plan_revision: result.plan_revision,
      };
    }
    case "work_claim": {
      const result = await board.call("work_claim", payload);
      return {
        id: result.work.id,
        cursor: result.cursor,
        plan_revision: result.plan_revision,
      };
    }
    case "plan_edit": {
      const result = await board.call("plan_edit", payload);
      return {
        id: "plan_edit",
        cursor: result.cursor,
        plan_revision: result.plan_revision,
      };
    }
  }
}

try {
  const result = await run();
  process.stdout.write(`${JSON.stringify({ kind: "success", ...result })}\n`);
} catch (error) {
  const code =
    error instanceof BoardError
      ? error.code
      : error instanceof Error
        ? error.message
        : String(error);
  process.stdout.write(`${JSON.stringify({ kind: "error", code })}\n`);
}
