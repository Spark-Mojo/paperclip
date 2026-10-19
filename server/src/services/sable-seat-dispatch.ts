/**
 * SPA-13735 (d1) — Sable seat dispatch qualifier + dedupe key.
 *
 * Pure functions only: no DB, no network, no issue creation. The engine event
 * wiring (which PR event calls these, and the SPA-13661 overlap check) is a
 * later leaf; this module is the qualifier + dedupe-key half of the DoD.
 */

export interface NamedPathPattern {
  /** Stable id surfaced in QualifyResult.matchedPatterns. */
  id: string;
  test: RegExp;
  /** Files matching an exclude never match this pattern (e.g. src/containers). */
  excludes?: RegExp[];
}

/**
 * Compose/infra/secrets/provisioning surfaces that qualify a PR for Sable
 * review. Each pattern is anchored to a path segment or a specific basename
 * so near-miss words (benchmark, workbench, src/containers) do not qualify.
 */
export const QUALIFYING_PATH_PATTERNS: NamedPathPattern[] = [
  { id: "docker-compose", test: /(^|\/)docker-compose[^/]*$/i },
  // Dockerfile, Dockerfile.prod — but not Dockerfile-guide.md (trailing
  // prose after a "-" is a doc, not a build surface).
  { id: "dockerfile", test: /(^|\/)Dockerfile(\.[^/]*)?$/i },
  { id: "gh-workflows", test: /\.github\/workflows\//i },
  { id: "infra", test: /(^|\/)infra\//i },
  { id: "secrets", test: /(^|\/)secrets?\//i },
  { id: "provisioning", test: /(^|\/)provisioning([/._-]|$)/i },
  { id: "deploy", test: /(^|\/)deploy\//i },
  { id: "certs", test: /(^|\/)certs?\//i },
  // Path segment `bench` (bench/, bench.config) or a Benchfile basename —
  // never benchmark/ or workbench.
  { id: "bench", test: /(^|[/._-])bench([/._-]|$)|(^|\/)benchfile/i },
  // Infra container surfaces only (.devcontainer/, Containerfile,
  // containers/ outside src/). React src/containers/ is app code, not infra.
  {
    id: "container",
    test: /(^|\/)(\.devcontainer\/|containerfile([^/]*)$|containers?\/)/i,
    excludes: [/(^|\/)src\/containers\//i],
  },
];

export interface PrFileStats {
  changedFiles: string[];
  additions?: number;
  deletions?: number;
}

export interface QualifyResult {
  qualifies: boolean;
  matchedPatterns: string[];
}

export function prQualifiesForSableSeat(input: PrFileStats): QualifyResult {
  const files = Array.isArray(input?.changedFiles) ? input.changedFiles : [];
  const matched = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) continue;
    for (const pattern of QUALIFYING_PATH_PATTERNS) {
      if (pattern.excludes?.some((ex) => ex.test(file))) continue;
      if (pattern.test.test(file)) matched.add(pattern.id);
    }
  }
  return { qualifies: matched.size > 0, matchedPatterns: [...matched] };
}

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Fail-closed: null/invalid ref returns null (never a key for garbage). */
export function isValidPrRef(ref: unknown): ref is PrRef {
  if (ref === null || ref === undefined || typeof ref !== "object") return false;
  const r = ref as Record<string, unknown>;
  return (
    typeof r.owner === "string" &&
    r.owner.trim().length > 0 &&
    typeof r.repo === "string" &&
    r.repo.trim().length > 0 &&
    typeof r.number === "number" &&
    Number.isSafeInteger(r.number) &&
    r.number > 0
  );
}

/**
 * Stable dedupe key so a second filer (SPA-13661 arming path) can check
 * overlap and not double-file a seat card for the same PR. Owner/repo are
 * lowercased so `Spark-Mojo/x` and `spark-mojo/x` share one key. Returns
 * null for a null/invalid ref — callers must not file on null.
 */
export function dedupeKey(ref: PrRef | null | undefined): string | null {
  if (!isValidPrRef(ref)) return null;
  const owner = ref.owner.trim().toLowerCase();
  const repo = ref.repo.trim().toLowerCase();
  return `sable-seat:${owner}/${repo}#${ref.number}`;
}

/** Seat card title for a qualifying PR. */
export function seatCardTitle(ref: PrRef): string {
  return `Sable review: ${ref.owner}/${ref.repo}#${ref.number}`;
}
