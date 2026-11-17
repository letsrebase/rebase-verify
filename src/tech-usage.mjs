// Technology usage: for each technology the stack detection saw, how often it
// shows up across ALL products. Pure counts from the per-product clusters, no
// model, no PII, never a score (ADR-001): the band is a plain-language label
// for the counts printed next to it, nothing more.
//
// Source of the names: the very same `tech` arrays the projects carry, i.e.
// detectStack() in src/digest.mjs. That function can only emit labels from its
// fixed maps (labelVocabulary()), so a name here is always a public technology
// label, never a repo, client or private package name. A custom or private
// dependency matches no map entry and therefore never appears.
//
// Counts, per technology:
//   - products: products whose detected stack includes it
//   - sessions: sessions of those products. The stack is detected per product
//     (dependency manifests, file extensions, shell commands), not per session,
//     so this is "sessions in products where it was detected": an upper bound
//     on sessions that touched it, stated as such in the docs.
//   - months: distinct calendar months in which those products had real message
//     activity, bucketed in the recorded timezone (same --tz as the day counts)
//   - firstMonth / lastMonth: earliest and latest of those months
//
// Band, derived only from `months` and the span first..last (inclusive):
//   continuous  present in 6+ distinct months AND in at least 75% of the months
//               between its first and last month
//   recurring   present in 3+ distinct months (not continuous)
//   occasional  present in 1-2 distinct months
// Like the cognitive-tag thresholds these are EMPIRICAL: chosen so that a
// stack used all year reads differently from one touched in a single sprint.
// They are not calibrated against outcomes and say nothing about skill.

import { DEFAULT_TZ } from "./days.mjs";

export const BAND_CONTINUOUS_MIN_MONTHS = 6;
export const BAND_CONTINUOUS_MIN_COVERAGE = 0.75;
export const BAND_RECURRING_MIN_MONTHS = 3;

// Inclusive number of calendar months from a to b ("YYYY-MM").
export function monthSpan(a, b) {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma) + 1;
}

// The band from the counts alone, so submit-time structure checks can verify a
// claimed band against the claimed counts without any logs.
export function bandFor({ months, firstMonth, lastMonth }) {
  if (!(months >= 1) || !firstMonth || !lastMonth) return null;
  const span = monthSpan(firstMonth, lastMonth);
  if (months >= BAND_CONTINUOUS_MIN_MONTHS && months / span >= BAND_CONTINUOUS_MIN_COVERAGE) return "continuous";
  if (months >= BAND_RECURRING_MIN_MONTHS) return "recurring";
  return "occasional";
}

// `projects`: digest projects (all of them, not just the representatives).
export function computeTechUsage(projects, { tz = DEFAULT_TZ } = {}) {
  const byTech = new Map();
  for (const p of projects ?? []) {
    for (const name of new Set(p.tech ?? [])) {
      let t = byTech.get(name);
      if (!t) byTech.set(name, (t = { name, sessions: 0, products: 0, monthSet: new Set() }));
      t.products++;
      t.sessions += p.sessions ?? 0;
      for (const m of p.months ?? []) t.monthSet.add(m);
    }
  }
  const technologies = [...byTech.values()]
    .filter((t) => t.monthSet.size > 0)
    .map((t) => {
      const ms = [...t.monthSet].sort();
      const row = { name: t.name, sessions: t.sessions, products: t.products, months: ms.length, firstMonth: ms[0], lastMonth: ms.at(-1) };
      return { ...row, band: bandFor(row) };
    })
    .sort((a, b) => b.sessions - a.sessions || b.months - a.months || a.name.localeCompare(b.name));
  if (!technologies.length) return null;
  return { timezone: tz, technologies };
}
