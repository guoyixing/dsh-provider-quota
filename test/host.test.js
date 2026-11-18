import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { apply, inject } from "../index.js";

const ORIGIN = "http://127.0.0.1:61768";
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
      ["webServer", { getOrigin: () => ORIGIN }],
      ["connection", {
        fetch: {
          register(route) {
            // DSH owns registrations for the plugin's lifetime; model cleanup here.
            ctx.effect(() => {
              assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
              routes.set(route.path, route);
              return () => routes.delete(route.path);
            });
          },
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

async function dispatch(ctx, request, session) {
  const route = ctx.routes.get(new URL(request.url).pathname);
  if (!route?.methods.includes(request.method)) return new Response(null, { status: 404 });
  // This fixture models admission before the plugin handler; it does not validate DSH auth.
  if (session !== "owner") return new Response(null, { status: 401 });
  const response = await route.fetch(request);
  assert.ok(response instanceof Response, "handler must return a Fetch Response");
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response;
}

async function request(ctx, path, options = {}) {
  const method = options.method ?? "GET";
  // Model the authenticated Electron bridge by default: no Origin or Sec-Fetch-Site.
  const headers = new Headers(method === "POST" ? { "content-type": "application/json" } : {});
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) headers.delete(key);
    else headers.set(key, value);
  }
  const init = { method, headers };
  if (method === "POST") {
    if (options.chunks) {
      const chunks = options.chunks[Symbol.iterator]();
      init.body = new ReadableStream({
        pull(controller) {
          const chunk = chunks.next();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        },
      });
      init.duplex = "half";
    } else {
      // Byte bodies avoid Request adding a text/plain Content-Type when a test omits it.
      init.body = Buffer.from(options.rawBody ?? JSON.stringify(options.body ?? {}));
    }
  }
  const req = new Request(`${ORIGIN}${PREFIX}${path}`, init);
  const response = await dispatch(ctx, req, options.session ?? "owner");
  if (response.body === null) return { status: response.status, body: null };
  assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/i);
  return { status: response.status, body: await response.json() };
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
  assert.deepEqual(inject, ["webServer", "llm", "connection"]);
});

test("visibility saves preserve a provider id split across UTF-8 chunks", async (t) => {
  const { ctx } = await harness(t);
  const id = "provider:千问";
  const encoded = Buffer.from(JSON.stringify({ visibility: { id, visible: false } }));
  const split = encoded.indexOf(Buffer.from("千")) + 1;
  const result = await request(ctx, "/prefs", { method: "POST", chunks: [encoded.subarray(0, split), encoded.subarray(split)] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.value.hidden, { [id]: true });
});

test("a blocked quota source does not block fresh snapshots from other sources", async (t) => {
  const { ctx, intervals } = await harness(t);
  let abortSignal;
  let queries = 0;
  const removeSlow = ctx.registry.register({ id: "custom:slow", label: "Slow", fetch(signal) {
    abortSignal = signal;
    return new Promise(() => {});
  } });
  ctx.registry.register({ id: "custom:fast", label: "Fast", fetch: async () => ({ status: "ok", remaining: String(++queries) }) });
  const initialRefresh = ctx.registry.refreshAll();
  await flush();
  assert.equal(queries, 1);
  for (const timer of intervals.values()) timer.callback();
  await flush();
  assert.equal(ctx.registry.list().find((s) => s.id === "custom:fast").snapshot.remaining, "2");
  removeSlow();
  assert.ok(abortSignal.aborted);
  await initialRefresh;
  assert.ok(!ids(ctx).includes("custom:slow"));
});

test("registers the service, sorts sources, and disposes caller-owned sources and routes", async (t) => {
  const { ctx, intervals } = await harness(t);
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
    input: 10, output: 3, total: 13, cacheRead: 2, cacheWrite: 1, requests: 1, since: null,
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
  assert.equal(reloaded.registry.list()[0].snapshot.usage.total, 13);
  const reset = await request(reloaded, "/usage/reset", { method: "POST" });
  assert.equal(reset.status, 200);
  await flush();
  assert.deepEqual(JSON.parse(readFileSync(usagePath, "utf8")), {});
  assert.equal(reloaded.registry.list()[0].snapshot.usage, null);
});

test("Qwen aliases, native routes and multiple configurations stay independent and live", async (t) => {
  const { ctx, state } = await harness(t, {
    providers: ["qwen-native"],
    config: { work: { baseURL: "https://coding.dashscope.aliyuncs.com/v1" }, qwen: {} },
  });
  await stream(ctx, "work", [{ type: "usage", usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 2 } }]);
  await stream(ctx, "qwen", [{ type: "usage", usage: { totalTokens: 4 } }]);
  await stream(ctx, "qwen-native", [{ type: "usage", usage: { totalTokens: 9 } }]);
  const rows = (await request(ctx, "/list")).body.value.sources;
  assert.equal(rows.find((s) => s.id === "provider:work").snapshot.usage.total, 17);
  assert.equal(rows.find((s) => s.id === "provider:qwen").snapshot.usage.total, 4);
  assert.equal(rows.find((s) => s.id === "provider:qwen-native").snapshot.usage.total, 9);
  state.config.work = { baseURL: "https://ordinary.invalid/v1", displayName: "Changed" };
  ctx.emit("llm/adapters-updated");
  await ctx.registry.refresh();
  const changed = ctx.registry.list().find((s) => s.id === "provider:work");
  assert.equal(changed.label, "Changed");
  assert.equal(changed.snapshot.status, "unsupported");
});

