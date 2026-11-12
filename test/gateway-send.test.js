import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

import { GATEWAY_MAX_RESPONSE_BYTES, GATEWAY_METHOD_MAX_RESPONSE_BYTES, getTranscriptTail, gatewayEvents, getTranscriptTailById, getUsage, listAgentsDetailed, markAgentRead, respondToWidget, listAllAutomations, listSkills, sendPrompt } from "../src/core/gateway.js";

const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "t" };
const roster = { agents: [{ id: "bot-1", name: "General" }] };

function mockGateway(t, send) {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    return send();
  });
}

test("test mode: a loopback gateway is served, a live gateway host is refused before any request", async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push({ url: req.url, body: JSON.parse(text) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/api/listAgents" ? roster : { messageId: "m-loop" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = { gatewayUrl: "http://127.0.0.1:" + server.address().port, gatewayToken: "t" };

  const out = await sendPrompt(local, "General", "hi");
  assert.deepEqual(out, {
    target: { id: "bot-1", name: "General", title: "", description: "", avatarShape: "", avatarColor: "", isGroup: false, memberIds: [] },
    result: { messageId: "m-loop" },
    delivery: "accepted",
    messageId: "m-loop",
  });
  assert.deepEqual(received.map((r) => r.url), ["/api/listAgents", "/api/sendPrompt"]);
  assert.equal(received[1].body.prompt, "hi");
  // Server-run bots refuse (409) a client that doesn't say it renders cards and forms.
  assert.equal(received[1].body.rendersMcpElicitationForms, true);
  assert.ok(Array.isArray(received[1].body.renderedCardKinds) && received[1].body.renderedCardKinds.length > 0);

  // A non-routable host, and the production escape hatch switched on: production
  // policy would let this through, test mode must still refuse it.
  process.env.GROK_BOT_ALLOW_ANY_GATEWAY = "1";
  t.after(() => { delete process.env.GROK_BOT_ALLOW_ANY_GATEWAY; });
  await assert.rejects(
    sendPrompt({ gatewayUrl: "https://gateway.invalid", gatewayToken: "t" }, "General", "hi"),
    { message: 'Rejected gateway URL host "gateway.invalid": test mode (GROK_BOT_TEST / NODE_ENV=test) only allows http(s) loopback gateways.' },
  );
  assert.equal(received.length, 2, "the refused send reached no server");
});

test("sendPrompt accepts only a confirmed messageId receipt", async (t) => {
  mockGateway(t, () => new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "accepted");
  assert.equal(out.messageId, "m-1");
});

test("sendPrompt without a receipt is unknown, not accepted", async (t) => {
  mockGateway(t, () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "unknown");
  assert.equal(out.messageId, undefined);
});

function mockAckGateway(t, transcript) {
  let nonce;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    if (u.endsWith("/api/sendPrompt")) {
      nonce = JSON.parse(init.body).clientNonce;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    if (u.endsWith("/api/getAgentTranscriptTail")) return transcript(nonce);
    return new Response("{}", { status: 404 });
  });
}

