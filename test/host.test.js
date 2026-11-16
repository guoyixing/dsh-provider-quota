import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { apply, inject } from "../index.js";

const ORIGIN = "http://127.0.0.1:61768";
const HOST = new URL(ORIGIN).host;
const PREFIX = "/api/provider-quota";
const PACKAGE = "@keyboard-dog/dsh-provider-quota";
const flush = () => new Promise((done) => setImmediate(done));

function createScope() {
  const effects = [];
  return {
    effect(setup) {
      const cleanup = setup();
      let active = true;
      const dispose = () => {
        if (!active) return;
        active = false;
        if (typeof cleanup === "function") cleanup();
      };
      effects.push(dispose);
      return dispose;
    },
    dispose() {
      for (const dispose of effects.slice().reverse()) dispose();
    },
  };
}

async function harness(t, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "dsh-provider-quota-test-"));
  const savedEnv = new Map();
  function env(key, value) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  env("DSH_HOME", home);
  env("DEEPSEEK_API_KEY", undefined);
  const intervals = new Map();
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    const handle = {};
    intervals.set(handle, { callback, delay });
    return handle;
  });
  t.mock.method(globalThis, "clearInterval", (handle) => intervals.delete(handle));
  const fetchCalls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (options.fetch) return options.fetch(String(url), init);
    throw new Error(`Unexpected fetch in isolated host test: ${url}`);
  });
  const state = { providers: options.providers ?? [], config: options.config ?? {} };
  const contexts = [];
  function boot(config = {}) {
    const ctx = createScope();
    const listeners = new Map();
    const routes = new Map();
    const services = new Map([
      ["llm", { listProviders: () => state.providers }],
      ["configEditor", { configuration: () => [{
        entry: { options: { id: "llm-pi-ai" } },
        override: { providers: state.config },
      }] }],
      ["webServer", {
        getOrigin: () => ORIGIN,
        register(route) {
          assert.equal(route.kind, "exact");
          assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      }],
    ]);
    ctx.get = (key) => services.get(key);
    ctx.provide = (key, value) => services.set(key, value);
    ctx.logger = { warn() {} };
    ctx.on = (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event).delete(handler);
    };
    ctx.emit = (event) => {
      for (const handler of listeners.get(event) ?? []) handler();
    };
    Object.assign(ctx, { routes, listeners, services });
    contexts.push(ctx);
    apply(ctx, config);
    ctx.registry = services.get("providerQuota");
    return ctx;
  }
  t.after(async () => {
    try {
      for (const ctx of contexts.slice().reverse()) ctx.dispose();
      await flush();
      assert.equal(intervals.size, 0, "all plugin intervals must be disposed");
      for (const ctx of contexts) {
        assert.equal(ctx.routes.size, 0, "all HTTP routes must be disposed");
        for (const handlers of ctx.listeners.values()) assert.equal(handlers.size, 0);
      }
      if (!options.fetch) assert.equal(fetchCalls.length, 0, "no unexpected network attempts");
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      t.mock.restoreAll();
      // Only remove the exact temporary directory created by this fixture.
      assert.equal(dirname(resolve(home)), resolve(tmpdir()));
      assert.ok(home.startsWith(join(tmpdir(), "dsh-provider-quota-test-")));
      rmSync(home, { recursive: true, force: true });
    }
  });
  const ctx = boot(options.prefs);
  await flush();
  return { ctx, state, home, env, boot, intervals, fetchCalls };
}

async function request(ctx, path, options = {}) {
  const method = options.method ?? "GET";
  const body = options.rawBody ?? JSON.stringify(options.body ?? {});
  const req = Readable.from(method === "POST" ? [body] : []);
  req.method = method;
  req.url = `${PREFIX}${path}`;
  req.socket = options.noSocket ? undefined : { remoteAddress: options.address ?? "127.0.0.1" };
  req.headers = {
    host: HOST,
    ...(method === "POST" ? { origin: ORIGIN, "content-type": "application/json" } : {}),
    ...options.headers,
  };
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) delete req.headers[key];
  }
  let status;
  let headers;
  let result;
  const res = {
    writeHead(code, responseHeaders) { status = code; headers = responseHeaders; },
    end(text) { result = JSON.parse(text); },
  };
  const route = ctx.routes.get(req.url);
  assert.ok(route, `registered route ${req.url}`);
  await route.handler(req, res);
  assert.ok(status, "handler must send an HTTP response");
  assert.equal(headers["cache-control"], "no-store");
  return { status, body: result, headers };
}

