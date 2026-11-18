// Drive the person's own coding agent over ACP (JSON-RPC over stdio) for one
// text-in, text-out job. The agent runs in a fresh empty dir, with a minimal
// environment, no client capabilities (no fs, no terminal), and a tripwire:
// any tool call cancels the turn and fails it.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AGENT_RUN_MARKER } from "../agent-run.mjs";

export class ToolUseError extends Error {
  constructor(tool) {
    super(`the agent tried to use a tool (${tool}); tools are off for this run`);
    this.name = "ToolUseError";
  }
}
export class AgentAuthError extends Error {
  constructor(detail) {
    super(`the agent is not logged in${detail ? `: ${detail}` : ""}`);
    this.name = "AgentAuthError";
  }
}
export class AgentStartError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentStartError";
  }
}
export class ModelNotOfferedError extends Error {
  constructor(id) {
    super(`the agent does not offer model "${id}"`);
    this.name = "ModelNotOfferedError";
  }
}

const BASE_ENV = new Set(
  [
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    // .cmd shims (npx) need these on Windows
    ...(process.platform === "win32" ? ["COMSPEC", "PATHEXT"] : []),
  ].map((n) => n.toUpperCase()),
);
const isBaseName = (n) => {
  const u = n.toUpperCase();
  return BASE_ENV.has(u) || u.startsWith("LC_") || u.startsWith("XDG_");
};

export function childEnv(extraNames = [], source = process.env) {
  const extra = new Set(extraNames.map((n) => n.toUpperCase()));
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (isBaseName(k) || extra.has(k.toUpperCase()))) env[k] = v;
  }
  return env;
}

