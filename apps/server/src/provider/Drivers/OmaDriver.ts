/**
 * OmaDriver — Oh My Pi Agents (`oma`) provider.
 *
 * OMA is the persistent-entity fork of OMP. It is an *additive graft*: OMP's
 * tool/session/ACP machinery is untouched, so `oma acp` speaks the exact same
 * ACP v1 surface as `omp acp` (protocol v1, model/mode/thinking via
 * `configOptions`). This driver therefore reuses the OMP adapter, text
 * generation, and snapshot probe verbatim — the only OMA-specific wiring is:
 *
 *   - default binary `oma` (from {@link OmaSettings}),
 *   - `PI_CONFIG_DIR=.oma` injected into the provider environment so both the
 *     spawned `oma acp` process and the credential probe resolve `~/.oma`
 *     (OMA isolates its state there, side by side with stock `omp`).
 *
 * @module OmaDriver
 */
import { OmaSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  enrichOmpSnapshot,
  type OmpBrand,
} from "../Layers/OmpProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOmaSettings = Schema.decodeSync(OmaSettings);

const DRIVER_KIND = ProviderDriverKind.make("oma");
const DEFAULT_DISPLAY_NAME = "Oh My Pi Agents";
/** OMA's config-root marker; keeps its broker/sessions/creds under `~/.oma`. */
const OMA_CONFIG_DIR = ".oma";
/** OMA's brand: names `oma`/`~/.oma` in status guidance instead of omp's. */
const OMA_BRAND: OmpBrand = {
  displayName: DEFAULT_DISPLAY_NAME,
  binaryName: "oma",
  configDir: "~/.oma",
};
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type OmaDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OmaDriver: ProviderDriver<OmaSettings, OmaDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: DEFAULT_DISPLAY_NAME,
    supportsMultipleInstances: true,
  },
  configSchema: OmaSettings,
  defaultConfig: (): OmaSettings => decodeOmaSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const baseEnv = mergeProviderInstanceEnvironment(environment);
      // Default the config root to `~/.oma` unless the user pinned one. This
      // reaches both the spawned `oma acp` and the credential probe, so status
      // reflects OMA's own auth state rather than stock omp's.
      const processEnv =
        baseEnv.PI_CONFIG_DIR !== undefined
          ? baseEnv
          : { ...baseEnv, PI_CONFIG_DIR: OMA_CONFIG_DIR };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OmaSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeOmpAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeOmpTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOmpProviderStatus(effectiveConfig, processEnv, OMA_BRAND).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmaSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOmpProviderSnapshot(settings.provider, OMA_BRAND).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichOmpSnapshot({
            settings: settings.provider,
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
            childProcessSpawner: spawner,
            environment: processEnv,
          }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Oh My Pi Agents snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