function ids(ctx) {
  return ctx.registry.list().map((source) => source.id).sort();
}

async function stream(ctx, provider, chunks) {
  const handlers = [...ctx.listeners.get("llm/stream")];
  assert.equal(handlers.length, 1);
  const original = (async function* () { yield* chunks; })();
  let nextCalls = 0;
  const output = handlers[0]({ provider }, () => { nextCalls++; return original; });
  if (!/qwen|token-plan|qianwen/i.test(provider)) assert.equal(output, original);
  const received = [];
  for await (const chunk of output) received.push(chunk);
  assert.equal(nextCalls, 1);
  assert.equal(received.length, chunks.length);
  received.forEach((chunk, index) => assert.equal(chunk, chunks[index]));
}

test("package export and patch use the published scoped package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.equal(pkg.name, PACKAGE);
  assert.equal(pkg.exports["."], "./index.js");
  assert.ok(patch.includes(`name: '${PACKAGE}'`) || patch.includes(`name: "${PACKAGE}"`));
  assert.ok(!patch.includes("@local/provider-quota"));
  assert.deepEqual(inject, ["webServer", "llm"]);
});

test("registers service/routes, sorts sources, and disposes caller-owned sources", async (t) => {
  const { ctx, intervals } = await harness(t);
  assert.deepEqual([...ctx.routes.keys()].sort(), ["/list", "/prefs", "/refresh", "/usage/reset"].map((p) => PREFIX + p).sort());
  assert.equal(intervals.size, 1);
  assert.deepEqual(ctx.registry[Symbol.for("cordis.tracker")], { property: "ctx", noShadow: true });
  assert.throws(() => ctx.registry.register({ id: "broken" }), /source needs/);
  const scope = createScope();
  t.after(() => scope.dispose());
  const dispose = ctx.registry.register.call({ ctx: scope }, {
    id: "custom:later", label: "Later", order: 5,
    fetch: async (signal) => { assert.ok(signal instanceof AbortSignal); return { status: "ok", remaining: "42%" }; },
  });
  ctx.registry.register({ id: "custom:first", label: "First", order: -1, fetch: async () => ({ status: "unsupported" }) });
  await ctx.registry.refresh();
  assert.deepEqual(ctx.registry.list().map((s) => s.id), ["custom:first", "custom:later"]);
  assert.equal(ctx.registry.list()[1].snapshot.remaining, "42%");
  dispose();
  dispose();
  assert.deepEqual(ids(ctx), ["custom:first"]);
  ctx.registry.register.call({ ctx: scope }, { id: "custom:scoped", label: "Scoped", fetch: async () => ({ status: "ok" }) });
  scope.dispose();
  assert.deepEqual(ids(ctx), ["custom:first"]);
  ctx.dispose();
  assert.deepEqual(ctx.registry.list(), []);
  assert.equal(ctx.routes.size, 0);
  assert.equal(intervals.size, 0);
});

test("reconciles configured providers and subscriptions on adapters-updated", async (t) => {
  const { ctx, state } = await harness(t, {
    providers: [{ id: "codex/account", name: "Codex" }],
    config: { qwen: { baseURL: "https://qwen.invalid/v1" } },
  });
  ctx.registry.register({ id: "custom:keep", label: "Keep", fetch: async () => ({ status: "ok" }) });
  await ctx.registry.refresh();
  assert.deepEqual(ids(ctx), ["custom:keep", "plugin:subscriptions:codex", "provider:qwen"]);
  assert.equal(ctx.registry.list().find((s) => s.id === "plugin:subscriptions:codex").snapshot.status, "client-fetch");
  state.providers = ["claude/account"];
  state.config = {};
  ctx.emit("llm/adapters-updated");
  await flush();
  assert.deepEqual(ids(ctx), ["custom:keep", "plugin:subscriptions:claude"]);
  state.providers = [];
  ctx.emit("llm/adapters-updated");
  await flush();
  assert.deepEqual(ids(ctx), ["custom:keep"]);
});

