import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { jsonValueSchema, requestSchemas } from "../src/schemas.js";

const toolNameSchema = z.keyof(z.object(requestSchemas));
const caseSchema = z.discriminatedUnion("success", [
  z.strictObject({
    tool: toolNameSchema,
    input: jsonValueSchema,
    success: z.literal(true),
    output: jsonValueSchema,
  }),
  z.strictObject({
    tool: toolNameSchema,
    input: jsonValueSchema,
    success: z.literal(false),
  }),
]);
const fixtureSchema = z.strictObject({
  provenance: z.strictObject({
    reference_repository: z.url(),
    reference_commit: z.string().regex(/^[a-f0-9]{40}$/u),
    reference_file: z.string(),
    reference_file_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    capture_description: z.string().min(1),
    case_groups: z.strictObject({
      top_level: z.literal(504),
      nested: z.literal(491),
    }),
  }),
  cases: z.array(caseSchema).length(995),
});

test("request schemas preserve 995 frozen Python validation and omission results", async () => {
  const text = await readFile(
    join(process.cwd(), "tests", "fixtures", "schema-parity.json"),
    "utf8",
  );
  const fixture = fixtureSchema.parse(JSON.parse(text));
  const toolsSeen = new Set<string>();
  for (const [index, entry] of fixture.cases.entries()) {
    const result = requestSchemas[entry.tool].safeParse(entry.input);
    const context = `case ${index + 1}, ${entry.tool}: ${JSON.stringify(entry.input)}`;
    assert.equal(result.success, entry.success, context);
    if (entry.success && result.success) {
      assert.deepEqual(result.data, entry.output, context);
    }
    toolsSeen.add(entry.tool);
  }
  assert.deepEqual([...toolsSeen].sort(), Object.keys(requestSchemas).sort());
});
