// Host half of @keyboard-dog/dsh-provider-quota.
//
// Provides the `providerQuota` registry service, aggregates the remaining
// quota of DSH-configured model providers, bridges the quota endpoints of the
// installed factory / subscriptions provider plugins, and serves the result to
// the Client widget over loopback HTTP routes.
//
// Removal safety: every quota source is installed as a Cordis effect on the
// context that owns it. A plugin that registers a source owns that effect, so
// unloading the plugin disposes the effect and the source disappears from the
// registry (and therefore from the widget) without any error. The factory and
// subscriptions bridges are owned by this plugin but reconciled against the
// live LLM adapter registry, so removing either provider plugin drops its rows
// on the next sync.
//
// This file intentionally imports nothing from @deepseek-ai/*: a profile bundle
// is linked from the workspace and cannot resolve the harness's own packages.
// The caller-context binding that makes register() auto-clean is enabled with
// the global `cordis.tracker` symbol instead of extending cordis's Service.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "provider-quota";
export const inject = ["webServer", "llm"];

const ROUTE_PREFIX = "/api/provider-quota";
const FACTORY_BASE_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/dsh-factory-provider\//;
const SUBSCRIPTION_PROVIDERS = new Set(["codex", "claude", "grok", "copilot", "antigravity"]);
const FETCH_TIMEOUT_MS = 15000;
// Qwen "Token Plan" (千问AI平台) exposes no API-key balance endpoint; remaining
// Credits are only visible in the console. Verified against the official docs
// and the inference gateway (which routes every non-inference path to 404/model).
const QWEN_CONSOLE_URL = "https://platform.qianwenai.com/home/analytics/token-plan/individual";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function replyJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = text.length ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

function fmtMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency ?? ""} `;
  return `${symbol}${n.toFixed(2)}`;
}

function fmtReset(resetsAt) {
  if (typeof resetsAt !== "number" || !(resetsAt > Date.now())) return null;
  const minutes = Math.round((resetsAt - Date.now()) / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function windowsToView(windows) {
  const usable = (windows ?? []).filter((w) => w && Number.isFinite(Number(w.usedPercent)));
  if (usable.length === 0) return { status: "unsupported", detail: "no usage window" };
  const primary = usable.find((w) => w.label === "weekly") ?? usable[0];
  const used = Math.min(100, Math.max(0, Number(primary.usedPercent)));
  const parts = usable.map((w) => `${w.label} ${Math.round(Number(w.usedPercent))}%`);
  const reset = fmtReset(primary.resetsAt);
  return {
    status: "ok",
    remaining: `${Math.round(100 - used)}%`,
    usedPercent: used,
    detail: parts.join(" · ") + (reset ? ` · ↻${reset}` : ""),
  };
}

function errorView(message) {
  return { status: "error", error: String(message ?? "error") };
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const defaults = {
    refreshSeconds: 60,
    queryProviders: true,
    bridgeFactory: true,
    bridgeSubscriptions: true,
    trackUsage: true,
    hidden: {},
    ...(config ?? {}),
  };

  // -- persisted preferences ------------------------------------------------
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const prefsDir = join(dshHome, "plugins", "provider-quota");
  const prefsPath = join(prefsDir, "prefs.json");
  let prefs = { ...defaults };
  try {
    if (existsSync(prefsPath)) {
      const stored = JSON.parse(readFileSync(prefsPath, "utf8"));
      prefs = { ...defaults, ...stored, hidden: { ...(stored.hidden ?? {}) } };
    }
  } catch { /* corrupted prefs fall back to defaults */ }

  function savePrefs() {
    try {
      mkdirSync(prefsDir, { recursive: true });
      writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), "utf8");
    } catch (error) {
      ctx.logger?.warn?.(`provider-quota: failed to persist prefs: ${error?.message ?? error}`);
    }
  }

  // -- local usage tracking (tokens consumed through DSH) ------------------
  // Qwen Token Plan has no API-key balance endpoint, so we accumulate the
  // per-request `usage` reported by the model stream. This counts only DSH
  // traffic, not the plan's real remaining Credits.
  const usagePath = join(prefsDir, "usage.json");
  let usage = {}; // provider -> { input, output, total, cacheRead, cacheWrite, requests, since }
  try { if (existsSync(usagePath)) usage = JSON.parse(readFileSync(usagePath, "utf8")) ?? {}; } catch { usage = {}; }
  let usageDirty = false;

  function isQwenProvider(p) { return /qwen|token-plan|qianwen/i.test(String(p ?? "")); }

  function recordUsage(provider, u) {
    if (!prefs.trackUsage || !u) return;
    const cur = usage[provider] ?? { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, requests: 0, since: Date.now() };
    const input = Number(u.inputTokens ?? 0);
    const output = Number(u.outputTokens ?? 0);
    cur.input += Number.isFinite(input) ? input : 0;
    cur.output += Number.isFinite(output) ? output : 0;
    const total = Number(u.totalTokens ?? input + output);
    cur.total += Number.isFinite(total) ? total : 0;
    cur.cacheRead += Number(u.cacheReadTokens ?? 0) || 0;
    cur.cacheWrite += Number(u.cacheWriteTokens ?? 0) || 0;
    cur.requests += 1;
    usage[provider] = cur;
    usageDirty = true;
  }

  function persistUsage() {
    if (!usageDirty) return;
    usageDirty = false;
    try { mkdirSync(prefsDir, { recursive: true }); writeFileSync(usagePath, JSON.stringify(usage), "utf8"); } catch { /* non-fatal */ }
  }

  function qwenUsage() {
    const agg = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, requests: 0, since: null };
    for (const [p, u] of Object.entries(usage)) {
      if (!isQwenProvider(p)) continue;
      agg.input += u.input ?? 0; agg.output += u.output ?? 0; agg.total += u.total ?? 0;
      agg.cacheRead += u.cacheRead ?? 0; agg.cacheWrite += u.cacheWrite ?? 0; agg.requests += u.requests ?? 0;
      if (u.since && (agg.since === null || u.since < agg.since)) agg.since = u.since;
    }
    return agg.requests > 0 ? agg : null;
  }

  const ownerCtx = ctx;
  const sources = new Map(); // id -> { id, label, order, fetch, snapshot }
  let updatedAt = 0;
  let refreshing = false;

  // -- registry internals ---------------------------------------------------

  function add(source) { sources.set(source.id, source); updatedAt = Date.now(); }
  function remove(id) { if (sources.delete(id)) updatedAt = Date.now(); }
  function install(source, scopeCtx) {
    if (!source || typeof source.id !== "string" || typeof source.fetch !== "function") {
      throw new Error("providerQuota.register: source needs an id and a fetch()");
    }
    const id = source.id;
    return scopeCtx.effect(() => {
      add({ ...source, snapshot: sources.get(id)?.snapshot ?? { status: "loading" } });
      void fetchInto(sources.get(id));
      return () => remove(id);
    }, `provider-quota: source ${id}`);
  }
  async function fetchInto(source) {
    if (!source) return;
    const controller = new AbortController();
    try {
      const view = await source.fetch(controller.signal);
      source.snapshot = { ...(view ?? errorView("empty result")), updatedAt: Date.now() };
    } catch (error) {
      source.snapshot = { ...errorView(error instanceof Error ? error.message : String(error)), updatedAt: Date.now() };
    } finally {
      updatedAt = Date.now();
    }
  }
  function list() {
    return [...sources.values()]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.label).localeCompare(String(b.label)))
      .map((s) => ({ id: s.id, label: s.label, order: s.order ?? 0, snapshot: s.snapshot ?? { status: "loading" } }));
  }
  async function refresh(id) {
    const targets = id === undefined ? [...sources.values()] : [sources.get(id)].filter(Boolean);
    await Promise.all(targets.map((s) => fetchInto(s)));
    updatedAt = Date.now();
    return list();
  }
  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try { await refresh(); } finally { refreshing = false; }
  }

  // -- public service -------------------------------------------------------
  const registry = {
    register(source) {
      const scopeCtx = (this && this.ctx) || ownerCtx;
      return install(source, scopeCtx);
    },
    list,
    refresh,
    refreshAll,
  };
  Object.defineProperty(registry, Symbol.for("cordis.tracker"), {
    value: { property: "ctx", noShadow: true },
  });
  ctx.provide("providerQuota", registry);

  ctx.effect(() => () => { sources.clear(); updatedAt = Date.now(); }, "provider-quota: registry lifetime");

  // -- owned-source reconciliation -----------------------------------------

  function providerInfos() {
    const llm = ctx.get("llm");
    if (!llm || typeof llm.listProviders !== "function") return [];
    const raw = llm.listProviders() ?? [];
    return raw.map((p) => {
      if (typeof p === "string") return { id: p, name: p };
      const id = p?.id ?? p?.provider ?? p?.route ?? p?.name ?? "";
      return { id, name: p?.name ?? id };
    }).filter((p) => typeof p.id === "string" && p.id.length > 0);
  }

  function piAiProviders() {
    try {
      const editor = ctx.get("configEditor");
      if (!editor || typeof editor.configuration !== "function") return {};
      const rows = editor.configuration();
      const row = rows.find((r) => r?.entry?.options?.id === "llm-pi-ai" || r?.entry?.options?.name === "@deepseek-ai/dsh-llm-pi-ai");
      const conf = row ? { ...(row.inherited ?? {}), ...(row.override ?? {}) } : {};
      return conf?.providers ?? {};
    } catch { return {}; }
  }

  function subscriptionLabel(base) {
    return { codex: "ChatGPT (Codex)", claude: "Claude", grok: "Grok", copilot: "GitHub Copilot", antigravity: "Google Antigravity" }[base] ?? base;
  }

  async function syncSources() {
    const desired = new Map();
    let providers = [];
    try { providers = providerInfos(); } catch { providers = []; }
    const piAi = piAiProviders();

    const factoryPresent = providers.some((p) => /^factory/i.test(p.id))
      || Object.values(piAi).some((p) => FACTORY_BASE_RE.test(String(p?.baseURL ?? "")));
    if (prefs.bridgeFactory && factoryPresent) {
      desired.set("plugin:factory", { id: "plugin:factory", label: "Factory (Droid)", order: -20, fetch: fetchFactoryQuota });
    }

    if (prefs.bridgeSubscriptions) {
      for (const p of providers) {
        const base = p.id.split("/")[0].toLowerCase();
        if (SUBSCRIPTION_PROVIDERS.has(base)) {
          desired.set(`plugin:subscriptions:${base}`, {
            id: `plugin:subscriptions:${base}`, label: subscriptionLabel(base), order: -10,
            fetch: () => fetchSubscriptionUsage(base),
          });
        }
      }
    }

    if (prefs.queryProviders) {
      for (const [name, conf] of Object.entries(piAi)) {
        if (FACTORY_BASE_RE.test(String(conf?.baseURL ?? ""))) continue;
        if (SUBSCRIPTION_PROVIDERS.has(name.split("/")[0].toLowerCase())) continue;
        desired.set(`provider:${name}`, {
          id: `provider:${name}`, label: conf?.displayName || name, order: 0,
          fetch: () => fetchProviderBalance(name, conf),
        });
      }
      for (const p of providers) {
        const base = p.id.split("/")[0].toLowerCase();
        if (SUBSCRIPTION_PROVIDERS.has(base) || /^factory/i.test(p.id) || piAi[p.id]) continue;
        if (/deepseek/i.test(p.id)) {
          const isAccount = /account/i.test(p.id);
          desired.set(`provider:${p.id}`, {
            id: `provider:${p.id}`, label: p.name || p.id, order: 0,
            fetch: isAccount
              ? () => fetchAccountBalance()
              : () => fetchProviderBalance(p.id, { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" }),
          });
        }
      }
    }

    for (const [id, source] of desired) if (!sources.has(id)) install(source, ownerCtx);
    for (const id of [...sources.keys()]) {
      if ((id.startsWith("provider:") || id.startsWith("plugin:")) && !desired.has(id)) remove(id);
    }
  }

  // -- quota fetchers -------------------------------------------------------

  async function fetchFactoryQuota() {
    const origin = ctx.get("webServer")?.getOrigin?.();
    if (!origin) return errorView("no web origin");
    const { ok, data, status } = await fetchJson(`${origin}/api/dsh-factory-provider/quota`);
    if (status === 404) return { status: "unsupported", detail: "factory plugin removed" };
    if (!ok || !data) return errorView(`factory quota HTTP ${status}`);
    if (data.ok === false) return errorView(data.message ?? data.code ?? "factory quota error");
    const v = data.value ?? {};
    const std = v.standard ?? {};
    const windows = [];
    const push = (label, w) => { if (w) windows.push({ label, usedPercent: w.usedPercent, resetsAt: w.windowEnd ? Date.parse(w.windowEnd) : undefined }); };
    push("5h", std.fiveHour); push("weekly", std.weekly); push("monthly", std.monthly);
    const view = windowsToView(windows);
    if (view.status === "ok" && Number(v.extraUsageBalanceCents) > 0) {
      view.detail = `${view.detail ?? ""} · +$${(Number(v.extraUsageBalanceCents) / 100).toFixed(2)}`;
    }
    return view;
  }

  // Subscriptions usage lives on the authenticated /api RPC channel, which only
  // the browser's admitted connection can call; the Client resolves these.
  async function fetchSubscriptionUsage(provider) {
    return { status: "client-fetch", provider };
  }

  async function fetchProviderBalance(name, conf) {
    const baseURL = String(conf?.baseURL ?? "");
    // Qwen Token Plan: no public API-key balance endpoint. Show locally-tracked
    // DSH token usage plus a link to the console for the real remaining Credits.
    if (/qianwenaiapi|token-plan|qwen/i.test(baseURL) || isQwenProvider(name)) {
      return { status: "local", link: QWEN_CONSOLE_URL, usage: qwenUsage() };
    }
    if (!/deepseek/i.test(baseURL) && !/deepseek/i.test(name)) {
      return { status: "unsupported", detail: "no balance API" };
    }
    const key = await resolveApiKey(conf);
    if (!key) return { status: "unsupported", detail: "no API key configured" };
    const root = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
    const { ok, data, status } = await fetchJson(`${root}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    if (!ok || !data) return errorView(`balance HTTP ${status}`);
    const infos = data.balance_infos ?? [];
    if (!Array.isArray(infos) || infos.length === 0) return errorView("no balance info");
    const total = infos.reduce((sum, b) => sum + Number(b.total_balance ?? 0), 0);
    const currency = infos[0]?.currency ?? "CNY";
    return { status: "ok", remaining: fmtMoney(total, currency), usedPercent: null, detail: data.is_available === false ? "unavailable" : null };
  }

  async function fetchAccountBalance() {
    const account = ctx.get("deepseekAccount");
    if (!account || typeof account.getBalance !== "function") {
      return { status: "unsupported", detail: "account service unavailable" };
    }
    try {
      const client = { version: "0.2.2", locale: "zh", timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
      const balance = await account.getBalance(client);
      if (!balance) return { status: "unsupported", detail: "not signed in" };
      const wallets = [...(balance.value ?? []), ...(balance.bonusWallets ?? [])];
      let total = 0;
      let currency = "CNY";
      for (const w of wallets) {
        const amount = Number(w?.amount ?? w?.balance ?? 0);
        if (Number.isFinite(amount)) total += amount;
        if (w?.currency) currency = w.currency;
      }
      if (wallets.length === 0) return { status: "unsupported", detail: "no wallet data" };
      return { status: "ok", remaining: fmtMoney(total, currency), usedPercent: null, detail: null };
    } catch {
      return { status: "unsupported", detail: "account balance unavailable" };
    }
  }

  async function resolveApiKey(conf) {
    const envName = conf?.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials && typeof credentials.resolve === "function" && typeof envName === "string") {
      try {
        const hit = await credentials.resolve(envName);
        if (hit?.value) return hit.value;
      } catch { /* fall through to environment */ }
    }
    if (typeof envName === "string" && process.env[envName]) return process.env[envName];
    return undefined;
  }

  // -- refresh loop (restartable so the interval is live-editable) ---------
  let loopTimer = null;
  function startLoop() {
    if (loopTimer) clearInterval(loopTimer);
    const ms = Math.max(5, Number(prefs.refreshSeconds) || 60) * 1000;
    loopTimer = setInterval(() => { persistUsage(); void syncSources().then(() => refreshAll()); }, ms);
  }
  ctx.effect(() => {
    void syncSources().then(() => refreshAll());
    startLoop();
    const off = ctx.on("llm/adapters-updated", () => { void syncSources(); });
    return () => { if (loopTimer) clearInterval(loopTimer); off(); persistUsage(); };
  }, "provider-quota: refresh loop");

  // -- observe per-request token usage on the LLM stream -------------------
  // Around-waterfall: yield every chunk unchanged, only tallying the `usage`
  // chunk for Qwen routes. Non-Qwen streams pass through untouched.
  ctx.effect(() => {
    const off = ctx.on("llm/stream", (options, next) => {
      const stream = next();
      const provider = options?.provider;
      if (!isQwenProvider(provider)) return stream;
      return (async function* () {
        for await (const chunk of stream) {
          if (chunk && chunk.type === "usage" && chunk.usage) recordUsage(provider, chunk.usage);
          yield chunk;
        }
      })();
    });
    return () => off();
  }, "provider-quota: usage observer");

  // -- HTTP routes for the Client ------------------------------------------
  const webServer = ctx.get("webServer");
  if (webServer) {
    const guarded = (handler) => (req, res) => {
      // These raw routes do not inherit DSH RPC admission. Restrict them to
      // the local GUI origin; reject cross-site writes and DNS-rebinding hosts.
      let origin;
      try { origin = new URL(webServer.getOrigin()); } catch { /* fail closed */ }
      const headers = req.headers ?? {};
      const sameOrigin = origin && headers.origin === origin.origin;
      const trusted = isLoopback(req) && origin && headers.host === origin.host
        && (!headers.origin || sameOrigin)
        && (!headers["sec-fetch-site"] || ["same-origin", "none"].includes(headers["sec-fetch-site"]));
      if (!trusted || (req.method === "POST" && !sameOrigin)) {
        replyJson(res, 403, { ok: false, error: { message: "local same-origin requests only" } }); return;
      }
      if (req.method === "POST" && String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
        replyJson(res, 415, { ok: false, error: { message: "application/json required" } }); return;
      }
      return handler(req, res);
    };
    const readBody = (req) => new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve(null); } });
      req.on("error", () => resolve(null));
    });
    const routes = [
      {
        kind: "exact", path: `${ROUTE_PREFIX}/list`,
        handler: guarded((req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") { replyJson(res, 405, { ok: false, error: { message: "GET only" } }); return; }
          replyJson(res, 200, { ok: true, value: { sources: list(), updatedAt, prefs } });
        }),
      },
      {
        kind: "exact", path: `${ROUTE_PREFIX}/refresh`,
        handler: guarded(async (req, res) => {
          if (req.method !== "POST") { replyJson(res, 405, { ok: false, error: { message: "POST only" } }); return; }
          await syncSources();
          await refreshAll();
          replyJson(res, 200, { ok: true, value: { sources: list(), updatedAt, prefs } });
        }),
      },
      {
        kind: "exact", path: `${ROUTE_PREFIX}/prefs`,
        handler: guarded(async (req, res) => {
          if (req.method === "GET") { replyJson(res, 200, { ok: true, value: prefs }); return; }
          if (req.method !== "POST") { replyJson(res, 405, { ok: false, error: { message: "GET/POST only" } }); return; }
          const body = await readBody(req);
          if (!body || typeof body !== "object") { replyJson(res, 400, { ok: false, error: { message: "invalid prefs body" } }); return; }
          if (body.refreshSeconds !== undefined) prefs.refreshSeconds = Math.min(3600, Math.max(5, Number(body.refreshSeconds) || 60));
          if (typeof body.bridgeFactory === "boolean") prefs.bridgeFactory = body.bridgeFactory;
          if (typeof body.bridgeSubscriptions === "boolean") prefs.bridgeSubscriptions = body.bridgeSubscriptions;
          if (typeof body.queryProviders === "boolean") prefs.queryProviders = body.queryProviders;
          if (typeof body.trackUsage === "boolean") prefs.trackUsage = body.trackUsage;
          if (body.hidden && typeof body.hidden === "object") prefs.hidden = { ...body.hidden };
          savePrefs();
          startLoop();
          await syncSources();
          replyJson(res, 200, { ok: true, value: prefs });
        }),
      },
      {
        kind: "exact", path: `${ROUTE_PREFIX}/usage/reset`,
        handler: guarded(async (req, res) => {
          if (req.method !== "POST") { replyJson(res, 405, { ok: false, error: { message: "POST only" } }); return; }
          usage = {};
          usageDirty = true;
          persistUsage();
          await refreshAll();
          replyJson(res, 200, { ok: true });
        }),
      },
    ];
    ctx.effect(() => {
      const disposers = routes.map((r) => webServer.register(r)).filter((d) => typeof d === "function");
      return () => { for (const d of disposers) { try { d(); } catch {} } };
    }, "provider-quota: http routes");
  }
}