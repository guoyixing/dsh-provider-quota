import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const flush = () => new Promise((done) => setImmediate(done));
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function client(t, options = {}) {
  let cursor = 0;
  let pending = [];
  const hooks = [];
  const effects = [];
  const intervals = new Map();
  const timeouts = new Map();
  const slots = new Map();
  const events = new Map();
  const requests = [];
  const rpcCalls = [];
  const styles = [];
  const confirmations = [];
  const dispatched = [];
  let dictionaries;
  const state = {
    prefs: { refreshSeconds: options.refreshSeconds ?? 17, hidden: {} },
    sources: options.sources ?? [{ id: "plugin:subscriptions:codex", label: "Codex", snapshot: { status: "client-fetch", provider: "codex" } }],
  };
  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === "function" ? initial() : initial;
      return [hooks[i], (next) => { hooks[i] = typeof next === "function" ? next(hooks[i]) : next; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: initial };
      return hooks[i];
    },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!hooks[i] || !equalDeps(hooks[i].deps, deps)) hooks[i] = { callback, deps };
      return hooks[i].callback;
    },
    useEffect(callback, deps) {
      const i = cursor++;
      if (!hooks[i] || !equalDeps(hooks[i].deps, deps)) {
        const old = hooks[i];
        hooks[i] = { deps };
        pending.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); });
      }
    },
  };
  let definition;
  const window = {
    __ModuleLoader__: { load(value) { definition = value; } },
    addEventListener(event, handler) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event).add(handler);
    },
    removeEventListener(event, handler) { events.get(event)?.delete(handler); },
    dispatchEvent(event) { dispatched.push(event.type); for (const handler of events.get(event.type) ?? []) handler(event); },
    confirm(message) { confirmations.push(message); return options.confirm ? options.confirm(message) : true; },
  };
  const document = {
    querySelector() { return null; },
    createElement() { const tag = { dataset: {}, remove() { styles.splice(styles.indexOf(tag), 1); } }; return tag; },
    head: { appendChild(tag) { styles.push(tag); } },
  };
  runInNewContext(source, {
    window, document, AbortController, AbortSignal,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setInterval(callback, delay) { const id = {}; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = {}; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      assert.ok(["/api/provider-quota/list", "/api/provider-quota/prefs", "/api/provider-quota/refresh", "/api/provider-quota/usage/reset"].includes(url));
      if (options.fetch) {
        const response = await options.fetch(url, init, state);
        if (response) return response;
      }
      return { ok: true, json: async () => ({ ok: true, value: url.endsWith("/prefs") ? state.prefs : state }) };
    },
  }, { filename: "client.js" });
  const plugin = definition.factory((id) => {
    if (id === "react") return React;
    if (id === "react-dom") return { createPortal: (element) => element };
    throw new Error(`Unexpected dependency: ${id}`);
  });
  plugin.apply({
    effect(setup) { const dispose = setup(); if (typeof dispose === "function") effects.push(dispose); return dispose; },
    locale: {
      register(_namespace, values) { dictionaries = values; return () => {}; },
      bind: () => (key) => options.locale ? dictionaries[options.locale][key] : key,
    },
    get: () => ({ rpc: { call: async (...args) => {
      rpcCalls.push(args);
      if (options.rpc) return options.rpc(...args);
      if (args[1] === "subscriptions-auth.status") return { value: { providers: { codex: { accounts: [
        { key: "first", isDefault: false }, { key: "default-account", isDefault: true },
      ] } } } };
      return { ok: true, value: { supported: true, windows: [{ kind: "weekly", usedPercent: 25 }] } };
    } } }),
    slots: {
      inject(name, setup) { setup(); },
      register(meta, component) { slots.set(meta.name, { meta, component }); return () => slots.delete(meta.name); },
    },
  });
  let element;
  function mount(slot = "sidebar.footer.action") {
    element = slots.get(slot).component({ wide: true });
    return render();
  }
  function render() {
    cursor = 0;
    const result = element.type(element.props);
    const queue = pending;
    pending = [];
    for (const run of queue) run();
    return result;
  }
  t.after(() => {
    for (const hook of hooks) hook?.cleanup?.();
    for (const dispose of effects.reverse()) dispose();
    assert.equal(intervals.size, 0);
    assert.equal(styles.length, 0);
    for (const handlers of events.values()) assert.equal(handlers.size, 0);
    timeouts.clear();
    slots.clear();
  });
  return { definition, plugin, slots, mount, render, intervals, timeouts, requests, rpcCalls, state, styles, confirmations, dispatched,
    changed: (prefs) => window.dispatchEvent({ type: "provider-quota:changed", detail: prefs ? { prefs } : undefined }),
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...(tree.props?.children ?? []).flatMap(nodes)];
}
function panel(tree) { return tree.props.children[0]; }

