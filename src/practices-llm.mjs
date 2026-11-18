// The API-key path of the model practices: the person's own messages, already
// redacted in out/practices-input.json, go to the person's own Anthropic key in
// batches; the answers are checked before anything is written.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TONE_RULE } from "./practices-rules.mjs";
import { validateModelAnswers } from "./practices.mjs";

export const PRACTICES_BATCH = 10;

export function practicesPrompt(practices) {
  const list = practices.map((p) => {
    const lines = [`- ${p.id}: ${p.definition}`];
    if (p.positive?.length) lines.push(`  yes, for example: ${p.positive.map((x) => JSON.stringify(x)).join("; ")}`);
    if (p.negative?.length) lines.push(`  no, for example: ${p.negative.map((x) => JSON.stringify(x)).join("; ")}`);
    return lines.join("\n");
  });
  return [
    "You classify work sessions between a person and an AI coding agent. For each session you get only the person's own messages, in order.",
    "For each practice below, answer true when the person's messages in that session show it, and false otherwise.",
    "",
    "Practices:",
    ...list,
    "",
    "Judge only what the messages say. When in doubt, answer false.",
    TONE_RULE,
    "",
    "Reply with JSON only: an object keyed by the given session ids, each value an object with exactly the given practice ids as keys and true or false as values. Nothing else: no reasons, no quotes, no other keys, no text around it.",
  ].join("\n");
}

const parseAnswer = (text) => JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim());

// input: { practices: [{ id, definition, ... }], sessions: [{ id, messages }] }
export async function classifyPractices(input, { call }) {
  const system = practicesPrompt(input.practices);
  const ids = input.practices.map((p) => p.id);
  const answers = {};
  const total = Math.ceil(input.sessions.length / PRACTICES_BATCH);
  for (let i = 0; i < input.sessions.length; i += PRACTICES_BATCH) {
    const sessions = input.sessions.slice(i, i + PRACTICES_BATCH);
    const batch = `batch ${i / PRACTICES_BATCH + 1} of ${total}`;
    const user = JSON.stringify({ practices: ids, sessions });
    let parsed;
    try {
      parsed = parseAnswer(await call({ system, user }));
    } catch (e) {
      throw new Error(`practices ${batch}: ${e.message}`);
    }
    const v = validateModelAnswers(parsed, sessions, ids);
    if (!v.ok) throw new Error(`practices ${batch}: ${v.error}`);
    Object.assign(answers, parsed);
  }
  return answers;
}

// The generate step. Returns "written", "hint" (no key) or "none" (no input).
export async function runPracticesStep(out, { key, call, warn, log = console.log }) {
  const inputFile = join(out, "practices-input.json");
  if (!existsSync(inputFile)) return "none";
  if (!key) {
    log("      model practices not classified yet (no API key).");
    log("      Inside Claude Code:  /rebase-verify   (your own model classifies them and finalizes)");
    return "hint";
  }
  warn?.();
  const input = JSON.parse(readFileSync(inputFile, "utf8"));
  const answers = await classifyPractices(input, { call });
  writeFileSync(join(out, "practices.json"), JSON.stringify(answers, null, 2));
  return "written";
}
