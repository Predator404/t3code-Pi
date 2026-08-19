import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OmaDriver } from "./OmaDriver.ts";

describe("OmaDriver", () => {
  it("declares the oma driver identity", () => {
    expect(OmaDriver.driverKind).toBe("oma");
    expect(OmaDriver.metadata.displayName).toBe("Oh My Pi Agents");
    expect(OmaDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("defaults to the `oma` binary and is opt-in (disabled)", () => {
    const config = OmaDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    // Guarantees the reused OMP ACP spawn builder gets `oma`, never the `omp`
    // fallback — the whole point of a distinct oma driver.
    expect(config.binaryPath).toBe("oma");
  });

  it("is registered as a built-in driver alongside omp", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(kinds).toContain("oma");
    expect(kinds).toContain("omp");
  });
});