test("client module registers the scoped id, sidebar widget, settings and removable CSS", (t) => {
  const app = client(t);
  assert.equal(app.definition.id, "@keyboard-dog/dsh-provider-quota");
  assert.equal(app.plugin.inject.join(","), "slots,locale,connection");
  assert.deepEqual([...app.slots.keys()], ["sidebar.footer.action", "settings.section"]);
  assert.equal(app.styles[0].dataset.plugin, "@keyboard-dog/dsh-provider-quota");
});

test("slow subscription usage survives polling and a click queues one forced check", async (t) => {
  let finish;
  let usageCalls = 0;
  const app = client(t, { refreshSeconds: 5, rpc: async (_path, method, payload) => {
    if (method.endsWith(".status")) return { ok: true, value: { providers: { codex: { accounts: [{ key: "main" }] } } } };
    if (++usageCalls === 1) return new Promise((resolve) => { finish = resolve; });
    assert.equal(payload.force, true);
    return { ok: true, value: { supported: true, windows: [{ kind: "weekly", usedPercent: 40 }] } };
  } });
  app.mount();
  await flush();
  const timer = [...app.intervals.values()][0];
  for (let i = 0; i < 3; i++) { timer.callback(); await flush(); }
  assert.equal(usageCalls, 1);
  const manual = panel(app.render()).props.onRefresh();
  await flush();
  assert.equal(usageCalls, 1);
  assert.equal(panel(app.render()).props.refreshing, true);
  finish({ ok: true, value: { supported: true, windows: [{ kind: "weekly", usedPercent: 25 }] } });
  await manual;
  assert.equal(usageCalls, 2);
  assert.equal(panel(app.render()).props.sources[0].snapshot.remaining, "60%");
  assert.equal(panel(app.render()).props.refreshing, false);
});

test("a timed-out subscription keeps the last quota marked stale and the next poll recovers", async (t) => {
  let usageCalls = 0;
  const app = client(t, { rpc: async (_path, method) => {
    if (method.endsWith(".status")) return { ok: true, value: { providers: { codex: { accounts: [{ key: "main" }] } } } };
    if (++usageCalls === 2) return new Promise(() => {});
    return { ok: true, value: { supported: true, windows: [{ kind: "weekly", usedPercent: usageCalls * 10 }] } };
  } });
  app.mount();
  await flush();
  assert.equal(panel(app.render()).props.sources[0].snapshot.remaining, "90%");
  app.changed();
  await flush();
  assert.equal(panel(app.render()).props.sources[0].snapshot.remaining, "90%");
  const timeout = [...app.timeouts.values()].find(({ delay }) => delay === 60000);
  assert.ok(timeout);
  timeout.callback();
  await flush();
  const stale = panel(app.render()).props.sources[0].snapshot;
  assert.equal(stale.stale, true);
  assert.ok(stale.error);
  assert.equal(stale.remaining, "90%");
  app.changed();
  await flush();
  const fresh = panel(app.render()).props.sources[0].snapshot;
  assert.equal(fresh.stale, false);
  assert.equal(fresh.remaining, "70%");
});

