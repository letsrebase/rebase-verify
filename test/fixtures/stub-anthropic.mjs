// Preloaded with --import in tests: answers api.anthropic.com/v1/messages locally
// (a narrative for the narrative prompt, every practice true for a practices prompt).
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`unexpected request to ${url}`);
  const user = JSON.parse(JSON.parse(init.body).messages[0].content);
  const text = Array.isArray(user.sessions)
    ? JSON.stringify(Object.fromEntries(user.sessions.map((s) => [s.id, Object.fromEntries(user.practices.map((p) => [p, true]))])))
    : JSON.stringify({
        summary: "Builds a web product with an AI agent.",
        cognitive: { narrative: "Splits work into small checked steps." },
        projects: (user.projects ?? []).map((p) => ({ id: p.id, domain: "web product", did: "Built and shipped features." })),
      });
  return { ok: true, json: async () => ({ content: [{ type: "text", text }] }) };
};