test("sendPrompt confirms an { accepted: true } ack by finding its clientNonce in the transcript", async (t) => {
  mockAckGateway(t, (nonce) => new Response(JSON.stringify({
    entries: [{ id: "t7u", role: "user", clientNonce: "someone-else" }, { id: "t8u", role: "user", clientNonce: nonce }],
  }), { status: 200 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "accepted");
  assert.equal(out.messageId, "t8u");
});

test("sendPrompt keeps an { accepted: true } ack unknown when its clientNonce is not in the transcript", async (t) => {
  mockAckGateway(t, () => new Response(JSON.stringify({ entries: [{ id: "t7u", role: "user", clientNonce: "someone-else" }] }), { status: 200 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "unknown");
  assert.equal(out.messageId, undefined);
});

test("sendPrompt keeps an { accepted: true } ack unknown when the transcript read fails", async (t) => {
  mockAckGateway(t, () => new Response("boom", { status: 500 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "unknown");
  assert.equal(out.messageId, undefined);
});

test("sendPrompt rejects on a 4xx and preserves the target id", async (t) => {
  mockGateway(t, () => new Response(JSON.stringify({ message: "nope" }), { status: 400 }));
  await assert.rejects(sendPrompt(session, "General", "hi"), (e) => {
    assert.equal(e.delivery, "rejected");
    assert.equal(e.targetId, "bot-1");
    return true;
  });
});

test("sendPrompt rejects a cancelled preflight without fetching", async (t) => {
  const controller = new AbortController();
  controller.abort();
  let received = 0;
  t.mock.method(globalThis, "fetch", async () => {
    received++;
    throw new Error("Unexpected request after cancellation");
  });
  await assert.rejects(sendPrompt(session, "General", "hi", { signal: controller.signal }), (error) => {
    assert.equal(error.delivery, "rejected");
    assert.equal(error.reason, "cancelled");
    return true;
  });
  assert.equal(received, 0);
});

test("sendPrompt preserves a resolution error before prompt transmission", async (t) => {
  const failure = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const original = Object.getOwnPropertyDescriptors(failure);
  const received = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    received.push(new URL(url).pathname);
    throw failure;
  });
  await assert.rejects(sendPrompt(session, "General", "hi"), (error) => {
    assert.equal(error, failure);
    return true;
  });
  assert.deepEqual(received, ["/api/listAgents"]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(failure), original);
});

test("sendPrompt marks transport loss unknown with a no-retry hint", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    throw new TypeError("fetch failed");
  });
  await assert.rejects(sendPrompt(session, "General", "hi"), (e) => {
    assert.equal(e.delivery, "unknown");
    assert.match(e.message, /delivery unknown; check the thread before resending/);
    return true;
  });
});

test("sendPrompt preserves an unknown timeout without mutating its DOMException", async (t) => {
  const failure = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const original = Object.getOwnPropertyDescriptors(failure);
  const received = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    received.push(new URL(url).pathname);
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    throw failure;
  });

  await assert.rejects(sendPrompt(session, "General", "hi"), (error) => {
    assert.equal(error.delivery, "unknown");
    assert.equal(error.targetId, "bot-1");
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.cause, failure);
    assert.match(error.message, /delivery unknown; check the thread before resending/);
    return true;
  });
  assert.deepEqual(received, ["/api/listAgents", "/api/sendPrompt"]);
  assert.equal(failure.message, "The operation was aborted due to timeout");
  assert.deepEqual(Object.getOwnPropertyDescriptors(failure), original);
});

test("oversized gateway responses abort mid-stream instead of buffering", async (t) => {
  mockGateway(t, () => new Response("x".repeat(GATEWAY_MAX_RESPONSE_BYTES + 8), { status: 200 }));
  await assert.rejects(sendPrompt(session, "General", "hi"), /too large/);
});

test("the skill library may exceed the general cap, up to its own", async (t) => {
  const body = "y".repeat(GATEWAY_MAX_RESPONSE_BYTES);
  const big = JSON.stringify({ workflows: [{ id: "s1", name: "Big", description: body, source: "automation" }] });
  mockGateway(t, () => new Response(big, { status: 200 }));
  const skills = await listSkills(session);
  assert.deepEqual(skills.map((s) => [s.id, s.source]), [["s1", "automation"]]);
  t.mock.restoreAll();
  mockGateway(t, () => new Response("x".repeat(GATEWAY_METHOD_MAX_RESPONSE_BYTES.getAgentWorkflows + 8), { status: 200 }));
  await assert.rejects(listSkills(session), /too large/);
});

