// rebase-verify's own agent runs (narrative and classification turns) start in
// a fresh dir named with this marker; transcripts they leave in an agent's
// session store are never the person's work.
export const AGENT_RUN_MARKER = "rebase-verify-agent-run-";

// Matches a RAW cwd (or any path carrying it). Separate from
// digest.isEphemeral: os.tmpdir() is not under /tmp on every machine.
export function isAgentRun(cwd) {
  return typeof cwd === "string" && cwd.includes(AGENT_RUN_MARKER);
}
