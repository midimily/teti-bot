import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexUsagePayload } from "../lifecycle-sidecar/codex-usage/parser.ts";

const observedAt = new Date("2026-07-18T00:00:00.000Z");

test("selects standard secondary weekly bucket instead of the five-hour primary", () => {
  const snapshot = parse({
    plan_type: "plus",
    rate_limit: {
      primary: { remaining_percent: 80, limit_window_seconds: 18_000 },
      secondary: { remaining_percent: 42, limit_window_seconds: 604_800 }
    }
  });

  assert.equal(snapshot.weekly?.remainingPercent, 42);
  assert.equal(snapshot.weekly?.windowSeconds, 604_800);
  assert.equal(snapshot.weekly?.identification, "exact");
});

test("recognizes the only primary bucket when it is weekly", () => {
  const snapshot = parse({
    rate_limits: { primary_window: { used_percent: 25, window_seconds: 604_800 } }
  });
  assert.equal(snapshot.weekly?.remainingPercent, 75);
  assert.equal(snapshot.weekly?.identification, "exact");
});

test("recognizes weekly primary when secondary is a shorter bucket", () => {
  const snapshot = parse({
    rate_limit: {
      primary: { remaining_percent: 66, window_minutes: 10_080 },
      secondary: { remaining_percent: 99, window_seconds: 18_000 }
    }
  });
  assert.equal(snapshot.weekly?.remainingPercent, 66);
});

test("prefers remaining_percent, otherwise derives remaining from used_percent", () => {
  const preferred = parse({
    rate_limit: { primary: weekly({ remaining_percent: 30, used_percent: 2 }) }
  });
  const derived = parse({
    rate_limit: { primary: weekly({ used_percent: 28 }) }
  });
  assert.equal(preferred.weekly?.remainingPercent, 30);
  assert.equal(derived.weekly?.remainingPercent, 72);
  assert.equal(derived.weekly?.usedPercent, 28);
});

test("clamps percentages to zero through one hundred and rejects non-finite values", () => {
  const high = parse({ rate_limit: { primary: weekly({ remaining_percent: 140 }) } });
  const low = parse({ rate_limit: { primary: weekly({ used_percent: 140 }) } });
  const invalid = parse({ rate_limit: { primary: weekly({ remaining_percent: "80" }) } });
  assert.equal(high.weekly?.remainingPercent, 100);
  assert.equal(low.weekly?.remainingPercent, 0);
  assert.equal(invalid.weekly, null);
});

test("parses Unix seconds, Unix milliseconds, ISO dates, and relative reset seconds", () => {
  const unixSeconds = parse({
    rate_limit: { primary: weekly({ remaining_percent: 50, reset_at: 1_800_000_000 }) }
  });
  const unixMilliseconds = parse({
    rate_limit: { primary: weekly({ remaining_percent: 50, resets_at: 1_800_000_000_000 }) }
  });
  const iso = parse({
    rate_limit: { primary: weekly({ remaining_percent: 50, expires_at: "2027-01-15T08:00:00+08:00" }) }
  });
  const relative = parse({
    rate_limit: { primary: weekly({ remaining_percent: 50, reset_after_seconds: 90 }) }
  });

  assert.equal(unixSeconds.weekly?.resetAt, "2027-01-15T08:00:00.000Z");
  assert.equal(unixMilliseconds.weekly?.resetAt, "2027-01-15T08:00:00.000Z");
  assert.equal(iso.weekly?.resetAt, "2027-01-15T00:00:00.000Z");
  assert.equal(relative.weekly?.resetAt, "2026-07-18T00:01:30.000Z");
});

test("marks a longest daily-or-longer fallback window as inferred", () => {
  const snapshot = parse({
    rate_limit: {
      primary: { remaining_percent: 90, window_seconds: 86_400 },
      secondary: { remaining_percent: 60, window_seconds: 345_600 }
    }
  });
  assert.equal(snapshot.weekly?.remainingPercent, 60);
  assert.equal(snapshot.weekly?.identification, "inferred");
});

test("does not misreport short or durationless buckets as weekly", () => {
  const snapshot = parse({
    rate_limit: {
      primary: { remaining_percent: 90, window_seconds: 18_000 },
      secondary: { remaining_percent: 80 }
    }
  });
  assert.equal(snapshot.weekly, null);
});

test("preserves reported plan type without claiming membership verification or guessing display names", () => {
  const known = parse({ plan_type: "plus", rate_limit: {} });
  const missing = parse({ rate_limit: {} });
  const unknown = parse({ plan_type: "future_ultra", rate_limit: {} });

  assert.equal(known.planTypeRaw, "plus");
  assert.equal(known.membershipVerified, false);
  assert.equal(known.planDisplayName, null);
  assert.equal(missing.planTypeRaw, null);
  assert.equal(unknown.planTypeRaw, "future_ultra");
  assert.equal(unknown.planDisplayName, null);
});

test("rejects payloads without rate_limit or rate_limits", () => {
  assert.throws(
    () => parse({ plan_type: "plus" }),
    (error: Error) => error.name === "CodexUsageError" && error.message.includes("format")
  );
});

function parse(payload: unknown) {
  return parseCodexUsagePayload(payload, { observedAt, fetchedAt: observedAt });
}

function weekly(fields: Record<string, unknown>): Record<string, unknown> {
  return { window_seconds: 604_800, ...fields };
}
