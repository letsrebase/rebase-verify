// The coding agents rebase-verify can drive, how to detect them (without
// running them), how to start them over ACP, and how to remove the transcript
// a run leaves behind.
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { AGENT_RUN_MARKER } from "../agent-run.mjs";
import { MODEL } from "../profile-llm.mjs";

const NO_TOOLS_INSTRUCTION = "Do not use any tool. Answer only from the text in this message.";

const homeOf = (ctx = {}) => ctx.home ?? ctx.env?.HOME ?? ctx.env?.USERPROFILE ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const envOf = (ctx = {}) => ctx.env ?? process.env;

// An empty value counts as unset.
function envGet(env, name) {
  let v = env[name];
  if (v === undefined) {
    const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
    v = k === undefined ? undefined : env[k];
  }
  return v === undefined || v === "" ? undefined : v;
}

/** True when `name` is an executable file on PATH. Never runs it. */
export function onPath(name, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const dirs = (envGet(env, "PATH") ?? "")
    .split(win ? ";" : ":")
    .map((d) => (win ? d.replace(/^"(.*)"$/, "$1") : d))
    .filter(Boolean);
  const exts = win ? ["", ...(envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const d of dirs) {
    for (const e of exts) {
      try {
        const st = statSync(join(d, name + e));
        if (st.isFile() && (win || (st.mode & 0o111) !== 0)) return true;
      } catch {}
    }
  }
  return false;
}

function detector({ bins, homeDirs = [], homeFiles = [], envDirs = [], envFiles = [] }) {
  return (ctx = {}) => {
    const env = envOf(ctx);
    const home = homeOf(ctx);
    for (const b of bins) if (onPath(b, env)) return { installed: true, how: `${b} on PATH` };
    for (const v of envDirs) {
      const d = envGet(env, v);
      if (d && existsSync(d)) return { installed: true, how: `${v} exists` };
    }
    for (const [v, f] of envFiles) {
      const d = envGet(env, v);
      if (d && existsSync(join(d, f))) return { installed: true, how: `${v}/${f} exists` };
    }
    for (const d of homeDirs) if (existsSync(join(home, d))) return { installed: true, how: `~/${d} exists` };
    for (const f of homeFiles) if (existsSync(join(home, f))) return { installed: true, how: `~/${f} exists` };
    return { installed: false, how: "not found" };
  };
}

// ---- cleanup helpers: never follow symlinks, match on the run dir basename only
function runName(runDir) {
  const n = basename(String(runDir ?? "").replace(/[\\/]+$/, ""));
  return n.startsWith(AGENT_RUN_MARKER) && n.length > AGENT_RUN_MARKER.length ? n : null;
}

// the whole run name as one token: not glued to more name characters
function hasToken(text, name) {
  let i = text.indexOf(name);
  while (i >= 0) {
    const before = text[i - 1];
    const after = text[i + name.length];
    if (!(before && /[A-Za-z0-9]/.test(before)) && !(after && /[A-Za-z0-9]/.test(after))) return true;
    i = text.indexOf(name, i + 1);
  }
  return false;
}

function removeOmp(runDir, ctx) {
  const name = runName(runDir);
  if (!name) return [];
  const root = join(homeOf(ctx), ".omp", "agent", "sessions");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const e of entries) {
    if (!hasToken(e.name, name)) continue;
    const p = join(root, e.name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) rmSync(p, { force: true }); // the link only, never its target
      else if (st.isDirectory()) rmSync(p, { recursive: true, force: true });
      else continue;
      removed.push(p);
    } catch {}
  }
  return removed;
}

const FIRST_LINE_CAP = 1024 * 1024;