test("subscription status selects the default account and configured interval replaces default", async (t) => {
  const app = client(t, { refreshSeconds: 23 });
  app.mount();
  await flush();
  const view = panel(app.render());
  assert.equal(app.rpcCalls.length, 2);
  assert.equal(app.rpcCalls[0][1], "subscriptions-auth.status");
  assert.equal(app.rpcCalls[1][0], "/api");
  assert.equal(app.rpcCalls[1][1], "subscriptions-auth.usage");
  assert.equal(app.rpcCalls[1][2].provider, "codex");
  assert.equal(app.rpcCalls[1][2].account, "default-account");
  assert.equal(view.props.sources.length, 1);
  assert.equal(view.props.sources[0].snapshot.remaining, "75%");
  assert.equal(app.intervals.size, 1);
  assert.equal([...app.intervals.values()][0].delay, 23000);
  app.state.prefs.refreshSeconds = 9;
  [...app.intervals.values()][0].callback();
  await flush();
  app.render();
  assert.equal(app.intervals.size, 1);
  assert.equal([...app.intervals.values()][0].delay, 9000);
});

test("subscription status and usage failures remain visible rather than looking signed out", async (t) => {
  for (const failingMethod of ["subscriptions-auth.status", "subscriptions-auth.usage"]) {
    await t.test(failingMethod, async (t) => {
      const app = client(t, { rpc: async (_path, method) => {
        if (method === failingMethod) throw new Error("mock RPC failure");
        return { value: { providers: { codex: { accounts: [{ key: "account", isDefault: true }] } } } };
      } });
      app.mount();
      await flush();
      const view = panel(app.render());
      assert.equal(view.props.sources.length, 1);
      assert.equal(view.props.sources[0].snapshot.status, "error");
      const panelTree = view.type(view.props);
      const row = nodes(panelTree).find((node) => node.props.source);
      const rowTree = row.type(row.props);
      assert.ok(nodes(rowTree).some((node) => node.props.className === "pq-value pq-err"));
    });
  }
});

test("refresh POST declares JSON and sends a JSON body", async (t) => {
  const app = client(t);
  app.mount();
  await flush();
  await panel(app.render()).props.onRefresh();
  await flush();
  const request = app.requests.find((r) => r.url.endsWith("/refresh"));
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.init.body), {});
});

test("settings reset POST declares JSON and sends a JSON body", async (t) => {
  const app = client(t, { sources: [] });
  app.mount("settings.section");
  await flush();
  const tree = app.render();
  const reset = nodes(tree).find((node) => node.type === "button" && node.props.children.includes("reset"));
  assert.ok(reset);
  await reset.props.onClick();
  const request = app.requests.find((r) => r.url.endsWith("/usage/reset"));
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.init.body), {});
  assert.deepEqual(app.confirmations, ["resetConfirm"]);
  assert.deepEqual(app.dispatched, ["provider-quota:changed"]);
  assert.ok(nodes(app.render()).some((node) => node.props.children.includes("resetSuccess")));
});

