/**
 * Optional live integration check against a real `omp acp` install.
 * Enable with: T3_OMP_ACP_PROBE=1 vp test run OmpAcpCliProbe
 *
 * Assumes OMP has been set up locally (its `~/.omp` credential state exists);
 * the ACP `agent` auth method reuses those credentials, so no separate login
 * is needed. Unlike Grok, OMP advertises its model surface through session
 * `configOptions` (category `model`), not the ACP `models` field — these
 * assertions guard that OMP-specific contract.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  currentOmpModelIdFromSessionSetup,
  makeOmpAcpRuntime,
  ompModelCatalogFromSessionSetup,
} from "./OmpAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeOmpAcpRuntime({
    ompSettings: { binaryPath: "omp" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-omp-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_OMP_ACP_PROBE === "1")("Oh My Pi ACP CLI probe", () => {
  it.effect("initializes against real `omp acp` at protocol version 1", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(started.initializeResult.protocolVersion).toBe(1);
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("advertises the model surface via configOptions, not the ACP models field", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const setup = started.sessionSetupResult;

      // OMP-specific contract: no top-level `models`; model lives in configOptions.
      expect(setup.models ?? null).toBeNull();

      const currentModel = currentOmpModelIdFromSessionSetup(setup);
      expect(typeof currentModel).toBe("string");

      const catalog = ompModelCatalogFromSessionSetup(setup);
      expect(catalog.length).toBeGreaterThan(0);
      expect(currentModel === undefined || catalog.includes(currentModel)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a no-op model switch via session/set_config_option", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModel = currentOmpModelIdFromSessionSetup(started.sessionSetupResult);
      expect(currentModel).toBeDefined();
      if (!currentModel) {
        return;
      }
      // Selecting the model the session already runs on must succeed against
      // every OMP build that surfaces the `model` config option.
      yield* runtime.setConfigOption("model", currentModel);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
