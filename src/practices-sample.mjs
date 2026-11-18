// The sample the model step reads: the person's own words only, from at most
// MAX_SESSIONS sessions spread over products and months. Real session ids,
// products and months stay in the local sample file; the model sees `sNN`.
import { DEFAULT_TZ, dayKeyFor } from "./days.mjs";
import { eachSession } from "./practices.mjs";
import { RUBRIC } from "./practices-rules.mjs";
import { redactText } from "./redact.mjs";
import { scrubProperNouns } from "./profile-llm.mjs";
import { SYSTEM_PROMPT_RE } from "./system-text.mjs";

export const MAX_SESSIONS = 60;
export const MAX_MESSAGES = 12;
export const MAX_CHARS = 600;

// Only what the person typed: not sub-agent briefs (sidechain records), injected
// or compaction records, nor the framework's own prompts.
const ownTexts = (session) =>
  (Array.isArray(session?.messages) ? session.messages : [])
    .filter(
      (m) =>
        m?.role === "user" &&
        !m.isSidechain &&
        !m.isMeta &&
        !m.isCompactSummary &&
        typeof m.textRedacted === "string" &&
        m.textRedacted.trim() !== "" &&
        !SYSTEM_PROMPT_RE.test(m.textRedacted.trim()),
    )
    .map((m) => m.textRedacted);

// The person's own messages: the first and evenly spaced ones when there are
// more than MAX_MESSAGES, each cut, redacted and scrubbed of proper nouns.
export function personMessages(session) {
  const all = ownTexts(session);
  let picked = all;
  if (all.length > MAX_MESSAGES) {
    const idx = new Set();
    for (let k = 0; k < MAX_MESSAGES; k++) idx.add(Math.round((k * (all.length - 1)) / (MAX_MESSAGES - 1)));
    picked = [...idx].sort((a, b) => a - b).map((i) => all[i]);
  }
  return picked.map((t) => scrubProperNouns(redactText(t.slice(0, MAX_CHARS))));
}

const asc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function sampleSessions(parsed, { tz = DEFAULT_TZ } = {}) {
  const dayKey = dayKeyFor(tz);
  const products = new Map(); // product -> Map(month -> entries[])
  for (const { session, meta } of eachSession(parsed, tz)) {
    if (!meta.month || ownTexts(session).length < 2) continue; // no time: cannot be placed in a month
    let ts = null;
    for (const m of session.messages) {
      const t = m?.ts ? Date.parse(m.ts) : NaN;
      if (Number.isFinite(t)) { ts = t; break; }
    }
    const entry = { session: meta.id, date: dayKey(ts), product: meta.product, month: meta.month, raw: session };
    if (!products.has(meta.product)) products.set(meta.product, new Map());
    const months = products.get(meta.product);
    if (!months.has(entry.month)) months.set(entry.month, []);
    months.get(entry.month).push(entry);
  }
  const lanes = [...products.keys()].sort(asc).map((p) => {
    const months = products.get(p);
    return { buckets: [...months.keys()].sort(asc).map((m) => months.get(m).slice()), next: 0 };
  });
  const out = [];
  while (out.length < MAX_SESSIONS && lanes.some((l) => l.buckets.some((b) => b.length))) {
    for (const lane of lanes) {
      if (out.length >= MAX_SESSIONS) break;
      for (let tries = 0; tries < lane.buckets.length; tries++) {
        const b = lane.buckets[lane.next % lane.buckets.length];
        lane.next++;
        if (b.length) {
          const e = b.shift();
          const id = `s${String(out.length + 1).padStart(2, "0")}`;
          out.push({ id, session: e.session, date: e.date, product: e.product, month: e.month, messages: personMessages(e.raw) });
          break;
        }
      }
    }
  }
  return out;
}

// What the model reads: opaque ids and the person's messages, nothing else.
export function buildPracticesInput(parsed, { tz = DEFAULT_TZ, practices = [], sample = sampleSessions(parsed, { tz }) } = {}) {
  return {
    rubric: RUBRIC,
    practices: practices.map((p) => ({
      id: p.id,
      definition: p.definition,
      ...(p.positive ? { positive: p.positive } : {}),
      ...(p.negative ? { negative: p.negative } : {}),
    })),
    sessions: sample.map((s) => ({ id: s.id, messages: s.messages })),
  };
}

// The local-only sample file: the real session behind each opaque id.
export function sampleFile(sample) {
  return sample.map(({ id, session, date, product, month }) => ({ id, session, date, product, month }));
}

// What to write, or null when nothing is published or nothing was sampled.
export function practicesFiles(parsed, { tz = DEFAULT_TZ, practices = [] } = {}) {
  if (!practices.length) return null;
  const sample = sampleSessions(parsed, { tz });
  if (!sample.length) return null;
  return { input: buildPracticesInput(parsed, { tz, practices, sample }), sample: sampleFile(sample) };
}
