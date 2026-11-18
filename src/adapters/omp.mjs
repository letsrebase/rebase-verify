// oh-my-pi (omp) adapter. omp is a pi fork and writes pi's session format, so
// parsing is shared with pi.mjs (readPiFormat); this file only decides WHICH
// files are the person's sessions and names omp's tools.
//
// On-disk layout (established from file names only):
//   ~/.omp/agent/sessions/<encoded cwd>/<ts>_<id>.jsonl      the session
//   ~/.omp/agent/sessions/<encoded cwd>/<ts>_<id>/           per-session dir:
//       __advisor.reviewer.jsonl   advisor transcript
//       <AgentName>.jsonl          subagent transcripts (also nested deeper)
//       changes.jsonl, blobs/      bookkeeping and tool-output blobs
// Only the top-level <encoded cwd>/<ts>_<id>.jsonl files are read. Everything
// inside a per-session directory is a subagent, advisor or bookkeeping file:
// reading them would double-count the same work as extra sessions.

import { join, sep } from "node:path";
import { homedir } from "node:os";
import { readPiFormat, mapToolWith } from "./pi.mjs";

export const AGENT_RUN_MARKER = "rebase-verify-agent-run-";

// A session recorded from one of rebase-verify's own agent runs (narrative or
// classification turns) is never the person's work. Matches the RAW cwd, not
// the redacted one. Separate from digest.isEphemeral: os.tmpdir() is not under
// /tmp on every machine.
export function isAgentRun(cwd) {
  return typeof cwd === "string" && cwd.includes(AGENT_RUN_MARKER);
}

export function defaultOmpRoot() {
  return join(homedir(), ".omp", "agent", "sessions");
}

// Tool names observed in real omp sessions (counts by name only), mapped to
// the canonical Claude Code names. Unlisted names fall through: omp's own
// "mcp__server__tool" names are already canonical and stay as they are.
const OMP_TOOL_MAP = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  ast_edit: "Edit",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  task: "Task",
  todo: "TodoWrite",
  web_search: "WebSearch",
};
const piMap = mapToolWith(OMP_TOOL_MAP);
function mapOmpTool(name) {
  if (typeof name !== "string") return name;
  const n = name.trim();
  if (n.startsWith("mcp__")) return n;
  return piMap(n);
}

// relPath is relative to the sessions root: <encoded cwd>/<file>.
function isTopLevelSession(relPath) {
  const parts = relPath.split(sep);
  return parts.length === 2 && !parts[1].includes("__advisor");
}

export function readOmp(root) {
  return readPiFormat(root, { source: "omp", mapTool: mapOmpTool, includeFile: isTopLevelSession });
}
