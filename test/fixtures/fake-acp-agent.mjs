// A scripted ACP agent (SDK agent side) for tests. Behaviour comes from env:
//   FAKE_ANSWER   text streamed back in three chunks (default "ok")
//   FAKE_ECHO     answer with JSON of what the agent saw (cwd, env names, session/new params, model, mode, prompt text)
//   FAKE_MODELS   comma list: offer a `category: "model"` config option (first is current)
//   FAKE_MODES    comma list: offer a `category: "mode"` config option
//   FAKE_TOOL     emit a tool_call during the prompt, then wait for cancel
//   FAKE_PERM     ask permission once and put the chosen outcome into the answer
//   FAKE_AUTH     "new" | "prompt" | "details": fail with an auth error there
//   FAKE_TOOL=update  emit a tool_call_update for an unseen id instead; =nocancel ignores cancel forever
//   FAKE_LATE_TOOL  after the turn ends, emit a tool_call
//   FAKE_EXIT     "init" | "prompt": print to stderr and exit during that call
//   FAKE_GRANDCHILD  path: spawn a sleeper grandchild and write its pid there
//   FAKE_HANG     wait for session/cancel, then stop with "cancelled"
//   FAKE_SMART    answer like a profile writer: a narrative for a narrative prompt, every practice true for a
//                 practices prompt (the last line of the prompt is the JSON input)
//   FAKE_PRACTICES_BAD  "once" | "always": answer the first (or every) practices prompt with text that holds no JSON
//   FAKE_NARRATIVE_BAD  "once" | "always": answer the first (or every) narrative prompt with text that holds no JSON
//   FAKE_CHATTER  with FAKE_SMART: put prose with stray braces before and after the JSON
//   FAKE_PROMPT_LOG  path: append one JSON line per prompt text
//   FAKE_TURN_LOG    path: append one JSON line {sessionId, model, mode} per prompt
//   FAKE_CLOSE    "1" | "error": advertise sessionCapabilities.close and answer session/close (or fail it)
//   FAKE_STRAY    "text" | "tool": before each answer, send a text chunk (or a tool_call) for a session id that is not the prompt's
//   FAKE_OLD_TOOL on every session/new after the first, an earlier session emits a tool_call before the answer
// Every session/new opens a fresh session (its own id, default model and mode).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const env = process.env;
if (env.FAKE_GRANDCHILD) {
  const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(env.FAKE_GRANDCHILD, String(g.pid));
}
const list = (v) => (v ? v.split(",") : []);
const state = { model: null, mode: null, params: null, cancel: null, sessions: 0 };
const models = list(env.FAKE_MODELS);
const modes = list(env.FAKE_MODES);
state.model = models[0] ?? null;
state.mode = modes[0] ?? null;

function configOptions() {
  const out = [];
  if (modes.length)
    out.push({ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: modes.map((m) => ({ value: m, name: m })) });
  if (models.length)
    out.push({ id: "model", name: "Model", category: "model", type: "select", currentValue: state.model, options: models.map((m) => ({ value: m, name: `Name ${m}` })) });
  return out;
}

let practicesCalls = 0;
let narrativeCalls = 0;
function smartAnswer(promptText) {
  let input = null;
  try {
    input = JSON.parse(promptText.trim().split("\n").pop());
  } catch {}
  let body;
  if (Array.isArray(input?.sessions)) {
    practicesCalls++;
    if (env.FAKE_PRACTICES_BAD === "always" || (env.FAKE_PRACTICES_BAD === "once" && practicesCalls === 1)) return "I would rather not answer that.";
    body = JSON.stringify(Object.fromEntries(input.sessions.map((s) => [s.id, Object.fromEntries((input.practices ?? []).map((p) => [p, true]))])));
  } else {
    narrativeCalls++;
    if (env.FAKE_NARRATIVE_BAD === "always" || (env.FAKE_NARRATIVE_BAD === "once" && narrativeCalls === 1)) return "I would rather not answer that.";
    body = JSON.stringify({
      summary: "Builds a web product with an AI agent.",
      cognitive: { narrative: "Splits work into small checked steps." },
      projects: (input?.projects ?? []).map((p) => ({ id: p.id, domain: "web product", did: "Built and shipped features." })),
    });
  }
  return env.FAKE_CHATTER ? `Sure {thing}, here it is:\n\n${body}\n\nHope that helps {really}.` : body;
}

const waitCancel = (signalBox) => new Promise((resolve) => (signalBox.resolve = resolve));

