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
    dispatchEvent(event) { for (const handler of events.get(event.type) ?? []) handler(event); },
  };
  const document = {
    querySelector() { return null; },
    createElement() { const tag = { dataset: {}, remove() { styles.splice(styles.indexOf(tag), 1); } }; return tag; },
    head: { appendChild(tag) { styles.push(tag); } },
  };
  runInNewContext(source, {
    window, document,
    CustomEvent: class { constructor(type) { this.type = type; } },
    setInterval(callback, delay) { const id = {}; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = {}; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      assert.ok(["/api/provider-quota/list", "/api/provider-quota/prefs", "/api/provider-quota/refresh", "/api/provider-quota/usage/reset"].includes(url));
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
    locale: { register: () => () => {}, bind: () => (key) => key },
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
  return { definition, plugin, slots, mount, render, intervals, requests, rpcCalls, state, styles };
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
});