test("Qwen streams pass chunks through, persist local usage, reload, and reset", async (t) => {
  const { ctx, home, intervals, boot } = await harness(t, {
    config: { qwen: { baseURL: "https://qwen.invalid/v1" } },
  });
  const chunks = [
    { type: "text", text: "hello" },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 2, cacheWriteTokens: 1 } },
    { type: "done" },
  ];
  await stream(ctx, "qwen", chunks);
  await stream(ctx, "qianwen/token-plan", [{ type: "usage", usage: { inputTokens: 4, outputTokens: 2 } }]);
  await stream(ctx, "other", chunks);
  await ctx.registry.refresh();
  const snapshot = ctx.registry.list()[0].snapshot;
  assert.equal(snapshot.status, "local");
  assert.equal(new URL(snapshot.link).hostname, "platform.qianwenai.com");
  assert.deepEqual({ ...snapshot.usage, since: null }, {
    input: 14, output: 5, total: 19, cacheRead: 2, cacheWrite: 1, requests: 2, since: null,
  });
  assert.ok(snapshot.usage.since > 0);
  for (const timer of intervals.values()) timer.callback();
  await flush();
  const usagePath = join(home, "plugins", "provider-quota", "usage.json");
  const stored = JSON.parse(readFileSync(usagePath, "utf8"));
  assert.equal(stored.qwen.total, 13);
  assert.equal(stored["qianwen/token-plan"].total, 6);
  assert.equal(stored.other, undefined);
  ctx.dispose();
  const reloaded = boot();
  await flush();
  assert.equal(reloaded.registry.list()[0].snapshot.usage.total, 19);
  const reset = await request(reloaded, "/usage/reset", { method: "POST" });
  assert.equal(reset.status, 200);
  await flush();
  assert.deepEqual(JSON.parse(readFileSync(usagePath, "utf8")), {});
  assert.equal(reloaded.registry.list()[0].snapshot.usage, null);
});

test("preferences clamp refresh interval, persist, and toggle owned sources and usage", async (t) => {
  const { ctx, home, intervals, boot } = await harness(t, {
    providers: ["factory/account", "codex/account"],
    config: { qwen: { baseURL: "https://qwen.invalid/v1" } },
    fetch: async (url) => {
      assert.equal(url, `${ORIGIN}/api/dsh-factory-provider/quota`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, value: { standard: { weekly: { usedPercent: 25 } } } }) };
    },
  });
  assert.deepEqual(ids(ctx), ["plugin:factory", "plugin:subscriptions:codex", "provider:qwen"]);
  let response = await request(ctx, "/prefs", { method: "POST", body: {
    refreshSeconds: 1, queryProviders: false, bridgeFactory: false,
    bridgeSubscriptions: false, trackUsage: false, hidden: { qwen: true },
  } });
  assert.equal(response.status, 200);
  assert.equal(response.body.value.refreshSeconds, 5);
  assert.deepEqual(ids(ctx), []);
  assert.equal(intervals.size, 1);
  assert.equal([...intervals.values()][0].delay, 5000);
  await stream(ctx, "qwen", [{ type: "usage", usage: { totalTokens: 999 } }]);
  response = await request(ctx, "/prefs", { method: "POST", body: {
    refreshSeconds: 99999, queryProviders: true, bridgeFactory: true, bridgeSubscriptions: true,
  } });
  assert.equal(response.body.value.refreshSeconds, 3600);
  assert.equal([...intervals.values()][0].delay, 3600000);
  await ctx.registry.refresh();
  assert.equal(ctx.registry.list().find((s) => s.id === "provider:qwen").snapshot.usage, null);
  assert.deepEqual(ids(ctx), ["plugin:factory", "plugin:subscriptions:codex", "provider:qwen"]);
  response = await request(ctx, "/prefs", { method: "POST", body: { refreshSeconds: "not-a-number", queryProviders: "false" } });
  assert.equal(response.body.value.refreshSeconds, 60);
  assert.equal(response.body.value.queryProviders, true, "non-boolean toggles are ignored");
  const stored = JSON.parse(readFileSync(join(home, "plugins", "provider-quota", "prefs.json"), "utf8"));
  assert.deepEqual(stored.hidden, { qwen: true });
  assert.equal(stored.trackUsage, false);
  ctx.dispose();
  const reloaded = boot();
  await flush();
  const prefs = await request(reloaded, "/prefs");
  assert.deepEqual(prefs.body.value, stored);
});

