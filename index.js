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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "provider-quota";
export const inject = ["webServer", "llm", "connection"];

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

function replyJson(status, value) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function apiError(status, message) {
  return replyJson(status, { ok: false, error: { message } });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request.body ?? []) {
      size += chunk.byteLength;
      if (size > 1e6) return null;
      chunks.push(chunk);
    }
    return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch { return null; }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = text.length ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, data };
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

  function savePrefs(next) {
    try {
      mkdirSync(prefsDir, { recursive: true });
      const temporaryPath = join(prefsDir, `prefs.${process.pid}.tmp`);
      writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, prefsPath);
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`provider-quota: failed to persist prefs: ${error?.message ?? error}`);
      return false;
    }
  }

  // -- local usage tracking (tokens consumed through DSH) ------------------
  // Qwen Token Plan has no API-key balance endpoint, so we accumulate the
  // per-request `usage` reported by the model stream. This counts only DSH
  // traffic, not the plan's real remaining Credits.
  const usagePath = join(prefsDir, "usage.json");
  let usage = Object.create(null); // provider -> numeric counters; never prompt/output text
  const counterKeys = ["input", "output", "total", "cacheRead", "cacheWrite", "requests"];
  const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
  const addCount = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
  try {
    const stored = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : null;
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [provider, value] of Object.entries(stored)) {
        if (!value || typeof value !== "object" || !count(value.requests)) continue;
        usage[provider] = Object.fromEntries(counterKeys.map((key) => [key, count(value[key])]));
        usage[provider].since = count(value.since) || null;
      }
    }
  } catch { /* invalid data is never fed into counters */ }
  let usageDirty = false;
  let usageEpoch = 0; // Reset/toggle invalidates already-running streams.
  let disposed = false;

  function isQwenProvider(provider, conf = piAiProviders()[provider]) {
    if (typeof provider !== "string" || !provider) return false;
    if (/qwen|token-plan|qianwen/i.test(provider)) return true;
    try {
      const host = new URL(conf?.baseURL).hostname;
      return /(^|\.)(qianwenaiapi\.com|dashscope\.aliyuncs\.com)$/.test(host);
    } catch { return false; }
  }

  function normalizeUsage(u) {
    if (!u || typeof u !== "object") return null;
    const keys = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"];
    if (!keys.some((key) => typeof u[key] === "number" && Number.isFinite(u[key]) && u[key] >= 0)) return null;
    const input = count(u.inputTokens), output = count(u.outputTokens);
    const cacheRead = count(u.cacheReadTokens), cacheWrite = count(u.cacheWriteTokens);
    return {
      input, output, cacheRead, cacheWrite,
      total: typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens >= 0
        ? count(u.totalTokens) : addCount(addCount(input, output), addCount(cacheRead, cacheWrite)),
    };
  }

  function recordUsage(provider, u) {
    if (disposed || !prefs.trackUsage || !u) return;
    const cur = usage[provider] ?? { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, requests: 0, since: Date.now() };
    for (const key of counterKeys) cur[key] = addCount(cur[key], key === "requests" ? 1 : u[key]);
    usage[provider] = cur;
    usageDirty = true;
    updatedAt = Date.now();
    persistUsage();
  }

  function persistUsage() {
    if (!usageDirty) return true;
    try {
      mkdirSync(prefsDir, { recursive: true });
      // Both absolute targets are fixed children of the plugin's data directory.
      const temporaryPath = join(prefsDir, "usage.json.tmp");
      writeFileSync(temporaryPath, JSON.stringify(usage), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, usagePath);
      usageDirty = false;
      return true;
    } catch {
      ctx.logger?.warn?.("provider-quota: failed to persist local usage; will retry");
      return false; // Keep dirty data for the next refresh/disposal retry.
    }
  }

  function localView(provider) {
    return {
      status: "local", link: QWEN_CONSOLE_URL, tracking: !!prefs.trackUsage,
      usage: usage[provider] ? { ...usage[provider] } : null,
    };
  }

  const ownerCtx = ctx;
  const sources = new Map(); // id -> { id, label, order, fetch, snapshot }
  let updatedAt = 0;
  const inFlight = new WeakMap(); // one shared refresh per installed source

  // -- registry internals ---------------------------------------------------

  function remove(id) {
    const source = sources.get(id);
    if (!source) return;
    sources.delete(id);
    inFlight.get(source)?.controller.abort();
    updatedAt = Date.now();
  }
  function install(source, scopeCtx) {
    if (!source || typeof source.id !== "string" || typeof source.fetch !== "function") {
      throw new Error("providerQuota.register: source needs an id and a fetch()");
    }
    const id = source.id;
    return scopeCtx.effect(() => {
      const snapshot = sources.get(id)?.snapshot ?? { status: "loading" };
      remove(id);
      const installed = { ...source, snapshot };
      sources.set(id, installed);
      updatedAt = Date.now();
      void fetchInto(installed);
      return () => { if (sources.get(id) === installed) remove(id); };
    }, `provider-quota: source ${id}`);
  }
  function fetchInto(source) {
    const ongoing = inFlight.get(source);
    if (ongoing) return ongoing.promise;
    const controller = new AbortController();
    const { signal } = controller;
    const timedOut = new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const timer = setTimeout(() => controller.abort(new Error("quota query timed out")), FETCH_TIMEOUT_MS);
    const promise = Promise.race([timedOut, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return source.fetch(signal);
    })]).then(
      (view) => view ?? errorView("empty result"),
      (error) => errorView(error instanceof Error ? error.message : String(error)),
    ).then((view) => {
      if (sources.get(source.id) !== source) return;
      updatedAt = Date.now();
      source.snapshot = view.status === "error" && source.snapshot.status === "ok"
        ? { ...source.snapshot, stale: true, error: view.error }
        : { ...view, updatedAt };
    }).finally(() => {
      clearTimeout(timer);
      inFlight.delete(source);
    });
    inFlight.set(source, { controller, promise });
    return promise;
  }
  function list() {
    return [...sources.values()]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.label).localeCompare(String(b.label)))
      .map((s) => ({
        id: s.id, label: s.label, order: s.order ?? 0,
        snapshot: s.localProvider ? { ...localView(s.localProvider), updatedAt } : s.snapshot ?? { status: "loading" },
      }));
  }
  async function refresh(id) {
    const targets = id === undefined ? [...sources.values()] : [sources.get(id)].filter(Boolean);
    await Promise.all(targets.map((s) => fetchInto(s)));
    updatedAt = Date.now();
    return list();
  }
  async function refreshAll() {
    await refresh();
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

  ctx.effect(() => () => { for (const id of sources.keys()) remove(id); }, "provider-quota: registry lifetime");

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
          localProvider: isQwenProvider(name, conf) ? name : undefined,
          fetch: (signal) => fetchProviderBalance(name, conf, signal),
        });
      }
      for (const p of providers) {
        const base = p.id.split("/")[0].toLowerCase();
        if (SUBSCRIPTION_PROVIDERS.has(base) || /^factory/i.test(p.id) || piAi[p.id]) continue;
        if (isQwenProvider(p.id)) {
          desired.set(`provider:${p.id}`, {
            id: `provider:${p.id}`, label: p.name || p.id, order: 0,
            localProvider: p.id, fetch: () => localView(p.id),
          });
        } else if (/deepseek/i.test(p.id)) {
          const isAccount = /account/i.test(p.id);
          desired.set(`provider:${p.id}`, {
            id: `provider:${p.id}`, label: p.name || p.id, order: 0,
            fetch: isAccount
              ? () => fetchAccountBalance()
              : (signal) => fetchProviderBalance(p.id, { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" }, signal),
          });
        }
      }
    }

    for (const [id, source] of desired) {
      if (!sources.has(id)) install(source, ownerCtx);
      else Object.assign(sources.get(id), source); // Do not retain stale provider configuration.
    }
    for (const id of [...sources.keys()]) {
      if ((id.startsWith("provider:") || id.startsWith("plugin:")) && !desired.has(id)) remove(id);
    }
  }

  // -- quota fetchers -------------------------------------------------------

  async function fetchFactoryQuota(signal) {
    const origin = ctx.get("webServer")?.getOrigin?.();
    if (!origin) return errorView("no web origin");
    const { ok, data, status } = await fetchJson(`${origin}/api/dsh-factory-provider/quota`, { signal });
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

  async function fetchProviderBalance(name, conf, signal) {
    const baseURL = String(conf?.baseURL ?? "");
    // Qwen Token Plan: no public API-key balance endpoint. Show locally-tracked
    // DSH token usage plus a link to the console for the real remaining Credits.
    if (isQwenProvider(name, conf)) return localView(name);
    if (!/deepseek/i.test(baseURL) && !/deepseek/i.test(name)) {
      return { status: "unsupported", detail: "no balance API" };
    }
    const key = await resolveApiKey(conf);
    signal.throwIfAborted();
    if (!key) return { status: "unsupported", detail: "no API key configured" };
    const root = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
    const { ok, data, status } = await fetchJson(`${root}/user/balance`, {
      signal,
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
      if (!prefs.trackUsage || disposed || !isQwenProvider(provider)) return stream;
      const epoch = usageEpoch;
      return (async function* () {
        let latest = null;
        try {
          for await (const chunk of stream) {
            // Usage is a cumulative snapshot, not a delta. Keep the last valid
            // report; finalize once even on cancellation or an upstream error.
            if (chunk?.type === "usage") latest = normalizeUsage(chunk.usage) ?? latest;
            yield chunk;
          }
        } finally {
          if (epoch === usageEpoch) recordUsage(provider, latest);
        }
      })();
    });
    return () => { disposed = true; usageEpoch++; off(); persistUsage(); };
  }, "provider-quota: usage observer");

  // Use Connection's owner-only Fetch routes. Electron's dsh-app bridge
  // forwards the authenticated Cookie but strips Origin and Sec-Fetch-Site.
  // Browser admission stays with DSH; never allow anonymous origin-less writes.
  const connection = ctx.get("connection");
  const snapshot = () => ({ sources: list(), updatedAt, prefs });
  function route(path, methods, handler) {
    connection.fetch.register({
      path: `${ROUTE_PREFIX}${path}`, methods, requestBody: "buffered",
      async fetch(request) {
        if (request.method === "POST" && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
          return apiError(415, "application/json required");
        }
        return handler(request);
      },
    }); // Connection binds the registration's lifetime to this plugin fiber.
  }
  route("/list", ["GET", "HEAD"], (request) => request.method === "HEAD"
    ? new Response(null, { headers: { "cache-control": "no-store" } })
    : replyJson(200, { ok: true, value: snapshot() }));
  route("/refresh", ["POST"], async () => {
    await syncSources();
    await refreshAll();
    return replyJson(200, { ok: true, value: snapshot() });
  });
  route("/prefs", ["GET", "POST"], async (request) => {
    if (request.method === "GET") return replyJson(200, { ok: true, value: prefs });
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "invalid prefs body");
    const next = { ...prefs };
    if (body.refreshSeconds !== undefined) next.refreshSeconds = Math.min(3600, Math.max(5, Number(body.refreshSeconds) || 60));
    for (const key of ["bridgeFactory", "bridgeSubscriptions", "queryProviders", "trackUsage"]) {
      if (typeof body[key] === "boolean") next[key] = body[key];
    }
    // Older clients replace the whole map. A switch changes just its id,
    // so concurrent pages cannot overwrite another item's visibility.
    if (body.hidden && typeof body.hidden === "object" && !Array.isArray(body.hidden)) next.hidden = { ...body.hidden };
    if (body.visibility !== undefined) {
      const { id, visible } = body.visibility ?? {};
      if (typeof id !== "string" || typeof visible !== "boolean" || body.hidden !== undefined) return apiError(400, "invalid visibility patch");
      next.hidden = { ...prefs.hidden, [id]: true };
      if (visible) delete next.hidden[id];
    }
    if (!savePrefs(next)) return apiError(500, "failed to persist preferences");
    const previous = prefs;
    prefs = next;
    if (prefs.trackUsage !== previous.trackUsage) { usageEpoch++; updatedAt = Date.now(); }
    if (prefs.refreshSeconds !== previous.refreshSeconds) startLoop();
    if (["bridgeFactory", "bridgeSubscriptions", "queryProviders"].some((key) => prefs[key] !== previous[key])) await syncSources();
    return replyJson(200, { ok: true, value: prefs });
  });
  route("/usage/reset", ["POST"], () => {
    usageEpoch++;
    usage = Object.create(null);
    usageDirty = true;
    updatedAt = Date.now();
    // No network refresh is needed: list() projects local counters live.
    return persistUsage() ? replyJson(200, { ok: true }) : apiError(500, "failed to persist usage reset; will retry");
  });
}