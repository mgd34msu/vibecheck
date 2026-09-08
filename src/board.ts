import { createHash } from "node:crypto";
import { z } from "zod";
import { Database, encode, type Transaction } from "./db.js";
import { BoardError } from "./errors.js";
import * as mutations from "./mutations.js";
import { planRead } from "./plans.js";
import {
  compactStatus,
  projectStatus,
  workHistory,
  type CompactStatusResponse,
  type DeltaStatusResponse,
  type WorkHistoryResponse,
} from "./queries.js";
import {
  jsonValueSchema,
  planAckSchema,
  planEditSchema,
  planPublishSchema,
  planReadSchema,
  projectJoinSchema,
  projectStatusSchema,
  workClaimSchema,
  workHistorySchema,
  workUpdateSchema,
  type Mutation,
  type PlanReadResult,
  type SessionId,
  type ToolName,
} from "./schemas.js";
import {
  planAckResponseSchema,
  planMutationResponseSchema,
  projectJoinResponseSchema,
  workClaimResponseSchema,
  workUpdateResponseSchema,
  type MutationFooter,
  type PlanAckResult,
  type PlanMutationResult,
  type ProjectJoinResult,
  type WorkClaimResult,
  type WorkUpdateResult,
} from "./responses.js";

export type ToolResult =
  | ProjectJoinResult
  | PlanMutationResult
  | PlanAckResult
  | PlanReadResult
  | WorkClaimResult
  | WorkUpdateResult
  | CompactStatusResponse
  | DeltaStatusResponse
  | WorkHistoryResponse;

function parseRequest<T>(schema: z.ZodType<T>, argumentsValue: unknown): T {
  try {
    return schema.parse(jsonValueSchema.parse(argumentsValue));
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new BoardError(
      "invalid",
      "invalid tool arguments",
      error.issues.map((issue) => ({
        field: issue.path.map((part) =>
          typeof part === "symbol" ? String(part) : part,
        ),
        message: issue.message,
        type: issue.code,
      })),
    );
  }
}

export class Board {
  readonly database: Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
  }

  call(
    tool: "project_join",
    argumentsValue: unknown,
  ): Promise<ProjectJoinResult>;
  call(
    tool: "plan_publish" | "plan_edit",
    argumentsValue: unknown,
  ): Promise<PlanMutationResult>;
  call(tool: "plan_ack", argumentsValue: unknown): Promise<PlanAckResult>;
  call(tool: "plan_read", argumentsValue: unknown): Promise<PlanReadResult>;
  call(tool: "work_claim", argumentsValue: unknown): Promise<WorkClaimResult>;
  call(tool: "work_update", argumentsValue: unknown): Promise<WorkUpdateResult>;
  call(
    tool: "project_status",
    argumentsValue: unknown,
  ): Promise<CompactStatusResponse | DeltaStatusResponse>;
  call(
    tool: "work_history",
    argumentsValue: unknown,
  ): Promise<WorkHistoryResponse>;
  call(tool: string, argumentsValue: unknown): Promise<ToolResult>;
  async call(tool: string, argumentsValue: unknown): Promise<ToolResult> {
    switch (tool) {
      case "project_join": {
        const request = parseRequest(projectJoinSchema, argumentsValue);
        const actorKey = `join:${encode([request.vendor, request.runtime, request.external_session_id])}`;
        return this.mutate(
          tool,
          request,
          actorKey,
          projectJoinResponseSchema,
          (tx) => {
            const joined = mutations.projectJoin(tx, request);
            const result = this.finish(tx, joined.session_id, joined);
            return {
              ...result,
              snapshot: compactStatus(tx, {
                project_id: request.project_id,
                include_map: true,
              }),
            };
          },
        );
      }
      case "plan_publish": {
        const request = parseRequest(planPublishSchema, argumentsValue);
        return this.mutate(
          tool,
          request,
          request.session_id,
          planMutationResponseSchema,
          (tx) =>
            this.finish(
              tx,
              request.session_id,
              mutations.planPublish(tx, request),
            ),
        );
      }
      case "plan_edit": {
        const request = parseRequest(planEditSchema, argumentsValue);
        return this.mutate(
          tool,
          request,
          request.session_id,
          planMutationResponseSchema,
          (tx) =>
            this.finish(
              tx,
              request.session_id,
              mutations.planEdit(tx, request),
            ),
        );
      }
      case "plan_ack": {
        const request = parseRequest(planAckSchema, argumentsValue);
        return this.mutate(
          tool,
          request,
          request.session_id,
          planAckResponseSchema,
          (tx) =>
            this.finish(tx, request.session_id, mutations.planAck(tx, request)),
        );
      }
      case "work_claim": {
        const request = parseRequest(workClaimSchema, argumentsValue);
        return this.mutate(
          tool,
          request,
          request.session_id,
          workClaimResponseSchema,
          (tx) =>
            this.finish(
              tx,
              request.session_id,
              mutations.workClaim(tx, request),
            ),
        );
      }
      case "work_update": {
        const request = parseRequest(workUpdateSchema, argumentsValue);
        return this.mutate(
          tool,
          request,
          request.session_id,
          workUpdateResponseSchema,
          (tx) =>
            this.finish(
              tx,
              request.session_id,
              mutations.workUpdate(tx, request),
            ),
        );
      }
      case "plan_read": {
        const request = parseRequest(planReadSchema, argumentsValue);
        return this.database.read(request.project_id, (tx) =>
          planRead(tx, request),
        );
      }
      case "project_status": {
        const request = parseRequest(projectStatusSchema, argumentsValue);
        return this.database.read(request.project_id, (tx) =>
          projectStatus(tx, request),
        );
      }
      case "work_history": {
        const request = parseRequest(workHistorySchema, argumentsValue);
        return this.database.read(request.project_id, (tx) =>
          workHistory(tx, request),
        );
      }
      default:
        throw new BoardError("invalid", `unknown tool '${tool}'`);
    }
  }

  private mutate<T>(
    tool: ToolName,
    request: Mutation,
    actorKey: string,
    responseSchema: z.ZodType<T>,
    operation: (tx: Transaction) => T,
  ): Promise<T> {
    const digest = createHash("sha256")
      .update(encode({ tool, request }))
      .digest("hex");
    return this.database.write(request.project_id, (tx) => {
      const cached = tx.getRequest(actorKey, request.request_id);
      if (cached !== undefined) {
        if (cached.digest !== digest) {
          throw new BoardError(
            "conflict",
            "request_id was already used with different input",
          );
        }
        return responseSchema.parse(cached.response);
      }
      const result = operation(tx);
      tx.putRequest(
        actorKey,
        request.request_id,
        digest,
        jsonValueSchema.parse(result),
      );
      return result;
    });
  }

  private finish<T extends object>(
    tx: Transaction,
    sessionId: SessionId,
    result: T,
  ): T & MutationFooter {
    tx.actorId = sessionId;
    const session = tx.getSession(sessionId);
    if (session.last_seen_at !== tx.now)
      tx.putSession(sessionId, { ...session, last_seen_at: tx.now });
    const cursor = tx.flush();
    return {
      ...result,
      cursor,
      plan_revision: tx.getProject(tx.projectId).plan_revision,
      map_hint: "include_map:true",
    };
  }
}
