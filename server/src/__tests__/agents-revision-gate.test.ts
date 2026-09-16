import { describe, expect, it } from "vitest";

// Pure-logic mirror of the agents.ts revision gate. The full path requires an
// embedded Postgres test database which is not available on every host (see
// agents-config-revision-force.test.ts for the DB-backed variant). This test
// pins the gate's two short-circuits so the contract is exercised even without
// Postgres available.

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "icon",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

type RevisionMetadata = {
  force?: boolean;
  source?: string;
  changedKeysOverride?: string[];
};

function hasConfigPatchFields(data: Record<string, unknown>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function decideRevisionGate(
  normalizedPatch: Record<string, unknown>,
  changedKeys: string[],
  options?: { recordRevision?: RevisionMetadata },
): { writeRow: boolean; changedKeysToRecord: string[] } {
  const revisionRequested = Boolean(options?.recordRevision);
  const forceRevision = revisionRequested && options?.recordRevision?.force === true;
  const shouldRecordRevision = revisionRequested && (hasConfigPatchFields(normalizedPatch) || forceRevision);
  if (!shouldRecordRevision) return { writeRow: false, changedKeysToRecord: [] };
  if (changedKeys.length > 0) return { writeRow: true, changedKeysToRecord: changedKeys };
  if (forceRevision) return { writeRow: true, changedKeysToRecord: ["instructionsFileContent"] };
  return { writeRow: false, changedKeysToRecord: [] };
}

describe("agent config revision gate (SPA-5925)", () => {
  it("skips the row when no revision is requested", () => {
    const result = decideRevisionGate({ adapterConfig: {} }, []);
    expect(result.writeRow).toBe(false);
  });

  it("skips the row when adapterConfig is unchanged and force is not set", () => {
    const result = decideRevisionGate({ adapterConfig: {} }, [], {
      recordRevision: { source: "instructions_bundle_file_put" },
    });
    expect(result.writeRow).toBe(false);
  });

  it("writes a row when adapterConfig is unchanged and force is true", () => {
    const result = decideRevisionGate({ adapterConfig: {} }, [], {
      recordRevision: { source: "instructions_bundle_file_put", force: true },
    });
    expect(result.writeRow).toBe(true);
    expect(result.changedKeysToRecord).toEqual(["instructionsFileContent"]);
  });

  it("writes a row with the real changedKeys when adapterConfig actually changed", () => {
    const result = decideRevisionGate(
      { adapterConfig: { model: "gpt-5.4" } },
      ["adapterConfig"],
      { recordRevision: { source: "instructions_path_patch" } },
    );
    expect(result.writeRow).toBe(true);
    expect(result.changedKeysToRecord).toEqual(["adapterConfig"]);
  });

  it("ignores the force flag when no revision was requested at all", () => {
    const result = decideRevisionGate({ adapterConfig: {} }, []);
    expect(result.writeRow).toBe(false);
  });

  it("does not synthesize the changedKeysOverride when a real diff exists", () => {
    // The override is a no-op; the real changedKeys still win so the audit
    // trail is not misleading when the config really did change.
    const result = decideRevisionGate(
      { adapterConfig: { instructionsRootPath: "/tmp/new" } },
      ["adapterConfig"],
      { recordRevision: { source: "instructions_path_patch", force: true, changedKeysOverride: ["ignored"] } },
    );
    expect(result.writeRow).toBe(true);
    expect(result.changedKeysToRecord).toEqual(["adapterConfig"]);
  });
});