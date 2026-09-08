import { z } from "zod";

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
export const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$(?![\s\S])/);
export const projectIdSchema = identifierSchema.brand<"ProjectId">();
export const sessionIdSchema = identifierSchema.brand<"SessionId">();
export const taskIdSchema = identifierSchema.brand<"TaskId">();
export const workIdSchema = identifierSchema.brand<"WorkId">();
export const planRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .brand<"PlanRevision">();
export const recordRevisionSchema = z
  .number()
  .int()
  .min(1)
  .brand<"RecordRevision">();
export const cursorSchema = z.number().int().nonnegative().brand<"Cursor">();
export const timestampSchema = z.string();
export const shortTextSchema = z
  .string()
  .min(1)
  .refine((value) => Array.from(value).length <= 500, {
    message: "String should have at most 500 characters",
  });
export const commitSchema = z
  .string()
  .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$(?![\s\S])/);
export const taskStateSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "awaiting_integration",
  "complete",
  "cancelled",
]);
export const workStateSchema = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "awaiting_integration",
  "complete",
  "cancelled",
  "released",
  "abandoned",
]);
export type ProjectId = z.infer<typeof projectIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type WorkId = z.infer<typeof workIdSchema>;
export type PlanRevision = z.infer<typeof planRevisionSchema>;
export type RecordRevision = z.infer<typeof recordRevisionSchema>;
export type Cursor = z.infer<typeof cursorSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type WorkState = z.infer<typeof workStateSchema>;

const pathsSchema = z
  .array(shortTextSchema)
  .max(500)
  .superRefine((paths, context) => {
    if (
      paths.some(
        (path) =>
          path.startsWith("/") ||
          path.includes("\\") ||
          path
            .split("/")
            .some((part) => part === "" || part === "." || part === ".."),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "paths must be normalized repository-relative paths",
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: "custom", message: "paths must be unique" });
    }
  });

export const locationSchema = z.strictObject({
  repository: shortTextSchema.nullable().optional(),
  checkout: shortTextSchema.nullable().optional(),
  branch: shortTextSchema.nullable().optional(),
  target_branch: shortTextSchema.nullable().optional(),
  base_commit: commitSchema.nullable().optional(),
  paths: pathsSchema.optional(),
});
export const locationRecordSchema = z.strictObject({
  repository: shortTextSchema.nullable(),
  checkout: shortTextSchema.nullable(),
  branch: shortTextSchema.nullable(),
  target_branch: shortTextSchema.nullable(),
  base_commit: commitSchema.nullable(),
  paths: pathsSchema,
});
export type Location = z.infer<typeof locationSchema>;
export type LocationPatch = Location;
export type LocationRecord = z.infer<typeof locationRecordSchema>;

export function normalizeLocation(location: Location = {}): LocationRecord {
  return {
    repository: location.repository ?? null,
    checkout: location.checkout ?? null,
    branch: location.branch ?? null,
    target_branch: location.target_branch ?? null,
    base_commit: location.base_commit ?? null,
    paths: location.paths ?? [],
  };
}

const mutationShape = {
  project_id: projectIdSchema,
  request_id: identifierSchema,
};
const sessionMutationShape = { ...mutationShape, session_id: sessionIdSchema };
export const projectJoinSchema = z.strictObject({
  ...mutationShape,
  repository: shortTextSchema,
  vendor: shortTextSchema,
  runtime: shortTextSchema,
  external_session_id: shortTextSchema,
  model: shortTextSchema,
  effort: shortTextSchema.nullable().optional(),
  parent_session_id: sessionIdSchema.nullable().optional(),
  take_over_from: sessionIdSchema.nullable().optional(),
});
export const taskDefinitionSchema = z.strictObject({
  id: taskIdSchema,
  label: shortTextSchema,
  depends_on: z.array(taskIdSchema).max(1000).optional(),
  status: z.enum(["pending", "cancelled"]).optional(),
  supersedes: z.array(taskIdSchema).max(1000).optional(),
});
export const planPublishSchema = z.strictObject({
  ...sessionMutationShape,
  expected_revision: planRevisionSchema,
  tasks: z.array(taskDefinitionSchema).max(10000),
});
export const planAddSchema = z.strictObject({
  op: z.literal("add"),
  task: taskDefinitionSchema,
});
export const planUpdateSchema = z
  .strictObject({
    op: z.literal("update"),
    task_id: taskIdSchema,
    label: shortTextSchema.optional(),
    depends_on: z.array(taskIdSchema).max(1000).optional(),
    status: z.enum(["pending", "cancelled"]).optional(),
    supersedes: z.array(taskIdSchema).max(1000).optional(),
  })
  .refine(
    (operation) =>
      operation.label !== undefined ||
      operation.depends_on !== undefined ||
      operation.status !== undefined ||
      operation.supersedes !== undefined,
    { message: "update requires at least one changed field" },
  );