test("cumulative reports count once, invalid reports are sanitized and no-usage calls are excluded", async (t) => {
  const { ctx } = await harness(t, { config: { qwen: {} } });
  await stream(ctx, "qwen", [
    { type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
    { type: "usage", usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 } },
    { type: "usage", usage: { totalTokens: NaN } },
  ]);
  assert.equal(ctx.registry.list()[0].snapshot.usage.total, 6);
  assert.equal(ctx.registry.list()[0].snapshot.usage.requests, 1);
  await stream(ctx, "qwen", [{ type: "text", text: "no usage" }]);
  await stream(ctx, "qwen", [{ type: "usage", usage: {} }]);
  await stream(ctx, "qwen", [{ type: "usage", usage: { inputTokens: -1, outputTokens: Infinity } }]);
  assert.equal(ctx.registry.list()[0].snapshot.usage.requests, 1);
  await stream(ctx, "qwen", [{ type: "usage", usage: { inputTokens: -4, outputTokens: 2, cacheReadTokens: Infinity } }]);
  assert.equal(ctx.registry.list()[0].snapshot.usage.total, 8);
  assert.equal(ctx.registry.list()[0].snapshot.usage.input, 2);
});

test("stream errors and cancellation propagate and finalize only reported usage", async (t) => {
  const { ctx } = await harness(t, { config: { qwen: {} } });
  const observe = [...ctx.listeners.get("llm/stream")][0];
  const failure = new Error("upstream failure");
  const original = (async function* () { yield { type: "usage", usage: { totalTokens: 3 } }; throw failure; })();
  await assert.rejects(async () => { for await (const chunk of observe({ provider: "qwen" }, () => original)) void chunk; }, (err) => err === failure);
  let closed = false;
  const cancelled = observe({ provider: "qwen" }, () => (async function* () {
    try { yield { type: "usage", usage: { totalTokens: 2 } }; yield { type: "text", text: "rest" }; }
    finally { closed = true; }
  })());
  await cancelled.next();
  await cancelled.return();
  assert.equal(closed, true);
  assert.equal(ctx.registry.list()[0].snapshot.usage.total, 5);
  assert.equal(ctx.registry.list()[0].snapshot.usage.requests, 2);
});

test("reset, pause and disposal invalidate in-flight usage without blocking streams", async (t) => {
  const { ctx } = await harness(t, { config: { qwen: {} } });
  const observe = [...ctx.listeners.get("llm/stream")][0];
  const start = async () => {
    const iterator = observe({ provider: "qwen" }, () => (async function* () { yield { type: "usage", usage: { totalTokens: 100 } }; })());
    await iterator.next();
    return iterator;
  };
  const beforeReset = await start();
  await request(ctx, "/usage/reset", { method: "POST" });
  await beforeReset.next();
  assert.equal(ctx.registry.list()[0].snapshot.usage, null);
  await stream(ctx, "qwen", [{ type: "usage", usage: { totalTokens: 7 } }]);
  const beforePause = await start();
  await request(ctx, "/prefs", { method: "POST", body: { trackUsage: false } });
  assert.equal(ctx.registry.list()[0].snapshot.tracking, false);
  const whilePaused = await start();
  await request(ctx, "/prefs", { method: "POST", body: { trackUsage: true } });
  await beforePause.next();
  await whilePaused.next();
  assert.equal(ctx.registry.list()[0].snapshot.usage.total, 7);
  const beforeDispose = await start();
  ctx.dispose();
  await beforeDispose.next();
});

