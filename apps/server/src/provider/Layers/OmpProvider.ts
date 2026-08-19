import {
  type OmpSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  makeOmpAcpRuntime,
  ompModelCatalogFromSessionSetup,
  OMP_DEFAULT_MODEL_ID,
} from "../acp/OmpAcpSupport.ts";
import { ompCredentialStateExists, runOmpVersionCommand } from "../acp/OmpAcpCliProbe.ts";

export interface OmpBrand {
  readonly displayName: string;
  readonly binaryName: string;
  readonly configDir: string;
}

/**
 * Default brand: stock Oh My Pi (`omp`, state under `~/.omp`). The OMA driver
 * passes its own brand so status/guidance name `oma` and `~/.oma` instead of
 * misdirecting users to the omp binary/config dir.
 */
export const OMP_BRAND: OmpBrand = {
  displayName: "Oh My Pi",
  binaryName: "omp",
  configDir: "~/.omp",
};

function presentationFor(brand: OmpBrand) {
  return {
    displayName: brand.displayName,
    showInteractionModeToggle: true,
    requiresNewThreadForModelChange: false,
  } as const;
}
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const OMP_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: OMP_DEFAULT_MODEL_ID,
    name: OMP_DEFAULT_MODEL_ID,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
  brand: OmpBrand = OMP_BRAND,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ompModelsFromSettings(ompSettings.customModels);
    const presentation = presentationFor(brand);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: `${brand.displayName} is disabled in T3 Code settings.`,
        },
      });
    }

    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `Checking ${brand.displayName} CLI availability...`,
      },
    });
  });
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OMP_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function buildOmpDiscoveredModelsFromCatalog(
  catalog: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return catalog
    .map((modelId): ServerProviderModel | undefined => {
      const slug = modelId.trim();
      if (slug.length === 0 || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverOmpModelsViaAcp = (
  ompSettings: Pick<OmpSettings, "binaryPath">,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const acp = yield* makeOmpAcpRuntime({
      ompSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildOmpDiscoveredModelsFromCatalog(
      ompModelCatalogFromSessionSetup(started.sessionSetupResult),
    );
  }).pipe(Effect.scoped);

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  brand: OmpBrand = OMP_BRAND,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);
  const presentation = presentationFor(brand);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `${brand.displayName} is disabled in T3 Code settings.`,
      },
    });
  }

  const versionResult = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning(`${brand.displayName} CLI health check failed.`, {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `${brand.displayName} CLI (\`${brand.binaryName}\`) is not installed or not on PATH.`
          : `Failed to execute ${brand.displayName} CLI health check.`,
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `${brand.displayName} CLI is installed but timed out while running \`${brand.binaryName} --version\`.`,
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning(
      `${brand.displayName} CLI version probe exited with a non-zero status.`,
      {
        exitCode: versionOutput.code,
        stdoutLength: versionOutput.stdout.length,
        stderrLength: versionOutput.stderr.length,
      },
    );
    return buildServerProvider({
      presentation,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `${brand.displayName} CLI is installed but failed to run.`,
      },
    });
  }

  const credentialStateExists = yield* ompCredentialStateExists(environment);
  if (!credentialStateExists) {
    return buildServerProvider({
      presentation,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: `${brand.displayName} is installed but has no local credentials (\`${brand.configDir}\`). Run \`${brand.binaryName}\` to sign in, then retry.`,
      },
    });
  }

  return buildServerProvider({
    presentation,
    enabled: ompSettings.enabled,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

/**
 * Republish the snapshot with version-advisory metadata and, when OMP is
 * authenticated, its live model catalog. The catalog is discovered here (not in
 * {@link checkOmpProviderStatus}) via a short-lived ACP session so the default
 * status refresh stays a cheap, local binary/credential check. ACP startup is
 * local IPC, but is still timed out and failure-tolerant: on any error the
 * snapshot keeps its settings-derived fallback catalog.
 */
export const enrichOmpSnapshot = (input: {
  readonly settings: OmpSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<void, never, Crypto.Crypto> => {
  const { settings, snapshot, publishSnapshot } = input;
  const environment = input.environment ?? process.env;

  if (!settings.enabled) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    let snapshotWithCatalog = snapshot;
    if (snapshot.auth.status !== "unauthenticated") {
      const discoveryExit = yield* discoverOmpModelsViaAcp(
        settings,
        input.childProcessSpawner,
        environment,
      ).pipe(Effect.timeoutOption(OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS), Effect.exit);

      if (Exit.isFailure(discoveryExit)) {
        yield* Effect.logWarning("Oh My Pi ACP model discovery failed", {
          errorTag: causeErrorTag(discoveryExit.cause),
        });
      } else if (Option.isNone(discoveryExit.value)) {
        yield* Effect.logWarning(
          `Oh My Pi ACP model discovery timed out after ${OMP_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
        );
      } else if (discoveryExit.value.value.length > 0) {
        snapshotWithCatalog = {
          ...snapshot,
          models: [...ompModelsFromSettings(settings.customModels, discoveryExit.value.value)],
        };
      }
    }

    const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
      snapshotWithCatalog,
      input.maintenanceCapabilities,
      { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
    ).pipe(Effect.provideService(HttpClient.HttpClient, input.httpClient));

    yield* publishSnapshot(enriched);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi snapshot enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
