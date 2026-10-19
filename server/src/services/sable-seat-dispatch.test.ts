import { describe, expect, it } from "vitest";
import {
  dedupeKey,
  prQualifiesForSableSeat,
  seatCardTitle,
} from "./sable-seat-dispatch.js";

describe("prQualifiesForSableSeat — SPA-13735", () => {
  it("qualifies on a compose path", () => {
    const result = prQualifiesForSableSeat({
      changedFiles: ["docker-compose.yml"],
      additions: 10,
      deletions: 2,
    });
    expect(result.qualifies).toBe(true);
    expect(result.matchedPatterns).toContain("docker-compose");
  });

  it("qualifies on a secrets path", () => {
    const result = prQualifiesForSableSeat({
      changedFiles: ["secrets/prod.env"],
      additions: 1,
      deletions: 0,
    });
    expect(result.qualifies).toBe(true);
  });

  it("qualifies on provisioning and Dockerfile basenames", () => {
    expect(
      prQualifiesForSableSeat({ changedFiles: ["provisioning/setup.sh"] })
        .qualifies,
    ).toBe(true);
    expect(
      prQualifiesForSableSeat({ changedFiles: ["Dockerfile.prod"] })
        .matchedPatterns,
    ).toContain("dockerfile");
  });

  it("refuses an unrelated docs path (not qualifies)", () => {
    const result = prQualifiesForSableSeat({
      changedFiles: ["docs/README.md"],
      additions: 5,
      deletions: 1,
    });
    expect(result.qualifies).toBe(false);
    expect(result.matchedPatterns).toEqual([]);
  });

  it("refuses empty changedFiles (not qualifies)", () => {
    const result = prQualifiesForSableSeat({ changedFiles: [], additions: 0, deletions: 0 });
    expect(result.qualifies).toBe(false);
  });

  it("does not match bench near-misses (benchmark, workbench)", () => {
    expect(
      prQualifiesForSableSeat({ changedFiles: ["perf/benchmark/results.md"] })
        .qualifies,
    ).toBe(false);
    expect(
      prQualifiesForSableSeat({ changedFiles: ["src/workbench/panel.ts"] })
        .qualifies,
    ).toBe(false);
    // Positive control: real bench surface still qualifies.
    expect(
      prQualifiesForSableSeat({ changedFiles: ["sites/bench.config.json"] })
        .qualifies,
    ).toBe(true);
  });

  it("does not match React src/containers (infra containers only)", () => {
    expect(
      prQualifiesForSableSeat({
        changedFiles: ["frontend/src/containers/Dashboard.tsx"],
      }).qualifies,
    ).toBe(false);
    // Positive control: infra container surface still qualifies.
    expect(
      prQualifiesForSableSeat({ changedFiles: [".devcontainer/devcontainer.json"] })
        .qualifies,
    ).toBe(true);
  });

  it("does not match Dockerfile prose (Dockerfile-guide.md)", () => {
    expect(
      prQualifiesForSableSeat({ changedFiles: ["docs/Dockerfile-guide.md"] })
        .qualifies,
    ).toBe(false);
    expect(
      prQualifiesForSableSeat({ changedFiles: ["Dockerfile"] }).qualifies,
    ).toBe(true);
  });

  it("qualifies gh-workflows only at the repo root", () => {
    expect(
      prQualifiesForSableSeat({ changedFiles: [".github/workflows/ci.yml"] })
        .matchedPatterns,
    ).toContain("gh-workflows");
    expect(
      prQualifiesForSableSeat({
        changedFiles: ["docs/.github/workflows/example.yml"],
      }).qualifies,
    ).toBe(false);
    expect(
      prQualifiesForSableSeat({
        changedFiles: ["fake.github/workflows/example.yml"],
      }).qualifies,
    ).toBe(false);
  });

  it("does not match bench prose (my-bench-notes, benchfile-guide)", () => {
    expect(
      prQualifiesForSableSeat({
        changedFiles: ["docs/my-bench-notes.md"],
      }).qualifies,
    ).toBe(false);
    expect(
      prQualifiesForSableSeat({
        changedFiles: ["docs/benchfile-guide.md"],
      }).qualifies,
    ).toBe(false);
    // Positive control: real bench surface still qualifies.
    expect(
      prQualifiesForSableSeat({ changedFiles: ["sites/bench.config.json"] })
        .qualifies,
    ).toBe(true);
  });

  it("qualifies bench-setup.sh but not root my-bench-notes.md (left-anchor)", () => {
    // Right-side `-` delimiter restored: root bench-setup.sh qualifies.
    expect(
      prQualifiesForSableSeat({ changedFiles: ["bench-setup.sh"] })
        .matchedPatterns,
    ).toContain("bench");
    // Left side stays segment-anchored: a `my-` prefix blocks the match
    // even at root (no directory prefix to hide behind).
    expect(
      prQualifiesForSableSeat({ changedFiles: ["my-bench-notes.md"] })
        .qualifies,
    ).toBe(false);
    // Positive controls: bare dir segment and bare Benchfile still qualify.
    expect(
      prQualifiesForSableSeat({ changedFiles: ["bench/"] }).qualifies,
    ).toBe(true);
    expect(
      prQualifiesForSableSeat({ changedFiles: ["Benchfile"] }).qualifies,
    ).toBe(true);
  });

  it("ignores malformed changedFiles entries", () => {
    const result = prQualifiesForSableSeat({
      // @ts-expect-error — nulls/numbers are tolerated, not thrown.
      changedFiles: [null, 42, "", "docs/notes.md"],
    });
    expect(result.qualifies).toBe(false);
  });
});

describe("dedupeKey / seatCardTitle — SPA-13735", () => {
  it("dedupeKey is stable for the same PR (lowercased)", () => {
    const ref = { owner: "Spark-Mojo", repo: "paperclip", number: 42 };
    expect(dedupeKey(ref)).toBe(dedupeKey({ ...ref }));
    expect(dedupeKey(ref)).toBe("sable-seat:spark-mojo/paperclip#42");
  });

  it("dedupeKey canonicalizes owner/repo case", () => {
    expect(
      dedupeKey({ owner: "Spark-Mojo", repo: "Paperclip", number: 42 }),
    ).toBe(dedupeKey({ owner: "spark-mojo", repo: "paperclip", number: 42 }));
  });

  it("dedupeKey is distinct per PR", () => {
    expect(dedupeKey({ owner: "o", repo: "r", number: 1 })).not.toBe(
      dedupeKey({ owner: "o", repo: "r", number: 2 }),
    );
  });

  it("dedupeKey fails closed on null/invalid ref", () => {
    expect(dedupeKey(null)).toBeNull();
    expect(dedupeKey(undefined)).toBeNull();
    // @ts-expect-error — missing fields are tolerated, not thrown.
    expect(dedupeKey({})).toBeNull();
    expect(dedupeKey({ owner: "", repo: "r", number: 1 })).toBeNull();
    expect(dedupeKey({ owner: "o", repo: "r", number: 0 })).toBeNull();
    expect(dedupeKey({ owner: "o", repo: "r", number: -3 })).toBeNull();
    expect(dedupeKey({ owner: "o", repo: "r", number: 1.5 })).toBeNull();
    expect(
      dedupeKey({ owner: "o", repo: "r", number: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeNull();
  });

  it("seatCardTitle names the PR", () => {
    expect(seatCardTitle({ owner: "o", repo: "r", number: 7 })).toBe("Sable review: o/r#7");
  });
});
