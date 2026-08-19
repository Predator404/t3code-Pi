/**
 * OmpAcpSupport — spawn wiring and model/config helpers for the Oh My Pi
 * (`omp`) ACP provider.
 *
 * OMP is a vanilla ACP v1 agent (`omp acp`). Unlike Grok it does NOT populate
 * the ACP `models` field; model, mode, and thinking selection are surfaced
 * through session `configOptions` (categories `model` / `mode` /
 * `thought_level`) and mutated via `session/set_config_option`. The shared
 * {@link AcpSessionRuntime} already models config options natively
 * (`getConfigOptions` / `setConfigOption`), so this module is thin: it builds
 * the spawn input, fixes the auth method, and exposes model read/select
 * helpers built on the config-option surface.
 *
 * This is the interface Phase 2 (adapter, provider snapshot, text generation)
 * codes against — its exported signatures are frozen.
 *
 * @module OmpAcpSupport
 */
import { type OmpSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
} from "./AcpRuntimeModel.ts";

/** OMP advertises a single ACP auth method: reuse local `~/.omp` credentials. */
export const OMP_AUTH_METHOD_ID = "agent";

/** Canonical fallback model when OMP reports none (matches OMP's default). */
export const OMP_DEFAULT_MODEL_ID = "anthropic/claude-opus-4-8";

type AcpSessionSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Build the `omp acp` subprocess spawn input for the ACP session runtime. */
export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: ["acp"],
    cwd,
    env: { ...environment },
  };
}

/**
 * Materialize an OMP ACP session runtime bound to the supplied child-process
 * spawner. Returns the shared {@link AcpSessionRuntime} service directly — OMP
 * needs no provider-specific wrapper (contrast Grok's xAI extension).
 */
export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment),
        authMethodId: OMP_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** Resolve the requested/base model to a concrete OMP model id. */
export function resolveOmpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : OMP_DEFAULT_MODEL_ID;
}

/**
 * Read OMP's current model from session-setup config options. OMP leaves the
 * ACP `models` field null, so the model lives in the `model`-category config
 * option's `currentValue`.
 */
export function currentOmpModelIdFromSessionSetup(
  sessionSetupResult: AcpSessionSetupResponse,
): string | undefined {
  const modelConfigId = extractModelConfigId(sessionSetupResult);
  if (!modelConfigId) {
    return undefined;
  }
  const option = findSessionConfigOption(sessionSetupResult.configOptions, modelConfigId);
  if (option && option.type === "select") {
    const current = option.currentValue?.trim();
    return current && current.length > 0 ? current : undefined;
  }
  return undefined;
}

/** Enumerate OMP's selectable model ids from session-setup config options. */
export function ompModelCatalogFromSessionSetup(
  sessionSetupResult: AcpSessionSetupResponse,
): ReadonlyArray<string> {
  const modelConfigId = extractModelConfigId(sessionSetupResult);
  if (!modelConfigId) {
    return [];
  }
  const option = findSessionConfigOption(sessionSetupResult.configOptions, modelConfigId);
  return option ? collectSessionConfigOptionValues(option) : [];
}

/**
 * Select a model on an active OMP session through the config-option surface.
 * No-ops when the requested model is absent or already current.
 */
export function applyOmpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly modelConfigId?: string | undefined;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setConfigOption(input.modelConfigId ?? "model", input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
