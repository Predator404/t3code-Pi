/**
 * Optional live integration check against a real `oma acp` install.
 * Enable with: T3_OMA_ACP_PROBE=1 vp test run OmaAcpCliProbe
 *
 * Mirrors OmpAcpCliProbe but points at the `oma` binary with the OMA config
 * root (`PI_CONFIG_DIR=.oma`, resolved under `~/.oma`), matching OmaDriver.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  applyOmpModelSelection,
  currentOmpModelIdFromSessionSetup,
  makeOmpAcpRuntime,
  ompModelCatalogFromSessionSetup,
} from "./OmpAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeOmpAcpRuntime({
    ompSettings: { binaryPath: "oma" },
    environment: { ...process.env, PI_CONFIG_DIR: ".oma" },
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-oma-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_OMA_ACP_PROBE === "1")("Oh My Pi Agents ACP CLI probe", () => {
  it.effect("discovers the model catalog via configOptions and reports a current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();

      const setup = started.sessionSetupResult;
      expect(setup.models ?? null).toBeNull();

      const currentModel = currentOmpModelIdFromSessionSetup(setup);
      expect(typeof currentModel).toBe("string");

      const catalog = ompModelCatalogFromSessionSetup(setup);
      expect(catalog.length).toBeGreaterThan(0);
      expect(currentModel === undefined || catalog.includes(currentModel)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("switches the active model to another catalog entry", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModel = currentOmpModelIdFromSessionSetup(started.sessionSetupResult);
      const catalog = ompModelCatalogFromSessionSetup(started.sessionSetupResult);
      const target = catalog.find((model) => model !== currentModel) ?? currentModel;
      expect(target).toBeDefined();
      if (!target) {
        return;
      }
      const bound = yield* applyOmpModelSelection({
        runtime,
        modelConfigId: started.modelConfigId,
        currentModelId: currentModel,
        requestedModelId: target,
        mapError: (cause) => cause,
      });
      expect(bound).toBe(target);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