const localSource = (id = "qwen", total = 1500, tracking = true) => ({
  id: `provider:${id}`, label: id,
  snapshot: { status: "local", link: "https://qianwen.example/console", tracking,
    usage: { input: 1000, output: 200, total, cacheRead: 250, cacheWrite: 50, requests: 7, since: 1700000000000 } },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function rows(app) {
  const view = panel(app.render());
  return nodes(view.type(view.props)).filter((node) => node.props.source).map((node) => node.type(node.props));
}
function text(tree) { return nodes(tree).flatMap((node) => node.props.children.filter((child) => typeof child === "string")).join(" "); }
function resetButton(app) { return nodes(app.render()).find((node) => node.type === "button" && node.props.children.includes("reset")); }

test("local rows explicitly show consumed tokens, per-provider totals, full details and console links", async (t) => {
  for (const locale of ["zh", "en"]) {
    await t.test(locale, async (t) => {
      const app = client(t, { locale, sources: [localSource(), localSource("qwen-other", 900)] });
      app.mount();
      await flush();
      const [first, second] = rows(app);
      assert.match(text(first), locale === "zh" ? /本地已用 1.5K tokens/ : /Locally used 1.5K tokens/);
      assert.match(text(second), /900 tokens/);
      const detail = nodes(first).find((node) => node.props.className === "pq-localval");
      assert.ok(!nodes(first).some((node) => node.props.className === "pq-detail"));
      assert.doesNotMatch(text(first), /Credits|DSH|缓存|cache|Tracking since/);
      for (const fragment of locale === "zh" ? ["未缓存输入 1K", "输出 200", "缓存读取 250", "缓存写入 50", "7 次请求（收到 usage）", "统计起始", "2023", "非套餐真实剩余 Credits"] : ["uncached input 1K", "output 200", "cache read 250", "cache write 50", "7 requests with usage", "Tracking since", "2023", "not the plan's real remaining Credits"]) {
        assert.ok(detail.props.title.includes(fragment), fragment);
      }
      assert.match(detail.props.children[0], /1.5K tokens/);
      const link = nodes(first).find((node) => node.type === "a");
      assert.equal(link.props.href, "https://qianwen.example/console");
      assert.equal(link.props.target, "_blank");
      assert.equal(link.props.rel, "noreferrer");
      assert.ok(!nodes(first).some((node) => node.props.className === "pq-bar"));
      assert.equal(app.rpcCalls.length, 0);
    });
  }
});

test("paused tracking retains accumulated tokens and zero usage still has an explicit local label", async (t) => {
  const empty = localSource("empty", 0, false);
  empty.snapshot.usage = null;
  const app = client(t, { locale: "zh", sources: [localSource("paused", 1500, false), empty] });
  app.mount();
  await flush();
  const [paused, none] = rows(app);
  assert.match(text(paused), /本地已用 1.5K tokens · 统计已暂停/);
  assert.match(nodes(paused).find((node) => node.props.className === "pq-localval").props.title, /缓存写入 50/);
  assert.match(text(none), /本地已用 0 tokens · 统计已暂停/);
  const tooltip = nodes(none).find((node) => node.props.className === "pq-localval").props.title;
  assert.match(tooltip, /暂无 DSH 用量/);
  assert.match(tooltip, /非套餐真实剩余 Credits/);
  assert.doesNotMatch(text(none), /暂无 DSH 用量|Credits/);
});

test("all provider states share fixed row tracks and local usage is small gray text without an extra hint", async (t) => {
  const snapshots = [
    { status: "ok", remaining: "33%", usedPercent: 67, detail: "5h 0% · weekly 67%" },
    { status: "ok", remaining: "¥55.12" },
    { status: "loading" }, { status: "unsupported" }, { status: "error", error: "failed" },
  ];
  const app = client(t, { sources: [localSource(), ...snapshots.map((snapshot, i) => ({ id: String(i), label: "Provider", snapshot }))] });
  app.mount();
  await flush();
  const rendered = rows(app);
  assert.equal(rendered.length, 6);
  for (const row of rendered) {
    assert.ok(row.props.className.split(" ").includes("pq-row"));
    assert.equal(nodes(row).filter((node) => node.props.className === "pq-line").length, 1);
  }
  const localHeader = nodes(rendered[0]).find((node) => node.props.className === "pq-line");
  assert.ok(nodes(localHeader).some((node) => node.type === "a"));
  assert.ok(!nodes(localHeader).some((node) => node.props.className === "pq-localval"));
  const css = app.styles[0].textContent;
  assert.match(css, /\.pq-row\{[^}]*grid-template-rows:16px 3px 13px[^}]*height:48px[^}]*flex:0 0 48px/);
  assert.match(css, /\.pq-line\{grid-row:1;/);
  assert.match(css, /\.pq-bar\{grid-row:2;/);
  assert.match(css, /\.pq-detail\{grid-row:3;/);
  assert.match(css, /\.pq-localval\{grid-row:3;[^}]*font-size:10px;[^}]*color:var\(--dsw-alias-label-tertiary\)[^}]*text-overflow:ellipsis;white-space:nowrap/);
  assert.doesNotMatch(css, /\.pq-row-local[^}]*flex-wrap:wrap/);
});

