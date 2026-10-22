import { z } from "zod";
import { BoardError } from "./errors.js";

/** Stdio bridge: all writes go through the same service as the explorer and collectors. */
export class RemoteLedger {
  constructor(
    readonly origin: string,
    readonly token: string,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error(
        "Use an HTTPS service or an explicit loopback HTTP service",
      );
    if (!token || /\s/.test(token))
      throw new Error("Service authentication requires PROJECT_BOARD_TOKEN");
  }
  async call(tool: string, input: unknown): Promise<object> {
    const request = z.record(z.string(), z.unknown()).parse(input);
    const project = z.string().parse(request.project_id);
    const response = await fetch(
      new URL(
        `/v1/projects/${encodeURIComponent(project)}/command`,
        this.origin,
      ),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tool, request }),
        signal: AbortSignal.timeout(30000),
      },
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = z
        .object({
          error: z.object({
            code: z.enum(["invalid", "not_found", "conflict", "forbidden"]),
            message: z.string(),
          }),
        })
        .safeParse(body);
      if (parsed.success)
        throw new BoardError(parsed.data.error.code, parsed.data.error.message);
      throw new Error("Work service request failed");
    }
    return z.record(z.string(), z.unknown()).parse(body);
  }
}
