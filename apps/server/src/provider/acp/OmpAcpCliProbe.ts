/**
 * OmpAcpCliProbe — cheap, local presence checks for the Oh My Pi (`omp`) CLI.
 *
 * These probes never touch the network: they run `omp --version` and look for
 * the local `~/.omp` credential state on disk. The provider snapshot builder
 * ({@link ../Layers/OmpProvider.ts}) composes them so a background status
 * refresh can never hit a model-provider rate limit.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import { type OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../../pathExpansion.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

/**
 * SQLite store OMP writes its settings + auth credentials into. Its presence is
 * the signal that OMP has been set up locally — the ACP `agent` auth method
 * reuses this state, so no separate login flow is needed on the happy path.
 */
const OMP_AUTH_STORE_FILENAME = "agent.db";

/**
 * Resolve OMP's agent config directory the way OMP itself does, honoring the
 * `PI_CODING_AGENT_DIR` override, the `PI_CONFIG_DIR` config-dir name, and the
 * active `OMP_PROFILE`/`PI_PROFILE`. XDG relocation (opt-in, Linux-only) is
 * intentionally not replicated here: a missing agent store simply reads as
 * "not authenticated", which is the correct default for the snapshot.
 */
function resolveOmpAgentDir(path: Path.Path, environment: NodeJS.ProcessEnv): string {
  const override = environment.PI_CODING_AGENT_DIR?.trim();
  if (override && override.length > 0) {
    return path.resolve(expandHomePath(override));
  }
  const configDirName = environment.PI_CONFIG_DIR?.trim() || ".omp";
  const rawProfile = (environment.OMP_PROFILE ?? environment.PI_PROFILE)?.trim();
  const profile =
    rawProfile && rawProfile.length > 0 && rawProfile !== "default" ? rawProfile : undefined;
  const configRoot = path.join(NodeOS.homedir(), configDirName);
  return profile
    ? path.join(configRoot, "profiles", profile, "agent")
    : path.join(configRoot, "agent");
}

/** Run `omp --version` and collect its output for the snapshot status probe. */
export const runOmpVersionCommand = Effect.fn("runOmpVersionCommand")(function* (
  ompSettings: Pick<OmpSettings, "binaryPath"> | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const command = ompSettings?.binaryPath || "omp";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * Detect whether OMP's local credential state exists on disk. Any filesystem
 * error is treated as "absent" so the probe stays infallible and local-only.
 */
export const ompCredentialStateExists = Effect.fn("ompCredentialStateExists")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const authStorePath = path.join(resolveOmpAgentDir(path, environment), OMP_AUTH_STORE_FILENAME);
  return yield* fileSystem.exists(authStorePath).pipe(Effect.orElseSucceed(() => false));
});
