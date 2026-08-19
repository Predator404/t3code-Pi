import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";

import {
  applyOmpModelSelection,
  buildOmpAcpSpawnInput,
  currentOmpModelIdFromSessionSetup,
  ompModelCatalogFromSessionSetup,
  resolveOmpBaseModelId,
} from "./OmpAcpSupport.ts";

const decodeNewSessionResponse = Schema.decodeUnknownSync(EffectAcpSchema.NewSessionResponse);

// OMP surfaces model/mode via `configOptions` (not the ACP `models` field), so
// the setup fixture below mirrors what a real `session/new` returns.
const sessionSetupWithModel = decodeNewSessionResponse({
  sessionId: "s-1",
  configOptions: [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "anthropic/claude-opus-4-8",
      options: [
        { value: "anthropic/claude-opus-4-8", name: "Opus" },
        { value: "anthropic/claude-haiku-4-5", name: "Haiku" },
      ],
    },
  ],
});

const sessionSetupWithoutModel = decodeNewSessionResponse({
  sessionId: "s-2",
  configOptions: [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    },
  ],
});

describe("resolveOmpBaseModelId", () => {
  it("falls back to the OMP default for empty input and preserves custom ids", () => {
    expect(resolveOmpBaseModelId(undefined)).toBe("anthropic/claude-opus-4-8");
    expect(resolveOmpBaseModelId("   ")).toBe("anthropic/claude-opus-4-8");
    expect(resolveOmpBaseModelId("  anthropic/claude-haiku-4-5  ")).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("spawns `omp acp` with the configured binary and passes env through untouched", () => {
    const spawn = buildOmpAcpSpawnInput({ binaryPath: "/usr/local/bin/omp" }, "/tmp/project", {
      HOME: "/home/tester",
      PI_PROFILE: "work",
    });
    expect(spawn).toEqual({
      command: "/usr/local/bin/omp",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/home/tester", PI_PROFILE: "work" },
    });
  });

  it("defaults the command to `omp` when no binaryPath is configured", () => {
    const spawn = buildOmpAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.command).toBe("omp");
    expect(spawn.args).toEqual(["acp"]);
  });
});

describe("currentOmpModelIdFromSessionSetup", () => {
  it("reads the current model from the model-category config option", () => {
    expect(currentOmpModelIdFromSessionSetup(sessionSetupWithModel)).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it("returns undefined when no model config option is present", () => {
    expect(currentOmpModelIdFromSessionSetup(sessionSetupWithoutModel)).toBeUndefined();
  });
});

describe("ompModelCatalogFromSessionSetup", () => {
  it("enumerates the model config option values", () => {
    expect(ompModelCatalogFromSessionSetup(sessionSetupWithModel)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-haiku-4-5",
    ]);
  });

  it("returns an empty catalog when no model config option is present", () => {
    expect(ompModelCatalogFromSessionSetup(sessionSetupWithoutModel)).toEqual([]);
  });
});

describe("applyOmpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          calls.push({ configId, value });
          if (failure) {
            return yield* failure;
          }
          return { configOptions: [] } satisfies EffectAcpSchema.SetSessionConfigOptionResponse;
        }),
    };
    return { runtime, calls };
  };

  it.effect("sets the model config option when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      const result = yield* applyOmpModelSelection({
        runtime,
        modelConfigId: "model",
        currentModelId: "anthropic/claude-opus-4-8",
        requestedModelId: "anthropic/claude-haiku-4-5",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([{ configId: "model", value: "anthropic/claude-haiku-4-5" }]);
      expect(result).toBe("anthropic/claude-haiku-4-5");
    }),
  );

  it.effect("defaults the config id to `model` when none is provided", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      yield* applyOmpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "anthropic/claude-haiku-4-5",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([{ configId: "model", value: "anthropic/claude-haiku-4-5" }]);
    }),
  );

  it.effect("skips the write when the requested model matches the current model", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      const result = yield* applyOmpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-opus-4-8",
        requestedModelId: "anthropic/claude-opus-4-8",
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result).toBe("anthropic/claude-opus-4-8");
    }),
  );

  it.effect("skips the write when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRecordingRuntime();
      const result = yield* applyOmpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-opus-4-8",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result).toBe("anthropic/claude-opus-4-8");
    }),
  );

  it.effect("propagates session/set_config_option failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyOmpModelSelection({
          runtime,
          modelConfigId: "model",
          currentModelId: "anthropic/claude-opus-4-8",
          requestedModelId: "anthropic/claude-haiku-4-5",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