test("listSkills asks for the named bot's automations; listAllAutomations sends no arguments", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push([String(url).split("/api/")[1], JSON.parse(options.body)]);
    return new Response(JSON.stringify(String(url).endsWith("listAllAutomations") ? [{ id: "a1" }] : { workflows: [] }), { status: 200 });
  });
  await listSkills(session, { botId: "bot-9" });
  assert.deepEqual(await listAllAutomations(session), [{ id: "a1" }]);
  assert.deepEqual(seen, [["getAgentWorkflows", { id: "bot-9" }], ["listAllAutomations", {}]]);
});

test("listAgentsDetailed keeps the gateway's own fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([{ id: "b1", name: "A", lastActivityAt: 5, unreadCount: 2 }, { name: "no id" }]), { status: 200 }));
  assert.deepEqual(await listAgentsDetailed(session), [{ id: "b1", name: "A", lastActivityAt: 5, unreadCount: 2 }]);
});

test("getTranscriptTail clamps the limit to 1-200 like the CLI and tool", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  });
  await getTranscriptTail(session, "General", 99999);
  assert.equal(seen[0].limit, 200);
  await getTranscriptTail(session, "General", -3);
  assert.equal(seen[1].limit, 1);
});

test("getTranscriptTailById reads one id without a roster lookup", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push([String(url).split("/api/")[1], JSON.parse(options.body)]);
    return new Response(JSON.stringify({ entries: [{ id: "e1" }] }), { status: 200 });
  });
  assert.deepEqual(await getTranscriptTailById(session, "bot-9", { limit: 500 }), { entries: [{ id: "e1" }] });
  assert.deepEqual(seen, [["getAgentTranscriptTail", { id: "bot-9", limit: 200 }]]);
});

test("respondToWidget sends the chosen value once and checks its arguments", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push([String(url).split("/api/")[1], JSON.parse(options.body)]);
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  });
  assert.deepEqual(await respondToWidget(session, { agentId: "bot-9", entryId: "t1s2", value: "yes" }), { accepted: true });
  assert.deepEqual(seen, [["respondToWidget", { agentId: "bot-9", entryId: "t1s2", value: "yes" }]]);
  await assert.rejects(respondToWidget(session, { agentId: "bot-9", entryId: "t1s2", value: "" }));
  assert.equal(seen.length, 1);
});

test("gatewayEvents reads server-sent events from /events, skipping comments", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push([String(url).split(".cursor.sh")[1] ?? String(url), options.method, options.headers.accept]);
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(":echo hi\n\ndata: {\"channel\":\"transcript\","));
        c.enqueue(enc.encode("\"payload\":{\"agentId\":\"b1\"}}\n\ndata: {\"channel\":\"agents\",\"payload\":[]}\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const got = [];
  for await (const e of gatewayEvents(session)) got.push(e.data.channel);
  assert.deepEqual(got, ["transcript", "agents"]);
  assert.equal(seen[0][1], "GET");
  assert.equal(seen[0][2], "text/event-stream");
  assert.match(String(seen[0][0]), /\/events$/);
});

test("sendPrompt to a server-run bot falls back to SendGrokBotUserMessage with the same nonce", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-token", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" });
  t.after(() => { process.env = oldEnv; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/api/listAgents")) return Response.json({ agents: [{ id: "bot-9", name: "Cloud" }] });
    if (url.endsWith("/api/sendPrompt")) return Response.json({ message: "This Bot runs on the server, and this version of the app can't message it. Update the app and try again." }, { status: 409 });
    if (url.endsWith("/aiserver.v1.GrokBotService/SendGrokBotUserMessage")) return Response.json({ dispatched: true, delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
    throw new Error("unexpected " + url);
  });
  const out = await sendPrompt({ gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "g" }, "bot-9", "hello", { clientNonce: "nonce-1" });
  assert.equal(out.delivery, "accepted");
  assert.equal(out.messageId, "nonce-1");
  const server = calls.at(-1);
  assert.equal(server.url, "http://127.0.0.1:1341/aiserver.v1.GrokBotService/SendGrokBotUserMessage");
  assert.equal(server.headers.authorization, "Bearer fixture-token");
  assert.equal(server.body.agentId, "bot-9");
  assert.equal(server.body.messageId, "nonce-1");
  assert.equal(server.body.text, "hello");
  assert.equal(server.body.rendersMcpElicitationForms, true);
  assert.equal(out.route, "server");
});

