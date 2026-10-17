import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { connectedCacheFile, connectedTarget, CONNECTED_MODELS, type ConnectedModel } from "../src/hosted/connected.ts";

test("the connected transport caches replies by request, prices them, marks cached ones free, and stops at the budget", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ output: { message: { content: [{ text: "NONE" }] } }, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model/x/converse`;
  const model: ConnectedModel = { ...CONNECTED_MODELS[0]!, id: `test/connected-${process.pid}` };
  rmSync(connectedCacheFile(model), { force: true });
  let spent = 0;
  try {
    const target = connectedTarget(model, { budgetUsd: 1, spentUsd: () => spent });
    const send = async (body: string) => {
      const response = await target.fetch(url, { method: "POST", body });
      return target.usage(await response.clone().json(), response)!;
    };
    const first = await send("a");
    assert.ok(Math.abs(first.usd - (model.usdPerMInput + model.usdPerMOutput)) < 1e-9);
    assert.equal(first.cached, undefined);
    const again = await send("a");
    assert.deepEqual([again.usd, again.cached, hits], [0, true, 1]);
    spent = 1;
    await assert.rejects(send("b"), /budget/);
    assert.equal(hits, 1, "nothing sent past the budget");
    assert.equal((await send("a")).cached, true, "cached replies are still served");
  } finally {
    server.close();
    rmSync(connectedCacheFile(model), { force: true });
  }
});