// First line of a file, read in chunks up to 1 MiB. `complete` is false when
// no newline showed up within the cap.
function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const chunk = Buffer.alloc(65536);
    const parts = [];
    let pos = 0;
    while (pos < FIRST_LINE_CAP) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      const i = chunk.subarray(0, n).indexOf(10);
      if (i >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, i)));
        return { text: Buffer.concat(parts).toString("utf8"), complete: true };
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      pos += n;
    }
    return { text: Buffer.concat(parts).toString("utf8"), complete: pos < FIRST_LINE_CAP };
  } catch {
    return { text: "", complete: false };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function recordedCwd({ text, complete }) {
  if (complete) {
    try {
      const j = JSON.parse(text);
      const c = j?.payload?.cwd ?? j?.cwd;
      if (typeof c === "string") return c;
    } catch {}
  }
  const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

function* walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p); // Dirent is lstat-based: symlinked dirs are not entered
    else if (e.isFile()) yield p;
  }
}

function removeCodex(runDir, ctx) {
  const name = runName(runDir);
  if (!name) return [];
  const env = envOf(ctx);
  const codexHome = envGet(env, "CODEX_HOME") ?? join(homeOf(ctx), ".codex");
  const removed = [];
  for (const f of walkFiles(join(codexHome, "sessions"))) {
    if (!/^rollout-.*\.jsonl$/.test(basename(f))) continue;
    const cwd = recordedCwd(firstLine(f));
    if (typeof cwd !== "string" || !hasToken(cwd, name)) continue;
    try {
      rmSync(f, { force: true });
      removed.push(f);
    } catch {}
  }
  return removed;
}

const nothing = () => [];

function acpEntry({ id, label, bins, homeDirs, command, args, source = null, loginHint, installHint }) {
  return {
    id,
    label,
    kind: "acp",
    tested: false,
    source,
    detect: detector({ bins, homeDirs }),
    spec: ({ system } = {}) => ({ command, args, systemPromptVia: "inline", system }),
    loginHint,
    installHint,
    cleanup: nothing,
  };
}

export const AGENTS = [
  {
    id: "omp",
    label: "omp",
    kind: "acp",
    tested: true,
    source: "omp",
    detect: detector({ bins: ["omp"] }),
    spec: ({ system } = {}) => ({
      command: "omp",
      args: ["--no-tools", "--no-rules", "--no-skills", "--no-extensions", "acp"],
      env: ["PI_CODING_AGENT_DIR"],
      systemPromptVia: "inline",
      system,
    }),
    loginHint: "omp login",
    installHint: "install omp from https://github.com/can1357/oh-my-pi",
    cleanup: removeOmp,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "acp",
    tested: true,
    source: "claude-code",
    detect: detector({ bins: ["claude"], homeDirs: [".claude"], envDirs: ["CLAUDE_CONFIG_DIR"] }),
    spec: ({ system } = {}) => ({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.108.1"],
      env: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_EXECUTABLE"],
      sessionMeta: { claudeCode: { options: { tools: [], settingSources: [], persistSession: false } } },
      systemPromptVia: "meta",
      system,
    }),
    loginHint: "run `claude`, then /login",
    installHint: "install Claude Code from https://claude.com/claude-code",
    cleanup: nothing,
  },
  {
    id: "codex",
    label: "Codex",
    kind: "acp",
    tested: true,
    source: "codex",
    detect: detector({ bins: ["codex"], homeFiles: [".codex/auth.json"], envFiles: [["CODEX_HOME", "auth.json"]] }),
    spec: ({ system } = {}) => ({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@2.7.0"],
      env: ["CODEX_HOME", "CODEX_PATH"],
      mode: "read-only",
      systemPromptVia: "param",
      system,
      sessionParams: (text) => ({
        systemPrompt: { mode: "append", content: [{ type: "text", text: `${text ?? ""}\n\n${NO_TOOLS_INSTRUCTION}`.trim() }] },
      }),
    }),
    loginHint: "codex login",
    installHint: "install Codex from https://github.com/openai/codex",
    cleanup: removeCodex,
  },
  acpEntry({ id: "opencode", label: "opencode", bins: ["opencode"], command: "opencode", args: ["acp"], source: "opencode", loginHint: "opencode auth login", installHint: "install opencode from https://opencode.ai" }),
  acpEntry({ id: "gemini", label: "Gemini CLI", bins: ["gemini"], command: "gemini", args: ["--acp"], loginHint: "run `gemini` to sign in", installHint: "install the Gemini CLI from https://github.com/google-gemini/gemini-cli" }),
  acpEntry({ id: "cursor", label: "Cursor", bins: ["cursor-agent"], command: "agent", args: ["acp"], source: "cursor", loginHint: "agent login", installHint: "install the Cursor CLI from https://cursor.com/cli" }),
  acpEntry({ id: "copilot", label: "GitHub Copilot", bins: ["copilot"], command: "copilot", args: ["--acp"], loginHint: "run `copilot`, then /login", installHint: "install the Copilot CLI from https://github.com/github/copilot-cli" }),
  acpEntry({ id: "kimi", label: "Kimi", bins: ["kimi"], command: "kimi", args: ["acp"], source: "kimi", loginHint: "kimi login", installHint: "install Kimi CLI from https://github.com/MoonshotAI/kimi-cli" }),
  acpEntry({ id: "qwen", label: "Qwen Code", bins: ["qwen"], command: "qwen", args: ["--acp"], loginHint: "run `qwen` to sign in", installHint: "install Qwen Code from https://github.com/QwenLM/qwen-code" }),
  {
    id: "anthropic-api",
    label: "Anthropic API",
    kind: "api",
    tested: false,
    source: null,
    models: [MODEL],
    detect: (ctx = {}) => (envGet(envOf(ctx), "ANTHROPIC_API_KEY") ? { installed: true, how: "ANTHROPIC_API_KEY is set" } : { installed: false, how: "ANTHROPIC_API_KEY is not set" }),
    spec: () => null,
    loginHint: "set ANTHROPIC_API_KEY",
    installHint: "set ANTHROPIC_API_KEY",
    cleanup: nothing,
  },
];