test("sendPrompt byId + serverRun goes straight to the backend, no roster or gateway call", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-token", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" });
  t.after(() => { process.env = oldEnv; });
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return Response.json({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" });
  });
  const out = await sendPrompt({ gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "g" }, "bot-9", "hi", { byId: true, serverRun: true });
  assert.equal(out.delivery, "accepted");
  assert.deepEqual(urls, ["http://127.0.0.1:1341/aiserver.v1.GrokBotService/SendGrokBotUserMessage"]);
});

test("a refused server-run send is rejected, not unknown", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-token", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" });
  t.after(() => { process.env = oldEnv; });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/api/listAgents")) return Response.json({ agents: [{ id: "bot-9", name: "Cloud" }] });
    if (url.endsWith("/api/sendPrompt")) return Response.json({ message: "This Bot runs on the server." }, { status: 409 });
    return Response.json({ delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED", refusal: { message: "Bot is paused" } });
  });
  await assert.rejects(
    sendPrompt({ gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "g" }, "bot-9", "hello"),
    (e) => e.delivery === "rejected" && /Bot is paused/.test(e.message),
  );
});

test("markAgentRead uses the gateway for box bots and the backend for server-run bots", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-token", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" });
  t.after(() => { process.env = oldEnv; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.includes("SetGrokBotAgentClientState") ? { state: { unreadCount: 0 } } : {});
  });
  const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "g" };
  assert.equal((await markAgentRead(session, "box-1")).route, "gateway");
  assert.equal((await markAgentRead(session, "srv-1", { serverRun: true })).route, "server");
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:1340/api/setAgentUnread", body: { id: "box-1", isUnread: false } },
    { url: "http://127.0.0.1:1341/aiserver.v1.GrokBotService/SetGrokBotAgentClientState", body: { agentId: "srv-1", markRead: true } },
  ]);
});

test("markAgentRead falls back to the backend when the gateway refuses a server-run bot", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-token", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" });
  t.after(() => { process.env = oldEnv; });
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.endsWith("/api/setAgentUnread")) return Response.json({ message: "Nothing was saved." }, { status: 409 });
    return Response.json({ state: {} });
  });
  const out = await markAgentRead({ gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "g" }, "srv-1");
  assert.equal(out.route, "server");
  assert.equal(urls.length, 2);
});

test("getUsage sums each bot's weekly share and reads the plan's status", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", CURSOR_ACCESS_TOKEN: "fixture-token", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" });
  t.after(() => { process.env = oldEnv; });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/aiserver.v1.DashboardService/GetSandUsageStatus")) {
      return Response.json({ usagePercent: 21.7, nextResetTimestampUtc: "2026-11-15T07:45:36.141Z", currentPeriodStart: "2026-11-09T06:39:27.982Z", grokPlanLabel: "Grok Bot Plan", cursorPlanName: "Ultra", hasAvailableUsage: true });
    }
    if (url.endsWith("/aiserver.v1.DashboardService/GetGrokBotUsageBreakdown")) {
      return Response.json({ weeklyLimitPpm: { byBot: [{ dayMs: "1", botId: "a", ppm: 15000 }, { dayMs: "2", botId: "a", ppm: 5000 }, { dayMs: "1", botId: "b", ppm: 1000 }, { dayMs: "1", ppm: 9 }] } });
    }
    throw new Error("unexpected " + url);
  });
  const u = await getUsage();
  assert.equal(u.percent, 21.7);
  assert.equal(u.resetsAt, Date.parse("2026-11-15T07:45:36.141Z"));
  assert.equal(u.plan, "Grok Bot Plan");
  assert.equal(u.window, "week");
  assert.deepEqual(u.byBot, { a: 2, b: 0.1 });
});
