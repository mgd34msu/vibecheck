import { z } from "zod";
import {
  identifierSchema,
  locationRecordSchema,
  sessionIdSchema,
  shortTextSchema,
  workIdSchema,
} from "./schemas.js";

export const lifecycleSchema = z.enum([
  "unknown",
  "running",
  "idle",
  "waiting",
  "blocked",
  "paused",
  "finished",
  "failed",
]);
export const capabilitySchema = z.enum([
  "identity",
  "lifecycle",
  "files",
  "edits",
  "messages",
  "tools",
  "diffs",
  "tests",
  "heartbeat",
]);
export const worktreeSchema = z.strictObject({
  id: identifierSchema,
  repository: shortTextSchema,
  root: shortTextSchema,
  branch: shortTextSchema.nullable().optional(),
  machine: shortTextSchema.optional(),
});
export const sourceSchema = z.strictObject({
  id: identifierSchema,
  name: shortTextSchema,
  capabilities: z.array(capabilitySchema).max(20),
  status: z.enum(["connected", "disconnected", "error"]).default("connected"),
  detail: shortTextSchema.optional(),
});
export const artifactSchema = z.strictObject({
  id: identifierSchema,
  session_id: sessionIdSchema,
  work_id: workIdSchema.optional(),
  kind: z.enum([
    "diff",
    "message",
    "tool_output",
    "scope_plan",
    "scope_check",
    "test_result",
  ]),
  title: shortTextSchema,
  text: z.string().max(1_000_000),
  base_version: shortTextSchema.optional(),
  result_version: shortTextSchema.optional(),
  input_digest: shortTextSchema.optional(),
  outcome: z.enum(["passed", "failed", "unknown"]).optional(),
});
export const activityEventSchema = z.strictObject({
  id: identifierSchema,
  source_id: identifierSchema,
  session_id: sessionIdSchema,
  actor_id: sessionIdSchema.optional(),
  run_id: identifierSchema.optional(),
  work_id: workIdSchema.optional(),
  worktree_id: identifierSchema,
  occurred_at: z.iso.datetime({ offset: true }),
  kind: z.enum([
    "session_started",
    "session_state",
    "turn_started",
    "turn_finished",
    "operation_started",
    "operation_finished",
    "file_read",
    "file_edit",
    "file_test",
    "file_delete",
    "file_rename",
    "message",
    "error",
  ]),
  basis: z.enum(["agent_report", "host_event", "repository_observation"]),
  state: lifecycleSchema.optional(),
  operation: shortTextSchema.optional(),
  paths: locationRecordSchema.shape.paths.default([]),
  summary: z.string().max(4000).default(""),
  artifact_id: identifierSchema.optional(),
});
export const ingestSchema = z.strictObject({
  events: z.array(activityEventSchema).max(200),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type ActivitySource = z.infer<typeof sourceSchema>;
export type ActivityWorktree = z.infer<typeof worktreeSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export const activitySessionSchema = z.strictObject({
  session_id: sessionIdSchema,
  source_id: identifierSchema,
  worktree_id: identifierSchema,
  state: lifecycleSchema,
  started_at: z.string(),
  updated_at: z.string(),
  run_id: identifierSchema.optional(),
  operation: z.string().optional(),
  summary: z.string(),
});
export type ActivitySession = z.infer<typeof activitySessionSchema>;
export const activitySchemaStatements = [
  "CREATE TABLE IF NOT EXISTS activity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS activity_sources (project_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,id))",
  "CREATE TABLE IF NOT EXISTS activity_worktrees (project_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,id))",
  "CREATE TABLE IF NOT EXISTS activity_sessions (project_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,id))",
  "CREATE TABLE IF NOT EXISTS activity_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, session_id TEXT NOT NULL, worktree_id TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(project_id,id))",
  "CREATE INDEX IF NOT EXISTS activity_events_project_seq ON activity_events(project_id,seq)",
  "CREATE INDEX IF NOT EXISTS activity_events_session ON activity_events(project_id,session_id,seq)",
  "CREATE TABLE IF NOT EXISTS activity_artifacts (project_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,id))",
  "CREATE TABLE IF NOT EXISTS activity_checkpoints (project_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,id))",
];