// Test-only: REBASE_VERIFY_TEST_AGENT=<path to an ACP agent script> adds an
// entry `test-agent` that runs it with node, handing it the FAKE_* variables.
// It is how the end-to-end tests drive `generate --agent` without a real agent.
if (process.env.REBASE_VERIFY_TEST_AGENT) {
  AGENTS.push({
    id: "test-agent",
    label: "Test agent",
    kind: "acp",
    tested: false,
    source: null,
    detect: () => ({ installed: true, how: "REBASE_VERIFY_TEST_AGENT is set" }),
    spec: ({ system } = {}) => ({
      command: process.execPath,
      args: [process.env.REBASE_VERIFY_TEST_AGENT],
      env: Object.keys(process.env).filter((k) => k.startsWith("FAKE_")),
      systemPromptVia: "inline",
      system,
    }),
    loginHint: "log in to the test agent",
    installHint: "the test agent needs no install",
    cleanup: nothing,
  });
}

// Cursor ships its binary as `agent`: only trust that name when ~/.cursor exists.
const cursor = AGENTS.find((a) => a.id === "cursor");
const cursorBase = cursor.detect;
cursor.detect = (ctx = {}) => {
  const r = cursorBase(ctx);
  if (r.installed) return r;
  if (existsSync(join(homeOf(ctx), ".cursor")) && onPath("agent", envOf(ctx))) return { installed: true, how: "agent on PATH and ~/.cursor exists" };
  return r;
};

/** Installed entries with their session counts, in the order the wizard shows them. */
export function availableAgents({ sessionsBySource = {}, env = process.env, home } = {}) {
  const ctx = { env, home };
  const rows = [];
  for (const a of AGENTS) {
    if (!a.detect(ctx).installed) continue;
    rows.push({ ...a, sessions: a.source ? (sessionsBySource[a.source] ?? 0) : 0 });
  }
  const rank = (a) => (a.id === "anthropic-api" ? 2 : a.tested ? 0 : 1);
  return rows
    .map((r, i) => [r, i])
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || b.sessions - a.sessions || i - j)
    .map(([r]) => r);
}

export const defaultAgent = (list) => list[0] ?? null;