export const planOperationSchema = z.discriminatedUnion("op", [
  planAddSchema,
  planUpdateSchema,
]);
export const planEditSchema = z.strictObject({
  ...sessionMutationShape,
  expected_revision: planRevisionSchema,
  operations: z.array(planOperationSchema).min(1).max(10000),
});
export const planAckSchema = z.strictObject({
  ...sessionMutationShape,
  plan_revision: planRevisionSchema,
});
export const planReadSchema = z.strictObject({
  project_id: projectIdSchema,
  revision: planRevisionSchema.nullable().optional(),
  compare_to: planRevisionSchema.nullable().optional(),
});
export const workClaimSchema = z
  .strictObject({
    ...sessionMutationShape,
    task_id: taskIdSchema,
    expected_revision: recordRevisionSchema,
    location: locationSchema.optional(),
    replace_work_id: workIdSchema.nullable().optional(),
    parent_work_id: workIdSchema.nullable().optional(),
  })
  .refine(
    (request) =>
      request.replace_work_id == null || request.parent_work_id == null,
    {
      message: "replacement and delegated contribution are mutually exclusive",
    },
  );
const workChangeShape = {
  work_id: workIdSchema,
  expected_revision: recordRevisionSchema,
  expected_task_revision: recordRevisionSchema.nullable().optional(),
};
export const workProgressSchema = z.strictObject({
  ...workChangeShape,
  action: z.literal("progress").optional(),
  status: taskStateSchema.optional(),
  location: locationSchema.nullable().optional(),
  blocker: shortTextSchema.nullable().optional(),
  commit: commitSchema.nullable().optional(),
  integration_commit: commitSchema.nullable().optional(),
  handoff_to: z.null().optional(),
});
export const workReleaseSchema = z.strictObject({
  ...workChangeShape,
  action: z.literal("release"),
  handoff_to: z.null().optional(),
});
export const workHandoffSchema = z.strictObject({
  ...workChangeShape,
  action: z.literal("handoff"),
  handoff_to: sessionIdSchema,
});
export const workChangeSchema = z.discriminatedUnion("action", [
  workProgressSchema,
  workReleaseSchema,
  workHandoffSchema,
]);
export const workUpdateSchema = z.strictObject({
  ...sessionMutationShape,
  updates: z.array(workChangeSchema).max(100).optional(),
});
export const projectStatusSchema = z
  .strictObject({
    project_id: projectIdSchema,
    full: z.boolean().optional(),
    include_map: z.boolean().optional(),
    known_plan_revision: planRevisionSchema.nullable().optional(),
    since: cursorSchema.nullable().optional(),
    task_ids: z.array(taskIdSchema).min(1).max(1000).nullable().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((request, context) => {
    if (request.since != null && request.task_ids != null) {
      context.addIssue({
        code: "custom",
        message: "task_ids cannot be combined with since",
      });
    }
    if (
      request.since != null &&
      (request.full ||
        request.include_map ||
        request.known_plan_revision != null)
    ) {
      context.addIssue({
        code: "custom",
        message: "snapshot options cannot be combined with since",
      });
    }
    if (request.full && request.task_ids != null) {
      context.addIssue({
        code: "custom",
        message: "full cannot be combined with task_ids",
      });
    }
  });
export const workHistorySchema = z
  .strictObject({
    project_id: projectIdSchema,
    task_id: taskIdSchema.nullable().optional(),
    session_id: sessionIdSchema.nullable().optional(),
    path: shortTextSchema.nullable().optional(),
    branch: shortTextSchema.nullable().optional(),
    commit: commitSchema.nullable().optional(),
    after: cursorSchema.optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .refine(
    (request) =>
      Boolean(
        request.task_id ||
        request.session_id ||
        request.path ||
        request.branch ||
        request.commit,
      ),
    { message: "at least one history selector is required" },
  );

export const requestSchemas = {
  project_join: projectJoinSchema,
  plan_publish: planPublishSchema,
  plan_edit: planEditSchema,
  plan_ack: planAckSchema,
  plan_read: planReadSchema,
  work_claim: workClaimSchema,
  work_update: workUpdateSchema,
  project_status: projectStatusSchema,
  work_history: workHistorySchema,
};
export type ToolName = keyof typeof requestSchemas;
export type ProjectJoin = z.infer<typeof projectJoinSchema>;
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type PlanPublish = z.infer<typeof planPublishSchema>;
export type PlanAdd = z.infer<typeof planAddSchema>;
export type PlanUpdate = z.infer<typeof planUpdateSchema>;
export type PlanOperation = z.infer<typeof planOperationSchema>;
export type PlanEdit = z.infer<typeof planEditSchema>;
export type PlanAck = z.infer<typeof planAckSchema>;
export type PlanRead = z.infer<typeof planReadSchema>;
export type WorkClaim = z.infer<typeof workClaimSchema>;
export type WorkProgress = z.infer<typeof workProgressSchema>;
export type WorkRelease = z.infer<typeof workReleaseSchema>;
export type WorkHandoff = z.infer<typeof workHandoffSchema>;
export type WorkChange = z.infer<typeof workChangeSchema>;
export type WorkUpdate = z.infer<typeof workUpdateSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type WorkHistory = z.infer<typeof workHistorySchema>;
export type Mutation =
  ProjectJoin | PlanPublish | PlanEdit | PlanAck | WorkClaim | WorkUpdate;
export type SessionMutation = Exclude<Mutation, ProjectJoin>;

const metadataShape = {
  revision: recordRevisionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
};
export const projectRecordSchema = z.strictObject({
  ...metadataShape,
  id: projectIdSchema,
  repository: shortTextSchema,
  coordinator_session_id: sessionIdSchema,
  plan_revision: planRevisionSchema,
});
export const sessionRecordSchema = z.strictObject({
  ...metadataShape,
  id: sessionIdSchema,
  vendor: shortTextSchema,
  runtime: shortTextSchema,
  external_session_id: shortTextSchema,
  parent_session_id: sessionIdSchema.nullable(),
  model: shortTextSchema,
  effort: shortTextSchema.nullable(),
  last_seen_at: timestampSchema,
  acknowledged_plan_revision: planRevisionSchema.optional(),
  acknowledged_at: timestampSchema.optional(),
});
export const taskRecordSchema = z.strictObject({
  ...metadataShape,
  id: taskIdSchema,
  label: shortTextSchema,
  depends_on: z.array(taskIdSchema).max(1000),
  status: taskStateSchema,
  owner_work_id: workIdSchema.nullable(),
  supersedes: z.array(taskIdSchema).max(1000).optional(),
});
export const workRecordSchema = z.strictObject({
  ...metadataShape,
  id: workIdSchema,
  task_id: taskIdSchema,
  session_id: sessionIdSchema,
  parent_work_id: workIdSchema.nullable(),
  predecessor_work_id: workIdSchema.nullable(),
  role: z.enum(["owner", "contributor"]),
  status: workStateSchema,
  location: locationRecordSchema,
  blocker: shortTextSchema.nullable(),
  commit: commitSchema.nullable(),
  integration_commit: commitSchema.nullable(),
  integration_required: z.boolean().optional(),
});
export const storedWorkRecordSchema = workRecordSchema;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type StoredWorkRecord = z.infer<typeof workRecordSchema>;
export type WorkRecord = StoredWorkRecord;
type MetadataKey = "id" | "revision" | "created_at" | "updated_at";
export type ProjectFields = Omit<ProjectRecord, MetadataKey>;
export type SessionFields = Omit<SessionRecord, MetadataKey>;
export type TaskFields = Omit<TaskRecord, MetadataKey>;
export type WorkFields = Omit<WorkRecord, MetadataKey>;
export const taskMapDefinitionSchema = z.strictObject({
  label: shortTextSchema,
  depends_on: z.array(taskIdSchema),
  supersedes: z.array(taskIdSchema).optional(),
});
export const taskMapSchema = z.record(z.string(), taskMapDefinitionSchema);
export const planMetadataSchema = z.strictObject({
  actor_id: sessionIdSchema,
  created_at: timestampSchema,
});
const planReadResultShape = {
  project_id: projectIdSchema,
  plan_revision: planRevisionSchema,
  metadata: planMetadataSchema.optional(),
};
export const planReadMapResultSchema = z.strictObject({
  ...planReadResultShape,
  task_map: taskMapSchema,
});
export const planReadDiffResultSchema = z.strictObject({
  ...planReadResultShape,
  compare_to: planRevisionSchema,
  added: taskMapSchema,
  changed: z.record(
    z.string(),
    z.strictObject({
      before: taskMapDefinitionSchema,
      after: taskMapDefinitionSchema,
    }),
  ),
  removed: z.array(taskIdSchema),
});
export const planReadResultSchema = z.union([
  planReadMapResultSchema,
  planReadDiffResultSchema,
]);
export type TaskMapDefinition = z.infer<typeof taskMapDefinitionSchema>;
export type TaskMap = z.infer<typeof taskMapSchema>;
export type PlanMetadata = z.infer<typeof planMetadataSchema>;
export type PlanReadResult = z.infer<typeof planReadResultSchema>;
export type PlanReadMapResult = z.infer<typeof planReadMapResultSchema>;
export type PlanReadDiffResult = z.infer<typeof planReadDiffResultSchema>;
export const recordChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("project"),
    id: projectIdSchema,
    record: projectRecordSchema,
  }),
  z.strictObject({
    kind: z.literal("session"),
    id: sessionIdSchema,
    record: sessionRecordSchema,
    context: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("task"),
    id: taskIdSchema,
    record: taskRecordSchema,
  }),
  z.strictObject({
    kind: z.literal("work"),
    id: workIdSchema,
    record: workRecordSchema,
  }),
]);
export type RecordChange = z.infer<typeof recordChangeSchema>;
