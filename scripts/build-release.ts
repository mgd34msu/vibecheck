import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  chmod,
  utimes,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export type Platform = "codex" | "claude";
export const platforms: Platform[] = ["codex", "claude"];
export const commonFiles = [
  "README.md",
  "docs/protocol.md",
  "docs/agent-usage.md",
  "docs/releases/v1.0.0.md",
  "examples/mcp.json",
  "runtime/vibecheck.mjs",
  "runtime/THIRD-PARTY-NOTICES.txt",
  "scripts/run-server.sh",
  "skills/vibecheck/SKILL.md",
];

export async function packageVersion(directory = root): Promise<string> {
  const value: unknown = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  return z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).parse(value)
    .version;
}

export function pluginFiles(platform: Platform): string[] {
  return [
    ...commonFiles,
    `.${platform}-plugin/plugin.json`,
    platform === "codex"
      ? ".agents/plugins/marketplace.json"
      : ".claude-plugin/marketplace.json",
  ].sort();
}

export function artifactNames(version: string): string[] {
  return [
    ...platforms.map(
      (platform) => `vibecheck-${platform}-plugin-${version}.zip`,
    ),
    `vibecheck-runtime-${version}.tar.gz`,
  ].sort();
}

export function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    timeout: 60_000,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function generateBundle(): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [join(root, "src/cli.ts")],
    target: "node",
    format: "esm",
    external: ["node:sqlite", "bun:sqlite"],
    minify: true,
    sourcemap: "none",
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Runtime bundle failed");
  const output = result.outputs.find((entry) => entry.kind === "entry-point");
  if (output === undefined)
    throw new Error("Runtime bundle has no entry point");
  return new Uint8Array(await output.arrayBuffer());
}

const dependencySchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
});

export async function generateNotices(): Promise<string> {
  const packageValue: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const project = dependencySchema.parse(packageValue);
  const pending = Object.keys(project.dependencies).map((name) => ({
    name,
    from: root,
  }));
  const notices = new Map<string, string>();
  for (const dependency of pending) {
    let directory = dirname(Bun.resolveSync(dependency.name, dependency.from));
    while (!existsSync(join(directory, "package.json"))) {
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(
          `Cannot locate package metadata for ${dependency.name}`,
        );
      directory = parent;
    }
    const value: unknown = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const metadata = dependencySchema.parse(value);
    const key = `${metadata.name}@${metadata.version}`;
    if (notices.has(key)) continue;
    const files = await readdir(directory, { recursive: true });
    const licenses = files
      .filter(
        (file) =>
          !file.includes("/") &&
          /^(?:licen[cs]e|notice)(?:\..*)?$/iu.test(file),
      )
      .sort();
    if (licenses.length === 0)
      throw new Error(`No license file found for ${key}`);
    const text = await Promise.all(
      licenses.map(
        async (file) =>
          `${file}\n\n${await readFile(join(directory, file), "utf8")}`,
      ),
    );
    const comments = new Set<string>();
    for (const file of files
      .filter((file) => file.endsWith(".mjs") || file.endsWith(".js"))
      .sort()) {
      const source = await readFile(join(directory, file), "utf8");
      for (const match of source.matchAll(/\/\*[\s\S]*?\*\//gu)) {
        if (/@license|copyright|licensed/iu.test(match[0]))
          comments.add(match[0]);
      }
    }
    notices.set(
      key,
      `${key}\n${"=".repeat(key.length)}\n\n${text.join("\n\n")}${comments.size === 0 ? "" : `\n\nLicense comments shipped in dependency JavaScript:\n\n${[...comments].join("\n\n")}`}\n`,
    );
    pending.push(
      ...Object.keys(metadata.dependencies).map((name) => ({
        name,
        from: directory,
      })),
    );
  }
  return `Third-party notices for the generated Vibecheck runtime\n\nThese are the installed production dependencies' license files and license comments.\nThey apply to dependency code and do not license Vibecheck's own source.\nGenerated by bun scripts/build-release.ts.\n\n${[
    ...notices,
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, notice]) => notice)
    .join("\n")}`;
}

async function stageFiles(destination: string, files: string[]): Promise<void> {
  const epoch = new Date("2000-01-01T00:00:00Z");
  for (const file of files) {
    const target = join(destination, "vibecheck", file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, file), target);
    await chmod(target, file === "scripts/run-server.sh" ? 0o755 : 0o644);
    await utimes(target, epoch, epoch);
  }
}

export async function buildRelease(
  outputDirectory = join(root, "artifacts"),
): Promise<void> {
  const version = await packageVersion();
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime/vibecheck.mjs"), await generateBundle());
  await writeFile(
    join(root, "runtime/THIRD-PARTY-NOTICES.txt"),
    await generateNotices(),
  );
  await mkdir(outputDirectory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "vibecheck-release-"));
  try {
    for (const platform of platforms) {
      const stage = join(temporary, platform);
      const files = pluginFiles(platform);
      await stageFiles(stage, files);
      const output = join(
        outputDirectory,
        `vibecheck-${platform}-plugin-${version}.zip`,
      );
      await rm(output, { force: true });
      run(
        "zip",
        ["-X", "-q", output, ...files.map((file) => `vibecheck/${file}`)],
        stage,
      );
    }
    const stage = join(temporary, "runtime");
    await stageFiles(stage, commonFiles);
    run(
      "tar",
      [
        "--sort=name",
        "--mtime=2000-01-01T00:00:00Z",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--format=ustar",
        "-czf",
        join(outputDirectory, `vibecheck-runtime-${version}.tar.gz`),
        "vibecheck",
      ],
      stage,
    );
    const checksums = await Promise.all(
      artifactNames(version).map(
        async (name) =>
          `${sha256(await readFile(join(outputDirectory, name)))}  ${name}\n`,
      ),
    );
    await writeFile(join(outputDirectory, "SHA256SUMS"), checksums.join(""));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildRelease(
    process.argv[2] === undefined ? undefined : resolve(process.argv[2]),
  );
  process.stdout.write(
    "Built native plugins and standalone JavaScript runtime.\n",
  );
}
