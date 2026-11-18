// A scripted ACP agent (SDK agent side) for tests. Behaviour comes from env:
//   FAKE_ANSWER   text streamed back in three chunks (default "ok")
//   FAKE_ECHO     answer with JSON of what the agent saw (cwd, env names, session/new params, model, mode, prompt text)
//   FAKE_MODELS   comma list: offer a `category: "model"` config option (first is current)
//   FAKE_MODES    comma list: offer a `category: "mode"` config option
//   FAKE_TOOL     emit a tool_call during the prompt, then wait for cancel
//   FAKE_PERM     ask permission once and put the chosen outcome into the answer
//   FAKE_AUTH     "new" | "prompt" | "details": fail with an auth error there
//   FAKE_HANG     wait for session/cancel, then stop with "cancelled"
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const env = process.env;
const list = (v) => (v ? v.split(",") : []);
const state = { model: null, mode: null, params: null, cancel: null };
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

const waitCancel = (signalBox) => new Promise((resolve) => (signalBox.resolve = resolve));

const app = acp.agent({ name: "fake-acp-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
    agentInfo: { name: "fake", version: "0" },
    _meta: { account: "secret@example.com" },
  }))
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async ({ params }) => {
    state.params = params;
    if (env.FAKE_AUTH === "new") throw new acp.RequestError(-32000, "Authentication required");
    return { sessionId: "s1", configOptions: configOptions() };
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
    const update = (u) => client.notify("session/update", { sessionId: "s1", update: u });
    const promptText = params.prompt.map((b) => b.text ?? "").join("");
    if (env.FAKE_TOOL || env.FAKE_HANG) {
      state.cancel = {};
      const cancelled = waitCancel(state.cancel);
      if (env.FAKE_TOOL)
        await update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run ls", kind: "execute", status: "pending" });
      else await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
      await cancelled;
      return { stopReason: "cancelled" };
    }
    let answer = env.FAKE_ANSWER ?? "ok";
    if (env.FAKE_PERM) {
      const r = await client.request("session/request_permission", {
        sessionId: "s1",
        toolCall: { toolCallId: "p1", title: "x" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      answer = JSON.stringify({ perm: r.outcome });
    }
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
    return { stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