test("invalid stored counters are sanitized and failed writes retry without breaking generation", async (t) => {
  const { ctx, home, boot, intervals } = await harness(t, { config: { qwen: {} } });
  ctx.dispose();
  const directory = join(home, "plugins", "provider-quota");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "usage.json");
  writeFileSync(path, JSON.stringify({ qwen: { requests: 1, input: -5, output: "bad", total: 9, cacheRead: null }, broken: null }));
  const reloaded = boot();
  await flush();
  assert.equal(reloaded.registry.list()[0].snapshot.usage.input, 0);
  assert.equal(reloaded.registry.list()[0].snapshot.usage.output, 0);
  const temporary = join(directory, "usage.json.tmp");
  mkdirSync(temporary);
  await stream(reloaded, "qwen", [{ type: "usage", usage: { totalTokens: 4 } }]);
  assert.equal(reloaded.registry.list()[0].snapshot.usage.total, 13);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).qwen.total, 9);
  assert.equal(resolve(temporary), join(resolve(home), "plugins", "provider-quota", "usage.json.tmp"));
  rmdirSync(temporary); // Exact empty directory made above, not user data.
  for (const timer of intervals.values()) timer.callback();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).qwen.total, 13);
  mkdirSync(temporary);
  assert.equal((await request(reloaded, "/usage/reset", { method: "POST" })).status, 500);
  assert.equal(resolve(temporary), join(resolve(home), "plugins", "provider-quota", "usage.json.tmp"));
  rmdirSync(temporary);
  for (const timer of intervals.values()) timer.callback();
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
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

test("registers exact Connection Fetch routes with explicit methods and body modes", async (t) => {
  const { ctx } = await harness(t);
  const routes = [...ctx.routes.values()].map(({ path, methods, requestBody, fetch }) => {
    assert.equal(typeof fetch, "function");
    return [path, [...methods].sort(), requestBody];
  });
  assert.deepEqual(routes.sort(([a], [b]) => a.localeCompare(b)), [
    [`${PREFIX}/list`, ["GET", "HEAD"], "buffered"],
    [`${PREFIX}/prefs`, ["GET", "POST"], "buffered"],
    [`${PREFIX}/refresh`, ["POST"], "buffered"],
    [`${PREFIX}/usage/reset`, ["POST"], "buffered"],
  ]);
  assert.deepEqual(await request(ctx, "/list", { method: "HEAD" }), { status: 200, body: null });
  assert.deepEqual(await request(ctx, "/list?test=1"), await request(ctx, "/list"));
  for (const [path, method] of [["/list/extra", "GET"], ["/list", "PUT"], ["/prefs", "HEAD"], ["/refresh", "GET"], ["/usage/reset", "GET"]]) {
    assert.equal((await request(ctx, path, { method })).status, 404, `${method} ${path}`);
  }
});

test("an Origin-less desktop owner admitted by the fixture can save prefs and refresh quota", async (t) => {
  const { ctx, home } = await harness(t);
  const id = "custom:desktop";
  let queries = 0;
  ctx.registry.register({ id, label: "Desktop test quota", fetch: async () => ({ status: "ok", remaining: String(++queries) }) });
  await flush();
  const initial = await request(ctx, "/list");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.value.sources[0].snapshot.remaining, "1");

  // Matching routes are denied by the fixture before invoking plugin handlers.
  const change = { method: "POST", body: { refreshSeconds: 123, visibility: { id, visible: false } } };
  assert.equal((await request(ctx, "/list", { session: "anonymous" })).status, 401);
  assert.equal((await request(ctx, "/prefs", { ...change, session: "anonymous" })).status, 401);
  assert.deepEqual((await request(ctx, "/prefs")).body.value, initial.body.value.prefs);

  const save = await request(ctx, "/prefs", change);
  assert.equal(save.status, 200);
  assert.deepEqual(save.body, { ok: true, value: { ...initial.body.value.prefs, refreshSeconds: 123, hidden: { [id]: true } } });
  assert.deepEqual(await request(ctx, "/prefs"), save);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "plugins", "provider-quota", "prefs.json"), "utf8")), save.body.value);

  const refreshed = await request(ctx, "/refresh", { method: "POST" });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.ok, true);
  assert.deepEqual(refreshed.body.value.prefs, save.body.value);
  const [source] = refreshed.body.value.sources;
  assert.equal(source.id, id);
  assert.equal(source.snapshot.remaining, "2");
  assert.ok(refreshed.body.value.updatedAt >= initial.body.value.updatedAt);
  assert.deepEqual(await request(ctx, "/list"), refreshed);
});