const INIT = {
  protocolVersion: 1,
  agentCapabilities: env.FAKE_CLOSE ? { sessionCapabilities: { close: {} } } : {},
  authMethods: [],
  agentInfo: { name: "fake", version: "0" },
  _meta: { account: "secret@example.com" },
};
const app = acp.agent({ name: "fake-acp-agent" })
  .onRequest("initialize", async () => {
    if (env.FAKE_EXIT === "init") {
      process.stderr.write("boom: fake agent died\n");
      process.exit(3);
    }
    return INIT;
  })
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async ({ params, client }) => {
    state.params = params;
    if (env.FAKE_OLD_TOOL && state.sessions >= 1)
      await client.notify("session/update", { sessionId: `s${state.sessions}`, update: { sessionUpdate: "tool_call", toolCallId: `old-${state.sessions}`, title: "Old tool", kind: "execute", status: "pending" } });
    if (env.FAKE_AUTH === "new") throw new acp.RequestError(-32000, "Authentication required");
    state.model = models[0] ?? null;
    state.mode = modes[0] ?? null;
    return { sessionId: `s${++state.sessions}`, configOptions: configOptions() };
  })
  .onRequest("session/close", async () => {
    if (env.FAKE_CLOSE === "error") throw new acp.RequestError(-32603, "close failed");
    return {};
  })
  .onRequest("session/set_config_option", async ({ params }) => {
    if (params.configId === "model") state.model = params.value;
    if (params.configId === "mode") state.mode = params.value;
    return { configOptions: configOptions() };
  })
  .onRequest("session/set_mode", async ({ params }) => {
    state.mode = params.modeId;
    return {};
  })
  .onNotification("session/cancel", async () => state.cancel?.resolve?.())
  .onRequest("session/prompt", async ({ params, client }) => {
    if (env.FAKE_AUTH === "prompt") throw new acp.RequestError(-32000, "Authentication required");
    if (env.FAKE_AUTH === "details")
      throw new acp.RequestError(-32603, "Internal error", { details: "No model selected. Use /login" });
    const update = (u) => client.notify("session/update", { sessionId: params.sessionId, update: u });
    const promptText = params.prompt.map((b) => b.text ?? "").join("");
    if (env.FAKE_TURN_LOG) appendFileSync(env.FAKE_TURN_LOG, JSON.stringify({ sessionId: params.sessionId, model: state.model, mode: state.mode }) + "\n");
    if (env.FAKE_STRAY === "tool")
      await client.notify("session/update", { sessionId: "stray", update: { sessionUpdate: "tool_call", toolCallId: "stray-t", title: "Stray tool", kind: "execute", status: "pending" } });
    if (env.FAKE_STRAY === "text")
      await client.notify("session/update", { sessionId: "stray", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STRAY" } } });
    if (env.FAKE_PROMPT_LOG) appendFileSync(env.FAKE_PROMPT_LOG, JSON.stringify(promptText) + "\n");
    if (env.FAKE_EXIT === "prompt") {
      process.stderr.write("boom: died mid-turn\n");
      process.exit(4);
    }
    if (env.FAKE_TOOL || env.FAKE_HANG) {
      state.cancel = {};
      const cancelled = waitCancel(state.cancel);
      if (env.FAKE_TOOL === "update")
        await update({ sessionUpdate: "tool_call_update", toolCallId: "ghost", title: "Ghost", status: "in_progress" });
      else if (env.FAKE_TOOL)
        await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls", kind: "execute", status: "pending" });
      else await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
      if (env.FAKE_TOOL === "nocancel") await new Promise(() => {});
      await cancelled;
      return { stopReason: "cancelled" };
    }
    let answer = env.FAKE_ANSWER ?? "ok";
    if (env.FAKE_PERM) {
      const r = await client.request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "p1", title: "x" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      answer = JSON.stringify({ perm: r.outcome });
    }
    if (env.FAKE_SMART) answer = smartAnswer(promptText);
    if (env.FAKE_ECHO)
      answer = JSON.stringify({
        cwd: process.cwd(),
        envNames: Object.keys(env),
        params: state.params,
        model: state.model,
        mode: state.mode,
        promptText,
      });
    const n = Math.max(1, Math.ceil(answer.length / 3));
    for (let i = 0; i < answer.length; i += n)
      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer.slice(i, i + n) } });
    if (env.FAKE_LATE_TOOL)
      setTimeout(() => update({ sessionUpdate: "tool_call", toolCallId: "late", title: "Late tool", kind: "execute", status: "pending" }), 20);
    return { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
