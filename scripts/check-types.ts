import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript-compiler-api";

export interface Violation {
  file: string;
  line: number;
  column: number;
  message: string;
}

export function checkSource(source: string, file: string): Violation[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: Violation[] = [];
  const literalRanges: { start: number; end: number }[] = [];
  function report(position: number, message: string): void {
    const { line, character } = parsed.getLineAndCharacterOfPosition(position);
    violations.push({ file, line: line + 1, column: character + 1, message });
  }
  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isRegularExpressionLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      node.kind === ts.SyntaxKind.JsxText
    ) {
      literalRanges.push({ start: node.getStart(parsed), end: node.end });
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      report(
        node.getStart(parsed),
        "Use a concrete type or validate unknown input.",
      );
    } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      report(
        node.getStart(parsed),
        "Type assertions are forbidden; validate or narrow the value.",
      );
    } else if (ts.isNonNullExpression(node)) {
      report(
        node.getStart(parsed),
        "Non-null assertions are forbidden; handle the missing value.",
      );
    } else if (
      ts.isPropertyDeclaration(node) &&
      node.exclamationToken !== undefined
    ) {
      report(
        node.getStart(parsed),
        "Definite-assignment assertions are forbidden; initialize the field.",
      );
    } else if (
      ts.isVariableDeclaration(node) &&
      node.exclamationToken !== undefined
    ) {
      report(
        node.getStart(parsed),
        "Definite-assignment assertions are forbidden; initialize the variable.",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  const codeSegments: string[] = [];
  let copiedThrough = 0;
  for (const range of literalRanges.sort(
    (left, right) => left.start - right.start,
  )) {
    codeSegments.push(source.slice(copiedThrough, range.start));
    codeSegments.push(
      source.slice(range.start, range.end).replace(/[^\r\n]/g, " "),
    );
    copiedThrough = range.end;
  }
  codeSegments.push(source.slice(copiedThrough));
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    codeSegments.join(""),
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      if (
        /@ts-(?:ignore|expect-error|nocheck)\b/u.test(scanner.getTokenText())
      ) {
        report(
          scanner.getTokenPos(),
          "Compiler suppression comments are forbidden.",
        );
      }
    }
  }
  return violations;
}

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sources(path)));
    else if (/\.(?:[cm]?ts|tsx)$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const files = (
    await Promise.all(
      ["src", "tests", "scripts"].map((directory) =>
        sources(resolve(root, directory)),
      ),
    )
  ).flat();
  const violations = (
    await Promise.all(
      files.map(async (file) =>
        checkSource(await readFile(file, "utf8"), file),
      ),
    )
  ).flat();
  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}:${violation.column}: ${violation.message}\n`,
    );
  }
  if (violations.length > 0) process.exitCode = 1;
  else
    process.stdout.write(
      `Checked ${files.length} TypeScript files: no forbidden type escapes.\n`,
    );
}

if (import.meta.main) await main();