test("cancelled reset neither sends a request nor announces success", async (t) => {
  const app = client(t, { sources: [], confirm: () => false });
  app.mount("settings.section");
  await flush();
  await resetButton(app).props.onClick();
  assert.deepEqual(app.confirmations, ["resetConfirm"]);
  assert.equal(app.requests.filter((r) => r.url.endsWith("/usage/reset")).length, 0);
  assert.equal(app.dispatched.length, 0);
  assert.ok(!nodes(app.render()).some((node) => node.props.className?.startsWith("pq-msg")));
});

test("reset is disabled while pending and repeated clicks issue only one request", async (t) => {
  const pending = deferred();
  const app = client(t, { sources: [], fetch: (url) => url.endsWith("/usage/reset") ? pending.promise : undefined });
  app.mount("settings.section");
  await flush();
  const button = resetButton(app);
  const request = button.props.onClick();
  await button.props.onClick();
  const busy = nodes(app.render()).find((node) => node.type === "button" && node.props.children.includes("resetting"));
  assert.equal(busy.props.disabled, true);
  assert.equal(busy.props["aria-busy"], true);
  await busy.props.onClick();
  assert.equal(app.confirmations.length, 1);
  assert.equal(app.requests.filter((r) => r.url.endsWith("/usage/reset")).length, 1);
  pending.resolve({ ok: true, json: async () => ({ ok: true }) });
  await request;
  assert.equal(resetButton(app).props.disabled, false);
  assert.deepEqual(app.dispatched, ["provider-quota:changed"]);
});

test("HTTP, API, JSON and network reset failures report failure without change events", async (t) => {
  const failures = {
    http: () => ({ ok: false, json: async () => ({ ok: true }) }),
    api: () => ({ ok: true, json: async () => ({ ok: false }) }),
    json: () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }),
    network: () => { throw new Error("offline"); },
  };
  for (const [name, failure] of Object.entries(failures)) {
    await t.test(name, async (t) => {
      const app = client(t, { sources: [], fetch: (url) => url.endsWith("/usage/reset") ? failure() : undefined });
      app.mount("settings.section");
      await flush();
      await resetButton(app).props.onClick();
      const message = nodes(app.render()).find((node) => node.props.className === "pq-msg pq-err");
      assert.equal(message.props.children[0], "resetFail");
      assert.equal(app.dispatched.length, 0);
      assert.equal(resetButton(app).props.disabled, false);
    });
  }
});

test("host local snapshots render before blocked subscription status and usage queries", async (t) => {
  for (const blocked of ["subscriptions-auth.status", "subscriptions-auth.usage"]) {
    await t.test(blocked, async (t) => {
      const pending = deferred();
      const subscription = { id: "sub", label: "Codex", snapshot: { status: "client-fetch", provider: "codex" } };
      const providers = { value: { providers: { codex: { accounts: [{ key: "account" }] } } } };
      const app = client(t, { sources: [localSource(), subscription], rpc: (_path, method) => method === blocked ? pending.promise : providers });
      app.mount();
      await flush();
      const view = panel(app.render());
      assert.equal(view.props.loading, false);
      assert.equal(view.props.sources[0].snapshot.usage.total, 1500);
      assert.equal(view.props.sources[1].snapshot.status, "client-fetch");
      pending.resolve(blocked.endsWith("status") ? providers : { ok: true, value: { supported: false } });
      await flush();
    });
  }
});