// Windows: npx is a .cmd, so it goes through the shell as ONE command string
// (passing args with shell:true is deprecated, DEP0190).
export function windowsCommandLine(command, args = []) {
  const q = (a) => (/[\s"&|<>^()%]/.test(a) || a === "" ? `"${a.replace(/"/g, '""')}"` : a);
  return [command, ...args].map(q).join(" ");
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const isAuthError = (e) =>
  e?.code === -32000 || (e?.code === -32603 && /no model selected/i.test(JSON.stringify(e.data ?? "") + (e.message ?? "")));

function flattenOptions(opts = []) {
  return opts.flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
}
const configEntry = (configOptions, category) => (configOptions ?? []).find((o) => o?.category === category);

/**
 * Start an agent and open one session.
 *
 * spec: { command, args, env?, sessionMeta?, sessionParams?, mode?, system?,
 *         systemPromptVia: "meta" | "param" | "inline", tripGraceMs? }
 * With via "meta" or "param" the system prompt is fixed at session/new from
 * `spec.system`; prompt(text, { system }) then rejects a different system
 * (throws) instead of silently dropping it. With "inline" it is prepended to
 * the text of each prompt.
 */
export async function startAgent(spec, { onEvent = () => {}, logFile, signal } = {}) {
  if (signal?.aborted) throw abortError();
  let cwd;
  let child;
  let conn;
  let closed = false;
  let closeDone;
  let exited = false;
  let exitInfo = null;
  let stderrTail = "";
  let exitPromise = Promise.resolve();
  const log = (dir, extra) => {
    if (logFile) appendFileSync(logFile, JSON.stringify({ t: Date.now(), dir, ...extra }) + "\n");
  };
  const emit = (e) => {
    try {
      onEvent(e);
    } catch {
      // a broken observer never breaks the run
    }
  };
  const startErr = () =>
    new AgentStartError(
      `the agent "${spec.command}" exited (${exitInfo?.signal ?? exitInfo?.code ?? "unknown"})${stderrTail.trim() ? `: ${stderrTail.trim().split("\n").pop()}` : ""}`,
    );

  function close() {
    if (closed) return closeDone;
    closed = true;
    closeDone = (async () => {
      try {
        conn?.close();
      } catch {}
      if (child && !exited && child.pid) {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else {
          // detached: the child leads its own group; npx, the adapter and the CLI it spawns all die
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 10000).unref())]);
      if (cwd) await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })();
    return closeDone;
  }

  let turn = null; // { text, tripped, timer, expire }
  let pendingTrip = null; // a tool event seen outside a turn
  let sessionId = null;
  const seenTools = new Set();
  const notifyCancel = () => conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
  const onAbort = () => {
    if (sessionId && !closed) notifyCancel();
    close();
  };

  try {
    cwd = mkdtempSync(join(tmpdir(), AGENT_RUN_MARKER));
    if (logFile) mkdirSync(dirname(logFile), { recursive: true });
    const viaShell = process.platform === "win32" && spec.command === "npx";
    const spawnOpts = {
      cwd,
      env: childEnv(spec.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    };
    child = viaShell
      ? spawn(windowsCommandLine(spec.command, spec.args ?? []), { ...spawnOpts, shell: true })
      : spawn(spec.command, spec.args ?? [], spawnOpts);
    child.stderr.on("data", (d) => (stderrTail = (stderrTail + d).slice(-2000)));
    child.stdin.on("error", () => {});
    exitPromise = new Promise((resolve) => {
      child.once("exit", (code, sig) => ((exited = true), (exitInfo = { code, signal: sig }), resolve()));
      child.once("error", () => ((exited = true), resolve()));
    });
    const dead = new Promise((_, reject) => {
      child.once("error", (e) =>
        reject(new AgentStartError(e.code === "ENOENT" ? `cannot start "${spec.command}": not found` : `cannot start "${spec.command}": ${e.message}`)),
      );
      child.once("exit", () => {
        if (!closed) reject(startErr());
      });
    });
    dead.catch(() => {});

    // Wire log: every message both ways; initialize/authenticate responses can
    // carry account data, so only their method is kept.
    const redactIds = new Map();
    const base = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const writer = base.writable.getWriter();
    const stream = {
      readable: base.readable.pipeThrough(
        new TransformStream({
          transform(msg, ctrl) {
            if (msg && msg.id !== undefined && !msg.method && redactIds.has(msg.id)) log("in", { method: redactIds.get(msg.id), redacted: true });
            else log("in", { msg });
            ctrl.enqueue(msg);
          },
        }),
      ),
      writable: new WritableStream({
        write(msg) {
          if (msg && msg.id !== undefined && (msg.method === "initialize" || msg.method === "authenticate")) redactIds.set(msg.id, msg.method);
          log("out", { msg });
          return writer.write(msg);
        },
        close: () => writer.close().catch(() => {}),
        abort: (r) => writer.abort(r).catch(() => {}),
      }),
    };

    const trip = (tool) => {
      emit({ kind: "tool-tripped", tool });
      if (!turn) return void (pendingTrip ??= tool);
      if (turn.tripped) return;
      turn.tripped = tool;
      notifyCancel();
      turn.timer = setTimeout(() => turn?.expire(), spec.tripGraceMs ?? 5000);
      turn.timer.unref?.();
    };

    const app = acp
      .client({ name: "rebase-verify" })
      .onRequest("session/request_permission", async ({ params }) => {
        const reject = params.options?.find((o) => /^reject/.test(o.kind ?? ""));
        emit({ kind: "permission-refused", toolCall: params.toolCall });
        return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : { outcome: { outcome: "cancelled" } };
      })
      .onNotification("session/update", ({ params }) => {
        const u = params.update;
        emit({ ...u, kind: u.sessionUpdate });
        if (turn && u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") turn.text += u.content.text;
        // a tool_call, or an update for a tool call we never saw, is a tool in use
        if (u.sessionUpdate === "tool_call") {
          seenTools.add(u.toolCallId);
          trip(u.title || u.kind || "tool");
        } else if (u.sessionUpdate === "tool_call_update" && !seenTools.has(u.toolCallId)) {
          seenTools.add(u.toolCallId);
          trip(u.title || u.kind || "tool");
        }
      });
    conn = app.connect(stream);
    const call = async (method, params) => {
      try {
        return await Promise.race([conn.agent.request(method, params), dead]);
      } catch (e) {
        if (closed || e instanceof AgentStartError || typeof e?.code === "number") throw e;
        // the connection dropped: if the child died, say so with its stderr
        if (!exited) await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000).unref())]);
        if (exited) throw startErr();
        throw e;
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    emit({ kind: "started", pid: child.pid, cwd });
    await call("initialize", { protocolVersion: 1, clientInfo: { name: "rebase-verify", version: "0" }, clientCapabilities: {} });
    const meta = { ...(spec.sessionMeta ?? {}) };
    const params = { cwd, mcpServers: [], ...(spec.sessionParams ?? {}) };
    if (spec.system && spec.systemPromptVia === "meta") meta.systemPrompt = spec.system;
    if (spec.system && spec.systemPromptVia === "param")
      params.systemPrompt = { mode: "append", content: [{ type: "text", text: spec.system }] };
    if (Object.keys(meta).length) params._meta = meta;
    let modelEntry = null;
    let chosenModel = null;
    // session/new on the open connection (same cwd, meta and params), then the mode and the
    // chosen model again: a new session starts from the agent's defaults.
    const open = async () => {
      let created;
      try {
        created = await call("session/new", params);
      } catch (e) {
        throw isAuthError(e) ? new AgentAuthError(e.message) : e;
      }
      sessionId = created.sessionId;
      const configOptions = created.configOptions;
      modelEntry = configEntry(configOptions, "model");
      session.models = flattenOptions(modelEntry?.options).map((o) => ({ id: o.value, name: o.name ?? o.value }));
      session.currentModel = modelEntry?.currentValue ?? null;
      if (spec.mode) {
        const modeEntry = configEntry(configOptions, "mode");
        if (modeEntry && flattenOptions(modeEntry.options).some((o) => o.value === spec.mode))
          await call("session/set_config_option", { sessionId, configId: modeEntry.id, value: spec.mode });
        else await call("session/set_mode", { sessionId, modeId: spec.mode });
      }
      if (chosenModel) await session.setModel(chosenModel);
    };
    const session = {
      models: [],
      currentModel: null,
      async setModel(id) {
        if (!modelEntry || !session.models.some((m) => m.id === id)) throw new ModelNotOfferedError(id);
        await call("session/set_config_option", { sessionId, configId: modelEntry.id, value: id });
        chosenModel = id;
        session.currentModel = id;
        emit({ kind: "model-set", model: id });
      },
      // A new session on the same process: the next turn sees nothing of the earlier ones.
      async renew() {
        pendingTrip = null;
        seenTools.clear();
        await open();
        emit({ kind: "session-renewed", sessionId });
      },
      async prompt(text, { system } = {}) {
        if (pendingTrip) throw new ToolUseError(pendingTrip);
        const fixed = spec.systemPromptVia === "meta" || spec.systemPromptVia === "param";
        if (fixed && system !== undefined && system !== spec.system)
          throw new Error("the system prompt is fixed when the agent starts; pass it in the spec, not to prompt()");
        const body = !fixed && system ? `${system}\n\n${text}` : text;
        const t = { text: "", tripped: null, timer: null, expire: null };
        const deadline = new Promise((_, rej) => (t.expire = () => rej(new Error("trip-deadline"))));
        deadline.catch(() => {});
        turn = t;
        emit({ kind: "turn-start" });
        try {
          const res = await Promise.race([call("session/prompt", { sessionId, prompt: [{ type: "text", text: body }] }), deadline]);
          emit({ kind: "turn-end", stopReason: res.stopReason });
          if (t.tripped) throw new ToolUseError(t.tripped);
          return { text: t.text, usage: res.usage ?? null, stopReason: res.stopReason };
        } catch (e) {
          if (e instanceof ToolUseError) throw e;
          if (t.tripped) {
            await close();
            throw new ToolUseError(t.tripped);
          }
          if (signal?.aborted) {
            await closeDone;
            throw abortError();
          }
          throw isAuthError(e) ? new AgentAuthError(e.message) : e;
        } finally {
          clearTimeout(t.timer);
          turn = null;
        }
      },
      cancel: () => notifyCancel(),
      close,
    };

    await open();
    return session;
  } catch (e) {
    await close();
    if (signal?.aborted) throw abortError();
    throw e;
  }
}
