import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createNodeBbSdk, pluginMutationResponseSchema } from "@bb/sdk";
import { getInstalledPlugin } from "@bb/db";
import { startTestServer } from "../../helpers/test-app.js";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

function source(marker: string): string {
  return `export default async function plugin(bb) {
    bb.settings.define({
      token: { type: "string", label: "Token", secret: true },
      autoSync: { type: "boolean", label: "Auto sync", default: true },
    });
    bb.background.schedule("sweep", "0 * * * *", async () => {});
    await bb.storage.kv.set("loaded", ${JSON.stringify(marker)});
  }`;
}

describe("plugin source moves through the public install surfaces", () => {
  it.each(["HTTP", "SDK"] as const)(
    "keeps configuration through a Git/path/Git roundtrip over %s",
    async (surface) => {
      const rootDir = await mkdtemp(join(tmpdir(), "bb-source-move-route-"));
      const server = await startTestServer({ seedFirstPartyProviders: false });
      try {
        await writeFile(
          join(rootDir, "package.json"),
          JSON.stringify({
            name: "bb-plugin-retained",
            version: "0.1.0",
            bb: {
              name: "Retained",
              description: "Source move fixture",
              branding: { icon: "Zap" },
              server: "./server.ts",
            },
          }),
        );
        await writeFile(join(rootDir, "server.ts"), source("git"));
        await git(rootDir, ["init", "-q", "-b", "main"]);
        await git(rootDir, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "add",
          ".",
        ]);
        await git(rootDir, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "fixture",
        ]);
        await writeFile(join(rootDir, "server.ts"), source("path"));
        const sdk = createNodeBbSdk({ baseUrl: server.baseUrl });
        const install = async (source: string) => {
          if (surface === "SDK") return sdk.plugins.install({ source });
          const response = await fetch(
            `${server.baseUrl}/api/v1/plugins/install`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ source }),
            },
          );
          expect(response.status).toBe(200);
          return pluginMutationResponseSchema.parse(await response.json())
            .plugin;
        };
        await install(`git:${rootDir}@main`);
        await sdk.plugins.updateSettings({
          pluginId: "retained",
          values: { token: "synthetic-secret", autoSync: false },
        });
        await server.pluginService
          .getApi("retained")!
          .storage.kv.set("cursor", { position: 42 });
        for (const kind of ["path", "git"] as const) {
          const requested =
            kind === "git" ? `git:${rootDir}@main` : `path:${rootDir}`;
          expect(await install(requested)).toMatchObject({
            id: "retained",
            status: "running",
            enabled: true,
            source: requested,
          });
          expect(getInstalledPlugin(server.db, "retained")?.sourceKind).toBe(
            kind,
          );
          expect(
            (await sdk.plugins.getSettings({ pluginId: "retained" })).values,
          ).toEqual({ token: { set: true }, autoSync: false });
          const kv = server.pluginService.getApi("retained")!.storage.kv;
          expect(await kv.get("loaded")).toBe(kind);
          expect(await kv.get("cursor")).toEqual({ position: 42 });
          expect(
            server.db.$client
              .prepare("SELECT name FROM plugin_schedules WHERE plugin_id = ?")
              .all("retained"),
          ).toEqual([{ name: "sweep" }]);
        }
      } finally {
        await server.close();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