test("late subscription results cannot overwrite newer local totals or visibility", async (t) => {
  const pending = deferred();
  const subscription = { id: "sub", label: "Codex", snapshot: { status: "client-fetch", provider: "codex" } };
  const app = client(t, { sources: [localSource(), subscription], rpc: (_path, method) => method.endsWith("status")
    ? { value: { providers: { codex: { accounts: [{ key: "account" }] } } } } : pending.promise });
  app.mount();
  await flush();
  app.state.sources = [localSource("qwen", 0, false)];
  app.state.prefs.hidden = { sub: true };
  app.changed();
  await flush();
  assert.equal(panel(app.render()).props.sources.length, 1);
  pending.resolve({ ok: true, value: { supported: true, windows: [{ kind: "weekly", usedPercent: 90 }] } });
  await flush();
  const view = panel(app.render());
  assert.equal(view.props.sources.length, 1);
  assert.equal(view.props.sources[0].snapshot.usage.total, 0);
  assert.equal(view.props.sources[0].snapshot.tracking, false);
});

test("out-of-order host list responses cannot restore stale totals or refresh intervals", async (t) => {
  const pending = deferred();
  let lists = 0;
  const app = client(t, { sources: [localSource("qwen", 0, false)], refreshSeconds: 8,
    fetch: (url) => url.endsWith("/list") && ++lists === 1 ? pending.promise : undefined });
  app.mount();
  app.changed();
  await flush();
  pending.resolve({ ok: true, json: async () => ({ ok: true, value: { sources: [localSource()], prefs: { refreshSeconds: 99 } } }) });
  await flush();
  const view = panel(app.render());
  assert.equal(view.props.sources[0].snapshot.usage.total, 0);
  assert.equal(view.props.sources[0].snapshot.tracking, false);
  assert.equal([...app.intervals.values()][0].delay, 8000);
});

test("failed host refresh preserves already displayed local snapshots", async (t) => {
  let fail = false;
  const app = client(t, { sources: [localSource()], fetch: (url) => fail && url.endsWith("/list")
    ? { ok: false, json: async () => ({ ok: false }) } : undefined });
  app.mount();
  await flush();
  fail = true;
  app.changed();
  await flush();
  assert.equal(panel(app.render()).props.sources[0].snapshot.usage.total, 1500);
});

test("confirmed visibility takes effect before a follow-up list response, even if it fails", async (t) => {
  const stale = deferred();
  let calls = 0;
  const app = client(t, { sources: [localSource()], fetch: (url) => {
    if (!url.endsWith("/list")) return;
    if (++calls === 2) return stale.promise;
    if (calls >= 3) return { ok: false };
  } });
  app.mount();
  await flush();
  app.changed(); // Poll begins with the old visibility.
  await flush();
  app.changed({ ...app.state.prefs, hidden: { [app.state.sources[0].id]: true } });
  assert.equal(panel(app.render()).props.sources.length, 0);
  await flush();
  stale.resolve({ ok: true, json: async () => ({ ok: true, value: app.state }) });
  await flush();
  assert.equal(panel(app.render()).props.sources.length, 0);
  app.changed(app.state.prefs);
  assert.equal(panel(app.render()).props.sources.length, 1);
  await flush();
});

