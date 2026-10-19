// Stand-in for dashboard/playground/host.ts: same IPC protocol, no model.
const reply = (id, body) => process.send({ id, ...body });
process.on("message", (msg) => {
  const delay = msg.type === "chat" ? Number(msg.settings?.delayMs ?? 0) : 0;
  setTimeout(() => {
    if (msg.type === "load" && msg.model === "broken")
      return reply(msg.id, { ok: false, error: "cannot load" });
    if (msg.type === "load")
      return reply(msg.id, {
        ok: true,
        result: { model: msg.model, loadMs: 5, contextLength: 8192 },
      });
    if (msg.type === "chat")
      return reply(msg.id, {
        ok: true,
        result: { output: "hi", pid: process.pid },
      });
    reply(msg.id, { ok: false, error: `unknown request ${msg.type}` });
  }, delay);
});
process.on("disconnect", () => process.exit(0));
