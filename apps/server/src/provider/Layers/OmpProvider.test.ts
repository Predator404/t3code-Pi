import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { OmpSettings } from "@t3tools/contracts";

import {
  buildInitialOmpProviderSnapshot,
  buildOmpDiscoveredModelsFromCatalog,
  checkOmpProviderStatus,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// A fake `omp` that succeeds on `--version`; the credential dir controls the
// authenticated/unauthenticated branch independently of the version probe.
const OK_VERSION_SCRIPT = ["#!/bin/sh", 'printf "omp/17.3.7\\n"', "exit 0", ""].join("\n");

describe("buildInitialOmpProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(
        decodeOmpSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Oh My Pi is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot with in-session model switching when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({ enabled: true }));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Oh My Pi");
      // OMP switches model in-session via a config option (no new thread).
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

describe("buildOmpDiscoveredModelsFromCatalog", () => {
  it("marks the session's current model as the default, not the alphabetical first", () => {
    // Regression: OMA's catalog is sorted, so models[0] is the deprecated
    // claude-3-5-sonnet-20240620. Without an explicit default the web client
    // picks models[0] for new threads and every turn 404s. The current model
    // (opus-4-8) must carry isDefault so it is chosen instead.
    const models = buildOmpDiscoveredModelsFromCatalog(
      ["anthropic/claude-3-5-sonnet-20240620", "anthropic/claude-opus-4-8"],
      "anthropic/claude-opus-4-8",
    );
    expect(models.map((model) => ({ slug: model.slug, isDefault: model.isDefault }))).toEqual([
      { slug: "anthropic/claude-3-5-sonnet-20240620", isDefault: undefined },
      { slug: "anthropic/claude-opus-4-8", isDefault: true },
    ]);
  });

  it("marks no default when the current model is absent from the catalog", () => {
    const models = buildOmpDiscoveredModelsFromCatalog(["anthropic/claude-opus-4-8"], "x/y");
    expect(models.every((model) => model.isDefault === undefined)).toBe(true);
  });
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/omp-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken omp install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-version-" });
          const ompPath = path.join(dir, "omp");
          yield* fs.writeFileString(
            ompPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(ompPath, 0o755);
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Oh My Pi CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports unauthenticated when installed but no local credentials exist", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-noauth-" });
          const ompPath = path.join(dir, "omp");
          yield* fs.writeFileString(ompPath, OK_VERSION_SCRIPT);
          yield* fs.chmod(ompPath, 0o755);
          // Empty agent dir => no `agent.db` => unauthenticated.
          const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-agent-empty-" });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
            {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
            },
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("no local credentials");
    }),
  );

  it.effect("reports ready when installed and local credentials are present", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-ready-" });
          const ompPath = path.join(dir, "omp");
          yield* fs.writeFileString(ompPath, OK_VERSION_SCRIPT);
          yield* fs.chmod(ompPath, 0o755);
          const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-agent-auth-" });
          yield* fs.writeFileString(path.join(agentDir, "agent.db"), "");
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
            {
              ...process.env,
              PI_CODING_AGENT_DIR: agentDir,
            },
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
    }),
  );
});
