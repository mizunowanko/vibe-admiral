import { describe, expect, it } from "vitest";
import {
  buildShipEnv,
  buildEscortEnv,
  buildCommanderEnv,
  verifyEnvHash,
  toLaunchRecord,
} from "../launch-environment.js";

describe("buildShipEnv", () => {
  it("produces all required fields", () => {
    const env = buildShipEnv({
      shipId: "ship-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
    });
    expect(env.VIBE_ADMIRAL).toBe("true");
    expect(env.VIBE_ADMIRAL_SHIP_ID).toBe("ship-001");
    expect(env.VIBE_ADMIRAL_MAIN_REPO).toBe("owner/repo");
    expect(env.VIBE_ADMIRAL_FLEET_ID).toBe("fleet-1");
    expect(env.VIBE_ADMIRAL_ENGINE_PORT).toBe("9721");
    expect(env.VIBE_ADMIRAL_ENV_HASH).toBeTruthy();
  });

  it("uses custom engine port", () => {
    const env = buildShipEnv({
      shipId: "ship-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
      enginePort: "8080",
    });
    expect(env.VIBE_ADMIRAL_ENGINE_PORT).toBe("8080");
  });

  it("produces a valid env hash", () => {
    const env = buildShipEnv({
      shipId: "ship-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
    });
    expect(verifyEnvHash(env)).toBe(true);
  });
});

describe("buildEscortEnv", () => {
  it("includes parent ship ID", () => {
    const env = buildEscortEnv({
      escortId: "escort-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
      parentShipId: "ship-001",
    });
    expect(env.VIBE_ADMIRAL_PARENT_SHIP_ID).toBe("ship-001");
    expect(env.VIBE_ADMIRAL_SHIP_ID).toBe("escort-001");
  });

  it("includes gate prompt when provided", () => {
    const env = buildEscortEnv({
      escortId: "escort-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
      parentShipId: "ship-001",
      gatePrompt: "custom gate prompt",
    });
    expect(env.VIBE_ADMIRAL_GATE_PROMPT).toBe("custom gate prompt");
  });

  it("omits gate prompt when not provided", () => {
    const env = buildEscortEnv({
      escortId: "escort-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
      parentShipId: "ship-001",
    });
    expect(env.VIBE_ADMIRAL_GATE_PROMPT).toBeUndefined();
  });

  it("produces a valid env hash", () => {
    const env = buildEscortEnv({
      escortId: "escort-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
      parentShipId: "ship-001",
    });
    expect(verifyEnvHash(env)).toBe(true);
  });
});

describe("buildCommanderEnv", () => {
  it("produces fleet ID and DB path", () => {
    const env = buildCommanderEnv({ fleetId: "fleet-1" });
    expect(env.VIBE_ADMIRAL_FLEET_ID).toBe("fleet-1");
    expect(env.VIBE_ADMIRAL_DB_PATH).toContain("fleet.db");
    expect(env.VIBE_ADMIRAL_ENV_HASH).toBeTruthy();
  });

  it("produces a valid env hash", () => {
    const env = buildCommanderEnv({ fleetId: "fleet-1" });
    expect(verifyEnvHash(env)).toBe(true);
  });
});

describe("verifyEnvHash", () => {
  it("returns false for tampered env", () => {
    const env = buildShipEnv({
      shipId: "ship-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
    });
    const tampered = { ...env, VIBE_ADMIRAL_FLEET_ID: "fleet-HACKED" as any };
    expect(verifyEnvHash(tampered)).toBe(false);
  });
});

describe("toLaunchRecord", () => {
  it("strips undefined values", () => {
    const env = buildEscortEnv({
      escortId: "escort-001",
      repo: "owner/repo",
      fleetId: "fleet-1",
      parentShipId: "ship-001",
    });
    const record = toLaunchRecord(env);
    expect(record.VIBE_ADMIRAL_GATE_PROMPT).toBeUndefined();
    expect(Object.values(record).every((v) => v !== undefined)).toBe(true);
  });
});