test("HTTP guard accepts local same-origin requests and rejects foreign socket/Host/Origin", async (t) => {
  const { ctx } = await harness(t);
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal((await request(ctx, "/list", { address })).status, 200);
  }
  assert.equal((await request(ctx, "/list", { headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } })).status, 200);
  const invalid = [
    { address: "192.0.2.1" }, { address: "" }, { noSocket: true },
    { headers: { host: "attacker.invalid:61768" } },
    { headers: { host: "127.0.0.1:9999" } },
    { headers: { host: undefined } },
    { headers: { origin: "https://attacker.invalid" } },
    { headers: { origin: "null" } },
    { headers: { origin: "http://localhost:61768" } },
    { headers: { "sec-fetch-site": "cross-site" } },
  ];
  for (const path of ["/list", "/prefs", "/refresh", "/usage/reset"]) {
    const method = path === "/list" || path === "/prefs" ? "GET" : "POST";
    for (const options of invalid) {
      const response = await request(ctx, path, { method, ...options });
      assert.equal(response.status, 403, `${path}: ${JSON.stringify(options)}`);
      assert.equal(response.body.ok, false);
    }
  }
});

test("every POST requires matching Origin and application/json before changing state", async (t) => {
  const { ctx } = await harness(t);
  for (const path of ["/prefs", "/refresh", "/usage/reset"]) {
    for (const headers of [
      { origin: undefined }, { origin: "https://attacker.invalid" },
      { "content-type": undefined }, { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "application/json-evil" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const response = await request(ctx, path, { method: "POST", headers, body: { refreshSeconds: 123 } });
      assert.ok([403, 415].includes(response.status), `${path}: ${JSON.stringify(headers)} returned ${response.status}`);
      assert.equal(response.body.ok, false);
    }
    assert.equal((await request(ctx, path, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" } })).status, 200);
  }
  assert.equal((await request(ctx, "/prefs")).body.value.refreshSeconds, 60);
  assert.equal((await request(ctx, "/prefs", { method: "POST", rawBody: "{" })).status, 400);
  assert.equal((await request(ctx, "/list", { method: "PUT" })).status, 405);
  assert.equal((await request(ctx, "/refresh")).status, 405);
});

test("untrusted DeepSeek proxy with missing explicit key never receives the default key", async (t) => {
  const { ctx, state, env, fetchCalls } = await harness(t, {
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "1" }] }) }),
  });
  env("DEEPSEEK_API_KEY", "test-only-default-secret-do-not-forward");
  env("MISSING", undefined);
  state.config = {
    "deepseek-proxy": { baseURL: "https://untrusted.invalid/v1", apiKeyEnv: "MISSING" },
    "deepseek-proxy-no-key": { baseURL: "https://untrusted.invalid/v1" },
  };
  ctx.services.set("credentials", { resolve: async () => undefined });
  ctx.emit("llm/adapters-updated");
  await ctx.registry.refresh();
  assert.equal(fetchCalls.length, 0, "a global DeepSeek key must never be forwarded to an untrusted proxy");
  assert.equal(ctx.registry.list().length, 2);
  for (const source of ctx.registry.list()) assert.equal(source.snapshot.status, "unsupported");
  ctx.services.set("credentials", { resolve: async () => { throw new Error("credential store unavailable"); } });
  await ctx.registry.refresh();
  assert.equal(fetchCalls.length, 0, "credential lookup failure must not enable global-key fallback");
});