test("manual refresh renders the returned quota snapshot without depending on a second GET", async (t) => {
  const balance = (usedPercent) => ({ id: "quota", label: "Quota", snapshot: { status: "ok", usedPercent, remaining: `${100 - usedPercent}%` } });
  let lists = 0;
  const app = client(t, { sources: [balance(0)], fetch: (url, _init, state) => {
    if (url.endsWith("/list")) {
      if (++lists > 1) return { ok: false };
      return;
    }
    if (url.endsWith("/refresh")) return { ok: true, json: async () => ({ ok: true, value: { prefs: state.prefs, sources: [balance(75)] } }) };
  } });
  app.mount();
  await flush();
  await panel(app.render()).props.onRefresh();
  const view = panel(app.render());
  assert.equal(view.props.refreshFailed, false);
  assert.equal(view.props.sources[0].snapshot.remaining, "25%");
  const row = nodes(view.type(view.props)).find((node) => node.props.source);
  const fill = nodes(row.type(row.props)).find((node) => node.props.className === "pq-bar-fill pq-warn");
  assert.equal(fill.props.style.width, "75%");
  assert.match(app.styles[0].textContent, /\.pq-warn\{background:var\(--dsw-alias-state-warn-primary,/);
  assert.equal(lists, 1);
});

function itemSwitch(app, label) {
  const component = nodes(app.render()).find((node) => node.props.label === label);
  return nodes(component.type(component.props)).find((node) => node.props.role === "switch");
}

test("rapid visibility switches stay responsive and save only their own item in click order", async (t) => {
  const first = deferred();
  const patches = [];
  const sources = [{ id: "a", label: "A" }, { id: "constructor", label: "B" }];
  const app = client(t, { sources, fetch: async (url, init, state) => {
    if (!url.endsWith("/prefs") || init.method !== "POST") return;
    assert.equal(init.headers["content-type"], "application/json");
    const patch = JSON.parse(init.body);
    patches.push(patch);
    if (patches.length === 1) await first.promise;
    const { id, visible } = patch.visibility;
    const hidden = { ...state.prefs.hidden, [id]: true };
    if (visible) delete hidden[id];
    state.prefs = { ...state.prefs, hidden };
    return { ok: true, json: async () => ({ ok: true, value: state.prefs }) };
  } });
  app.mount("settings.section");
  await flush();
  assert.equal(itemSwitch(app, "B").props.checked, true);
  itemSwitch(app, "A").props.onChange({ target: { checked: false } });
  itemSwitch(app, "B").props.onChange({ target: { checked: false } });
  assert.equal(itemSwitch(app, "A").props.checked, false);
  assert.equal(itemSwitch(app, "B").props.checked, false);
  itemSwitch(app, "A").props.onChange({ target: { checked: true } });
  await flush();
  assert.equal(patches.length, 1);
  assert.equal(itemSwitch(app, "A").props.checked, true);
  first.resolve();
  await flush();
  assert.deepEqual(patches, [
    { visibility: { id: "a", visible: false } }, { visibility: { id: "constructor", visible: false } },
    { visibility: { id: "a", visible: true } },
  ]);
  assert.deepEqual(app.state.prefs.hidden, { constructor: true });
  assert.equal(app.dispatched.length, 3);
});

test("a failed visibility save rolls back only that item and later success does not hide its error", async (t) => {
  const first = deferred();
  const app = client(t, { sources: [{ id: "a", label: "A" }, { id: "b", label: "B" }], fetch: async (url, init, state) => {
    if (!url.endsWith("/prefs") || init.method !== "POST") return;
    if (JSON.parse(init.body).visibility.id === "a") return first.promise;
    state.prefs = { ...state.prefs, hidden: { b: true } };
    return { ok: true, json: async () => ({ ok: true, value: state.prefs }) };
  } });
  app.mount("settings.section");
  await flush();
  itemSwitch(app, "A").props.onChange({ target: { checked: false } });
  itemSwitch(app, "B").props.onChange({ target: { checked: false } });
  first.resolve({ ok: false, json: async () => ({ ok: true, value: { hidden: { a: true } } }) });
  await flush();
  assert.equal(itemSwitch(app, "A").props.checked, true);
  assert.equal(itemSwitch(app, "B").props.checked, false);
  const row = nodes(app.render()).find((node) => node.props.className === "pq-set-row"
    && node.props.children.some((child) => child?.props?.label === "A"));
  assert.equal(nodes(row).find((node) => node.props.role === "alert").props.children[0], "saveFail");
  assert.deepEqual(app.dispatched, ["provider-quota:changed"]);
});

test("settings can retry a failed list load instead of remaining on the spinner", async (t) => {
  let ok = false;
  const app = client(t, { fetch: (url) => !ok && url.endsWith("/list") ? { ok: false, json: async () => ({ ok: false }) } : undefined });
  app.mount("settings.section");
  await flush();
  ok = true;
  nodes(app.render()).find((node) => node.type === "button" && node.props.children[0] === "refresh").props.onClick();
  app.render();
  await flush();
  assert.equal(itemSwitch(app, "Codex").props.checked, true);
});
