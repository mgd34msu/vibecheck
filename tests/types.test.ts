import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource } from "../scripts/check-types.js";

test("type policy rejects assertions, unsafe types, and compiler suppressions", () => {
  const forbidden = [
    "let value: any;",
    "const value = input as string;",
    "const value = <string>input;",
    "const value = [1] as const;",
    "const value = input!;",
    "class Example { value!: string; }",
    "let value!: string;",
    "// @ts-ignore\nconst value = missing;",
    "/* @ts-expect-error */\nconst value = missing;",
    "// @ts-nocheck\nconst value = missing;",
  ];
  for (const source of forbidden) {
    assert.equal(checkSource(source, "fixture.ts").length, 1, source);
  }
});

test("type policy accepts narrowing and ignores documentation strings", () => {
  const source = `
    const explanation = "Do not use any or input as string";
    const example = "// @ts-ignore";
    function length(input: unknown): number {
      return typeof input === "string" ? input.length : 0;
    }
    const point = {x: 1} satisfies {x: number};
  `;
  assert.deepEqual(checkSource(source, "fixture.ts"), []);
});

test("type policy keeps template and regular expression content out of comment checks", () => {
  const sources = [
    "const example = `// @ts-ignore`;",
    "const example = `before ${value} // @ts-ignore`;",
    "const example = /[\"']@ts-ignore/;",
    "const example = /[/*]@ts-nocheck/;",
    "const example = <div>// @ts-ignore</div>;",
  ];
  for (const source of sources) {
    assert.deepEqual(checkSource(source, "fixture.tsx"), [], source);
  }
});

test("type policy finds real comments after literals and inside template expressions", () => {
  const sources = [
    "const example = /[\"']/; // @ts-ignore\nconst value = missing;",
    "const example = `before ${/* @ts-expect-error */ missing} after`;",
    "const example = `😀${value}suffix`; // @ts-nocheck\nconst value = missing;",
    "const example = <div>{/* @ts-ignore */ missing}</div>;",
  ];
  for (const source of sources) {
    assert.equal(checkSource(source, "fixture.tsx").length, 1, source);
  }
});

test("type policy preserves source positions while ignoring Unicode literals", () => {
  const violations = checkSource(
    'const example = "😀"; // @ts-ignore\nconst value = missing;',
    "fixture.ts",
  );
  assert.deepEqual(violations, [
    {
      file: "fixture.ts",
      line: 1,
      column: 23,
      message: "Compiler suppression comments are forbidden.",
    },
  ]);
});
