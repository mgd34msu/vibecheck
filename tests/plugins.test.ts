import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  packageVersion,
  platforms,
  pluginFiles,
} from "../scripts/build-release.js";
import {
  exercisePlugin,
  runtimes,
  verifyVersions,
} from "../scripts/verify-release.js";

const checkout = resolve(process.cwd());

test("native manifests agree with the package version and repository catalogs", async () => {
  assert.equal(await verifyVersions(checkout), await packageVersion(checkout));
});

for (const platform of platforms) {
  for (const runtime of runtimes) {
    test(
      `${platform} plugin runs its nine-tool lifecycle with ${runtime} from a read-only path containing spaces`,
      { timeout: 40_000 },
      async (context) => {
        const temporary = await mkdtemp(
          join(tmpdir(), "vibecheck plugin test "),
        );
        const plugin = join(temporary, "read only plugin");
        const directories = new Set<string>([plugin]);
        context.after(async () => {
          for (const directory of [...directories].sort(
            (left, right) => left.length - right.length,
          ))
            await chmod(directory, 0o755);
          await rm(temporary, { recursive: true, force: true });
        });
        for (const file of pluginFiles(platform)) {
          const target = join(plugin, file);
          await mkdir(dirname(target), { recursive: true });
          await cp(join(checkout, file), target);
          await chmod(target, file === "scripts/run-server.sh" ? 0o555 : 0o444);
          let directory = dirname(target);
          while (directory.startsWith(`${plugin}/`)) {
            directories.add(directory);
            directory = dirname(directory);
          }
        }
        for (const directory of [...directories].sort(
          (left, right) => right.length - left.length,
        ))
          await chmod(directory, 0o555);
        const version = await packageVersion(checkout);
        const launched = spawnSync(
          "bash",
          [join(plugin, "scripts/run-server.sh"), "--version"],
          {
            cwd: temporary,
            encoding: "utf8",
            env: { ...process.env, VIBECHECK_RUNTIME: runtime },
            timeout: 10_000,
          },
        );
        assert.equal(launched.status, 0, launched.stderr);
        assert.equal(launched.stdout, `vibecheck ${version}\n`);
        await exercisePlugin(
          plugin,
          platform,
          runtime,
          join(temporary, "external database.sqlite3"),
          temporary,
          version,
        );
      },
    );
  }
}

test("launcher rejects an invalid runtime override without starting the server", () => {
  const result = spawnSync(
    "bash",
    [join(checkout, "scripts/run-server.sh"), "--version"],
    {
      encoding: "utf8",
      env: { ...process.env, VIBECHECK_RUNTIME: "missing" },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be auto, bun, or node/u);
  assert.equal(result.stdout, "");
});