test("every POST checks application/json before changing state", async (t) => {
  const { ctx } = await harness(t, { config: { qwen: {} } });
  let queries = 0;
  ctx.registry.register({ id: "custom:counter", label: "Counter", fetch: async () => ({ status: "ok", remaining: String(++queries) }) });
  await flush();
  await stream(ctx, "qwen", [{ type: "usage", usage: { totalTokens: 7 } }]);
  const before = await request(ctx, "/list");
  for (const path of ["/prefs", "/refresh", "/usage/reset"]) {
    for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/json-evil"]) {
      const response = await request(ctx, path, { method: "POST", headers: { "content-type": contentType }, body: { refreshSeconds: 123 } });
      assert.equal(response.status, 415, `${path}: ${contentType}`);
      assert.deepEqual(response.body, { ok: false, error: { message: "application/json required" } });
    }
  }
  assert.deepEqual(await request(ctx, "/list"), before);
  assert.equal(queries, 1);
  for (const path of ["/prefs", "/refresh", "/usage/reset"]) {
    assert.equal((await request(ctx, path, { method: "POST", headers: { "content-type": "Application/JSON; charset=utf-8" } })).status, 200);
  }
});

test("prefs rejects malformed JSON and measures its body limit in bytes", async (t) => {
  const { ctx } = await harness(t);
  const post = (options) => request(ctx, "/prefs", { method: "POST", ...options });
  const original = await request(ctx, "/prefs");
  const head = Buffer.from('{"refreshSeconds":123,"padding":"');
  const tail = Buffer.from('"}');
  const padding = Buffer.from("千".repeat(300_000));
  const rest = Buffer.alloc(1_000_000 - head.length - padding.length - tail.length, 0x61);
  for (const options of [{ rawBody: "{" }, { rawBody: "[]" }, { chunks: [head, padding, rest, Buffer.from("a"), tail] }]) {
    assert.deepEqual(await post(options), { status: 400, body: { ok: false, error: { message: "invalid prefs body" } } });
  }
  assert.deepEqual(await request(ctx, "/prefs"), original);
  const atLimit = await post({ chunks: [head, padding, rest, tail] });
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.body.value.refreshSeconds, 123);
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

test("item visibility patches merge concurrent changes, including unusual ids, and survive restart", async (t) => {
  const { ctx, boot } = await harness(t);
  const warnings = [];
  ctx.logger.warn = (message) => warnings.push(message);
  const post = (body) => request(ctx, "/prefs", { method: "POST", body });
  const change = (id, visible) => post({ visibility: { id, visible } });
  assert.equal((await post({ hidden: { legacy: true } })).status, 200);
  const writes = await Promise.all([change("甲", false), change("__proto__", false)]);
  assert.deepEqual(writes.map((r) => r.status), [200, 200], JSON.stringify(writes));
  const expected = { legacy: true, 甲: true, ["__proto__"]: true };
  assert.deepEqual((await request(ctx, "/list")).body.value.prefs.hidden, expected);
  assert.equal((await post({ visibility: { id: "甲", visible: "no" } })).status, 400);
  assert.equal((await post({ hidden: {}, visibility: { id: "甲", visible: true } })).status, 400);
  assert.equal((await change("甲", true)).status, 200);
  ctx.dispose();
  assert.deepEqual((await request(boot(), "/prefs")).body.value.hidden, { legacy: true, ["__proto__"]: true });
});

test("failed preference persistence leaves memory, file and timers unchanged; retry commits", async (t) => {
  const { ctx, home, intervals } = await harness(t);
  const post = (body) => request(ctx, "/prefs", { method: "POST", body });
  assert.equal((await post({ hidden: { keep: true } })).status, 200);
  const original = (await request(ctx, "/prefs")).body.value;
  const dir = join(home, "plugins", "provider-quota");
  const temporary = join(dir, `prefs.${process.pid}.tmp`);
  mkdirSync(temporary); // deterministic write failure even with elevated file permissions
  const patch = { visibility: { id: "new", visible: false }, refreshSeconds: 12, trackUsage: false };
  const originalTimer = [...intervals.keys()][0];
  const failure = await post(patch);
  assert.equal(failure.status, 500);
  assert.equal(failure.body.ok, false);
  assert.deepEqual((await request(ctx, "/list")).body.value.prefs, original);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "prefs.json"), "utf8")), original);
  assert.deepEqual([...intervals.keys()], [originalTimer]);
  rmdirSync(temporary);
  const retry = await post(patch);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body.value.hidden, { keep: true, new: true });
  assert.equal(retry.body.value.trackUsage, false);
});
