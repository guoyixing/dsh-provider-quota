// Client half of @keyboard-dog/dsh-provider-quota.
// Renders a compact quota panel into `sidebar.footer.action` (the shell places
// it at the foot of the left sidebar, directly ABOVE the Settings/account row),
// plus a Settings page for refresh interval / visibility / bridge toggles.
// Reads the Host registry over loopback HTTP; subscription usage is fetched
// through the browser's authenticated connection RPC.

window.__ModuleLoader__.load({
  id: "@keyboard-dog/dsh-provider-quota",
  factory(require) {
    const React = require("react");
    const ReactDOM = require("react-dom");
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const zh = {
      title: "额度", refresh: "刷新", empty: "暂无额度数据", loading: "加载中…",
      unsupported: "不支持查询", error: "查询失败", open: "查看供应商额度",
      console: "控制台查看", notSignedIn: "未登录", staleQuota: "上次查询结果", quotaRefreshFailed: "刷新失败，显示上次结果",
      settingsTitle: "供应商额度", settingsDesc: "配置额度面板的刷新与显示。",
      refreshInterval: "刷新间隔（秒）", apply: "应用",
      bridges: "数据来源", bridgeFactory: "Factory (Droid) 订阅额度",
      bridgeSubscriptions: "订阅插件用量（Codex / Claude / Grok 等）",
      bridgeMagpie: "Magpie 网关额度", magpieAccount: "账号",
      magpieAuth401: "Magpie 网关未接受凭据（HTTP 401）",
      magpieAuth403: "Magpie 网关拒绝查询额度（HTTP 403）；请检查 Gateway Key 的额度查询权限。",
      magpieUpstreamError: "Magpie 未能读取此账号的额度。",
      magpieInvalidResponse: "Magpie 未返回有效的额度数据。",
      magpieRequestFailed: "无法读取 Magpie 网关额度。",
      queryProviders: "DSH 配置的供应商余额",
      visibility: "显示条目", visible: "显示", hidden: "隐藏",
      saved: "已保存", saveFail: "保存失败", noSources: "暂无可配置的条目",
      requests: "次请求（收到 usage）", in: "未缓存输入", out: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入", noUsageYet: "暂无 DSH 用量",
      localUsed: "本地已用", paused: "统计已暂停", since: "统计起始", unknownSince: "未知",
      trackUsage: "本地统计千问经 DSH 的用量", usageTitle: "千问本地用量",
      usageDesc: "仅统计经 DSH 的 token 消耗，非套餐真实剩余 Credits。", reset: "重置统计",
      resetConfirm: "确定重置所有千问供应商的本地累计用量吗？此操作无法撤销，不影响供应商实际额度。",
      resetting: "重置中…", resetSuccess: "统计已重置", resetFail: "重置失败，请重试",
    };
    const en = {
      title: "Quota", refresh: "Refresh", empty: "No quota data", loading: "Loading…",
      unsupported: "Not queryable", error: "Query failed", open: "View provider quota",
      console: "Open console", notSignedIn: "Not signed in", staleQuota: "Last known quota", quotaRefreshFailed: "Refresh failed; last known quota",
      settingsTitle: "Provider quota", settingsDesc: "Configure refresh and visibility of the quota panel.",
      refreshInterval: "Refresh interval (seconds)", apply: "Apply",
      bridges: "Data sources", bridgeFactory: "Factory (Droid) subscription quota",
      bridgeSubscriptions: "Subscription usage (Codex / Claude / Grok …)",
      bridgeMagpie: "Magpie gateway quota", magpieAccount: "Account",
      magpieAuth401: "Magpie gateway did not accept the credentials (HTTP 401).",
      magpieAuth403: "Magpie gateway denied quota access (HTTP 403). Check the Gateway Key's quota permission.",
      magpieUpstreamError: "Magpie could not read quota for this account.",
      magpieInvalidResponse: "Magpie did not return valid quota data.",
      magpieRequestFailed: "Could not read quota from the Magpie gateway.",
      queryProviders: "DSH-configured provider balances",
      visibility: "Visible items", visible: "Show", hidden: "Hide",
      saved: "Saved", saveFail: "Save failed", noSources: "No configurable items",
      requests: "requests with usage", in: "uncached input", out: "output", cacheRead: "cache read", cacheWrite: "cache write", noUsageYet: "No DSH usage yet",
      localUsed: "Locally used", paused: "Tracking paused", since: "Tracking since", unknownSince: "Unknown",
      trackUsage: "Track Qwen usage through DSH locally", usageTitle: "Qwen local usage",
      usageDesc: "Counts DSH token traffic only, not the plan's real remaining Credits.", reset: "Reset stats",
      resetConfirm: "Reset local usage totals for all Qwen providers? This cannot be undone and does not affect actual provider quota.",
      resetting: "Resetting…", resetSuccess: "Stats reset", resetFail: "Reset failed. Please retry.",
    };

    // Theme-token-only styles; widths are relative so the panel follows the
    // resizable sidebar. Light/dark follow the host automatically.
    const css = `
.pq-root{width:100%;min-width:0;flex:1 1 auto;box-sizing:border-box;}
.pq-wrap{display:flex;flex-direction:column;gap:2px;padding:2px 0;width:100%;min-width:0;box-sizing:border-box;}
.pq-head{display:flex;align-items:center;justify-content:space-between;padding:0 6px;gap:6px;}
.pq-title{font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);}
.pq-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0;flex:none;}
.pq-iconbtn:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary);}
.pq-iconbtn:disabled{opacity:.55;cursor:wait;}
.pq-rows{display:flex;flex-direction:column;gap:1px;width:100%;max-height:220px;overflow-y:auto;}
.pq-row{display:grid;grid-template-rows:16px 3px 13px;gap:3px;height:48px;flex:0 0 48px;padding:5px 6px;border-radius:6px;width:100%;min-width:0;box-sizing:border-box;overflow:hidden;}
.pq-row:hover{background:var(--dsw-specific-sidebar-nav-item-hover);}
.pq-line{grid-row:1;display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;width:100%;line-height:16px;overflow:hidden;}
.pq-label{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}
.pq-value{font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none;}
.pq-value.pq-muted{color:var(--dsw-alias-label-tertiary);font-size:11px;}
.pq-value.pq-err{color:var(--dsw-alias-state-error-primary);font-size:11px;}
.pq-link{font-size:11px;color:var(--dsw-alias-link);text-decoration:none;flex:none;}
.pq-link:hover{text-decoration:underline;}
.pq-localval{grid-row:3;min-width:0;width:100%;font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;}
.pq-bar{grid-row:2;height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;width:100%;}
.pq-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);}
.pq-bar-fill.pq-warn{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-brand-primary));}
.pq-bar-fill.pq-hot{background:var(--dsw-alias-state-error-primary);}
.pq-detail{grid-row:3;line-height:13px;min-width:0;font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;}
.pq-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:4px 6px;}
.pq-empty.pq-err{color:var(--dsw-alias-state-error-primary);}
.pq-railbtn{display:flex;align-items:center;justify-content:center;width:36px;height:32px;margin:0 auto;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.pq-railbtn:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary);}
.pq-pop{position:fixed;z-index:1200;width:min(260px,calc(100vw - 24px));background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:8px;box-sizing:border-box;}
.pq-pop .pq-rows{max-height:320px;}
.pq-set{display:flex;flex-direction:column;gap:18px;padding:4px 2px;max-width:640px;}
.pq-set h3{margin:0 0 2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}
.pq-set .pq-desc{font-size:12px;color:var(--dsw-alias-label-tertiary);margin:0 0 6px;}
.pq-set-group{display:flex;flex-direction:column;gap:8px;}
.pq-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}
.pq-set-row .pq-k{font-size:13px;color:var(--dsw-alias-label-primary);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.pq-set-row .pq-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.pq-num{display:flex;align-items:center;gap:8px;}
.pq-num input{width:80px;padding:5px 8px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;box-sizing:border-box;}
.pq-btn{padding:5px 12px;font-size:12px;border:none;border-radius:6px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;}
.pq-btn:hover{background:var(--dsw-alias-button-primary-hover);}
.pq-btn:disabled{opacity:.55;cursor:wait;}
.pq-switch{position:relative;display:inline-block;width:34px;height:20px;flex:none;}
.pq-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;}
.pq-switch .pq-track{position:absolute;inset:0;border-radius:20px;background:var(--dsw-alias-border-l2);transition:background .15s;pointer-events:none;}
.pq-switch input:focus-visible + .pq-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.pq-switch .pq-track:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .15s;}
.pq-switch input:checked + .pq-track{background:var(--dsw-alias-brand-primary);}
.pq-switch input:checked + .pq-track:before{transform:translateX(14px);}
.pq-msg{font-size:12px;color:var(--dsw-alias-state-success-primary);}
.pq-msg.pq-err{color:var(--dsw-alias-state-error-primary);}
`;

    function GaugeIcon({ size = 16 }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        h("path", { d: "M5 16a7 7 0 0 1 14 0", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
        h("line", { x1: 12, y1: 16, x2: 16, y2: 10.5, stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
        h("circle", { cx: 12, cy: 16, r: 1.6, fill: "currentColor" }));
    }
    function RefreshIcon({ size = 13 }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true },
        h("path", { d: "M20 12a8 8 0 1 1-2.34-5.66", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" }),
        h("path", { d: "M20 4v4h-4", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" }));
    }

    function barClass(pct) {
      if (pct >= 90) return "pq-bar-fill pq-hot";
      if (pct >= 70) return "pq-bar-fill pq-warn";
      return "pq-bar-fill";
    }
    function fmtTokens(n) {
      n = Number(n ?? 0);
      if (!Number.isFinite(n) || n <= 0) return "0";
      if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
      return String(Math.round(n));
    }
    function fmtReset(resetsAt) {
      if (typeof resetsAt !== "number" || !(resetsAt > Date.now())) return null;
      const minutes = Math.round((resetsAt - Date.now()) / 60000);
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.round(minutes / 60);
      if (hours < 48) return `${hours}h`;
      return `${Math.round(hours / 24)}d`;
    }
    function usageToView(windows) {
      const usable = windows.filter((w) => w?.usedPercent != null && w.usedPercent !== "" && Number.isFinite(Number(w.usedPercent)));
      if (usable.length === 0) return { status: "unsupported", detail: "no usage window" };
      const primary = usable.find((w) => w.label === "weekly") ?? usable[0];
      const used = Math.min(100, Math.max(0, Number(primary.usedPercent)));
      const parts = usable.map((w) => `${w.label} ${Math.round(Number(w.usedPercent))}%`);
      const reset = fmtReset(primary.resetsAt);
      return { status: "ok", remaining: `${Math.round(100 - used)}%`, usedPercent: used, detail: parts.join(" · ") + (reset ? ` · ↻${reset}` : "") };
    }
    // Resolve one subscription provider's quota the same way the subscriptions
    // plugin's own usage badge does: read the account roster from `status`, then
    // call `usage` with the default account key. Requires the browser's
    // authenticated connection RPC (the Host cannot reach this channel).
    async function resolveSubscriptionUsage(call, provider, account, force) {
      try {
        const result = await call("subscriptions-auth.usage", { provider, account, ...(force ? { force: true } : {}) });
        if (!result || result.ok === false) return { status: "error", error: "usage query rejected" };
        const usage = result.value;
        if (!usage) return { status: "error", error: "missing usage result" };
        if (usage.supported === false) return usage.retryAt || usage.stale
          ? { status: "error", error: usage.reason ?? "usage unavailable" }
          : { status: "unsupported", detail: usage.reason ?? "not supported" };
        const windows = (Array.isArray(usage.windows) ? usage.windows : []).filter(Boolean).map((w) => ({
          label: w.kind === "session" ? "5h" : w.kind === "weekly" ? "weekly" : (w.kind ?? "window"),
          usedPercent: w.usedPercent, resetsAt: w.resetsAt,
        }));
        const view = usageToView(windows);
        if (view.status === "ok") {
          view.stale = usage.refreshFailed === true || usage.stale === true || (typeof usage.staleAt === "number" && Date.now() >= usage.staleAt);
          if (usage.refreshFailed === true) view.error = usage.reason ?? "usage refresh failed";
          if (usage.credits?.balance !== undefined) view.detail = `${view.detail ?? ""} · credits ${usage.credits.balance}`;
        }
        return view;
      } catch (error) {
        return { status: "error", error: "usage fetch failed" };
      }
    }
    // The host list owns membership and ordering; only a persistent, visible
    // client-fetch entry owns its cached value and in-flight subscription work.
    function createSubscriptionPoller(setSources) {
      let list = [];
      let entries = new Map();
      const pending = new Set();
      function publish() {
        setSources(list.map((s) => {
          const snapshot = entries.get(s.id)?.snapshot;
          return snapshot ? { ...s, snapshot } : s;
        }).filter((s) => s.snapshot?.status !== "not-signed-in"));
      }
      async function call(rpc, method, payload) {
        const controller = new AbortController();
        // Race cancellation as well as passing the signal: alternative RPC
        // transports need not settle their promise when aborted.
        const cancelled = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("subscription RPC cancelled")), { once: true }));
        const timer = setTimeout(() => controller.abort(), 60000);
        pending.add(controller);
        try { return await Promise.race([cancelled, rpc.call("/api", method, payload, controller.signal)]); }
        finally { clearTimeout(timer); pending.delete(controller); }
      }
      function start(rpc, batch, force = false) {
        const roster = call(rpc, "subscriptions-auth.status", {}).then(
          (result) => result?.ok === false ? undefined : result?.value?.providers ?? result?.providers,
          () => undefined, // A failed roster is not evidence of sign-out.
        );
        for (const entry of batch) {
          entry.forced = force;
          entry.work = refresh(entry, roster, rpc, force).finally(() => { entry.work = undefined; });
        }
      }
      async function refresh(entry, roster, rpc, force) {
        const providers = await roster;
        if (entries.get(entry.id) !== entry) return;
        const state = providers?.[entry.provider];
        let snapshot;
        if (!Array.isArray(state?.accounts) || (!state.accounts.length && state.detail)) {
          snapshot = { status: "error", error: "subscription status unavailable" };
        } else if (!state.accounts.length) {
          entry.account = undefined;
          snapshot = { status: "not-signed-in" };
        } else {
          const account = (state.accounts.find((a) => a?.isDefault) ?? state.accounts[0])?.key;
          if (entry.account !== account) {
            // Never attribute a previous account's quota to a new default.
            entry.account = account;
            entry.snapshot = undefined;
            publish();
          }
          snapshot = account ? await resolveSubscriptionUsage((method, payload) => call(rpc, method, payload), entry.provider, account, force)
            : { status: "error", error: "subscription account unavailable" };
        }
        if (entries.get(entry.id) !== entry) return;
        entry.snapshot = snapshot.status === "error" && entry.snapshot?.status === "ok"
          ? { ...entry.snapshot, stale: true, error: snapshot.error }
          : snapshot;
        publish();
      }
      return {
        update(visible) {
          list = visible;
          const next = new Map();
          for (const s of list) {
            if (s.snapshot?.status !== "client-fetch") continue;
            const provider = s.snapshot.provider;
            const old = entries.get(s.id);
            next.set(s.id, old && old.provider === provider ? old : { id: s.id, provider });
          }
          entries = next;
          publish();
        },
        refresh(rpc, forcedEntries) {
          if (!rpc || entries.size === 0) return;
          const selected = [...entries.values()].filter((entry) => !forcedEntries?.has(entry));
          const batch = selected.filter((entry) => !entry.work);
          if (batch.length) start(rpc, batch, !!forcedEntries);
          if (!forcedEntries) return;
          return Promise.all(selected.map((entry) => {
            forcedEntries.add(entry);
            if (entry.forced) return entry.work;
            return entry.work.then(() => {
              if (entries.get(entry.id) !== entry) return;
              start(rpc, [entry], true);
              return entry.work;
            });
          }));
        },
        dispose() {
          entries.clear();
          for (const controller of pending) controller.abort();
        },
      };
    }
    const PREFS_EVENT = "provider-quota:changed";
    let preferenceWrites = Promise.resolve(); // Keep saves ordered across Settings remounts.
    const isHidden = (hidden, id) => hidden != null && Object.hasOwn(hidden, id) && !!hidden[id];

    async function readSourceList(response) {
      if (!response.ok) throw new Error("quota request failed");
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.value?.sources)) throw new Error("invalid quota response");
      return data.value;
    }

    function Row({ source, t }) {
      const s = source.snapshot ?? {};
      const account = s.account ? `${t("magpieAccount")}: ${s.account}` : null;
      const message = s.errorKey ? t(s.errorKey) || s.error : s.error;
      let value, detail = null;
      if (s.status === "ok") {
        const note = s.stale ? t(s.error ? "quotaRefreshFailed" : "staleQuota") : null;
        const summary = [note, s.detail].filter(Boolean).join(" · ");
        const tooltip = [note, s.tooltip || s.detail, account, s.stale && s.errorKey ? message : null].filter(Boolean).join(" · ");
        value = h("span", { className: "pq-value", title: tooltip || undefined }, s.remaining ?? "—");
        if (summary) detail = h("div", { className: "pq-detail", title: tooltip }, summary);
      } else if (s.status === "local") {
        const u = s.usage;
        const since = u?.since != null ? new Date(u.since) : null;
        const details = [
          s.tracking === false ? t("paused") : null,
          u ? `${t("in")} ${fmtTokens(u.input)} · ${t("out")} ${fmtTokens(u.output)} · ${t("cacheRead")} ${fmtTokens(u.cacheRead)} · ${t("cacheWrite")} ${fmtTokens(u.cacheWrite)} · ${u.requests ?? 0} ${t("requests")} · ${t("since")} ${since && Number.isFinite(since.getTime()) ? since.toLocaleString() : t("unknownSince")}` : t("noUsageYet"),
          t("usageDesc"),
        ].filter(Boolean).join(" · ");
        value = h("a", { className: "pq-link", href: s.link, target: "_blank", rel: "noreferrer" }, t("console"));
        detail = h("div", { className: "pq-localval", title: details },
          `${t("localUsed")} ${fmtTokens(u?.total)} tokens${s.tracking === false ? ` · ${t("paused")}` : ""}`);
      } else if (s.status === "loading" || s.status === "client-fetch") {
        value = h("span", { className: "pq-value pq-muted" }, "…");
      } else if (s.status === "console") {
        value = h("a", { className: "pq-link", href: s.link, target: "_blank", rel: "noreferrer" }, t("console"));
      } else if (s.status === "not-signed-in") {
        value = h("span", { className: "pq-value pq-muted", title: s.detail ?? "" }, t("notSignedIn"));
      } else if (s.status === "unsupported") {
        value = h("span", { className: "pq-value pq-muted", title: s.detail ?? "" }, t("unsupported"));
      } else {
        value = h("span", { className: "pq-value pq-err", title: [message, account].filter(Boolean).join(" · ") }, t("error"));
      }
      const showBar = s.status === "ok" && s.usedPercent != null && Number.isFinite(Number(s.usedPercent));
      return h("div", { className: "pq-row" + (s.status === "local" ? " pq-row-local" : "") },
        h("div", { className: "pq-line" },
          h("span", { className: "pq-label", title: source.label }, source.label),
          value),
        showBar && h("div", { className: "pq-bar" },
          h("div", { className: barClass(Number(s.usedPercent)), style: { width: `${Math.min(100, Math.max(0, Number(s.usedPercent)))}%` } })),
        detail);
    }

    function Panel({ sources, loading, refreshing, refreshFailed, t, onRefresh }) {
      return h("div", { className: "pq-wrap" },
        h("div", { className: "pq-head" },
          h("span", { className: "pq-title" }, t("title")),
          h("button", { type: "button", className: "pq-iconbtn", title: t(refreshing ? "loading" : "refresh"), "aria-label": t("refresh"), "aria-busy": refreshing, disabled: refreshing, onClick: onRefresh }, h(RefreshIcon, null))),
        refreshFailed && h("div", { className: "pq-empty pq-err", role: "status" }, t(sources.length ? "quotaRefreshFailed" : "error")),
        loading && sources.length === 0 ? h("div", { className: "pq-empty" }, t("loading"))
          : sources.length === 0 ? (!refreshFailed && h("div", { className: "pq-empty" }, t("empty")))
          : h("div", { className: "pq-rows" }, sources.map((s) => h(Row, { key: s.id, source: s, t }))));
    }

    function QuotaWidget({ wide, t, getRpc }) {
      const [sources, setSources] = useState([]);
      const [loading, setLoading] = useState(true);
      const [refreshing, setRefreshing] = useState(false);
      const [refreshFailed, setRefreshFailed] = useState(false);
      const [refreshSeconds, setRefreshSeconds] = useState(60);
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState({ top: 0, left: 0 });
      const btnRef = useRef(null);
      const popRef = useRef(null);
      const session = useRef(null);

      const publishList = useCallback((current) => {
        setRefreshSeconds(Math.min(3600, Math.max(5, Number(current.prefs?.refreshSeconds) || 60)));
        current.poller.update(current.sources.filter((s) => !isHidden(current.prefs?.hidden, s.id)));
      }, []);

      const acceptList = useCallback((current, version, value) => {
        if (session.current !== current || version < current.applied) return false;
        // A slow healthy list still advances the view unless a newer one was applied.
        current.applied = version;
        current.sources = value.sources;
        current.prefs = value.prefs;
        publishList(current);
        setLoading(false);
        setRefreshFailed(false);
        return true;
      }, [publishList]);

      const load = useCallback(async () => {
        const current = session.current;
        if (!current) return;
        const version = ++current.requested;
        try {
          const value = await readSourceList(await fetch("/api/provider-quota/list", { cache: "no-store", signal: AbortSignal.timeout(15000) }));
          if (acceptList(current, version, value) && !current.manual) current.poller.refresh(getRpc?.());
        } catch {
          if (session.current === current && version >= current.applied) {
            setLoading(false);
            setRefreshFailed(true);
          }
        }
      }, [acceptList, getRpc]);

      useEffect(() => {
        const poller = createSubscriptionPoller(setSources);
        const current = { poller, requested: 0, applied: 0, sources: [] };
        session.current = current;
        const onChanged = (event) => {
          // A confirmed save is authoritative even if the follow-up GET fails.
          if (event.detail?.prefs) {
            current.applied = ++current.requested;
            current.prefs = event.detail.prefs;
            publishList(current);
          }
          void load();
        };
        void load();
        window.addEventListener(PREFS_EVENT, onChanged);
        return () => { session.current = null; poller.dispose(); window.removeEventListener(PREFS_EVENT, onChanged); };
      }, [load, publishList]);
      useEffect(() => {
        const timer = setInterval(() => {
          // Polling while the refresh is in flight could reapply a pre-refresh snapshot.
          if (!session.current?.manual) void load();
        }, refreshSeconds * 1000);
        return () => clearInterval(timer);
      }, [load, refreshSeconds]);

      const onRefresh = useCallback(async () => {
        const current = session.current;
        if (!current || current.manual) return;
        current.manual = true;
        const version = ++current.requested;
        setRefreshing(true);
        setRefreshFailed(false);
        const rpc = getRpc?.();
        const forcedEntries = new Set();
        const subscriptions = current.poller.refresh(rpc, forcedEntries);
        try {
          const value = await readSourceList(await fetch("/api/provider-quota/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20000) }));
          if (!acceptList(current, version, value) && session.current === current) await load();
        } catch {
          if (session.current === current) { setLoading(false); setRefreshFailed(true); }
        } finally {
          if (session.current === current) {
            // Include subscription sources discovered by the Host refresh, without
            // forcing the same item twice.
            await Promise.all([subscriptions, current.poller.refresh(rpc, forcedEntries)]);
          }
          current.manual = false;
          if (session.current === current) setRefreshing(false);
        }
      }, [acceptList, getRpc, load]);

      useEffect(() => {
        if (!open) return;
        const onDown = (e) => { if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return; setOpen(false); };
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
      }, [open]);

      const openPop = () => {
        const rect = btnRef.current?.getBoundingClientRect();
        if (rect) {
          const left = Math.min(rect.right + 10, window.innerWidth - 272);
          const top = Math.max(8, Math.min(rect.top - 40, window.innerHeight - 360));
          setPos({ top, left });
        }
        setOpen((v) => !v);
      };

      if (wide) return h("div", { className: "pq-root" }, h(Panel, { sources, loading, refreshing, refreshFailed, t, onRefresh }));
      return h(React.Fragment, null,
        h("button", { type: "button", ref: btnRef, className: "pq-railbtn", title: t("open"), "aria-label": t("open"), onClick: openPop }, h(GaugeIcon, { size: 18 })),
        open && ReactDOM.createPortal(
          h("div", { className: "pq-pop", ref: popRef, style: { top: pos.top, left: pos.left }, role: "dialog", "aria-label": t("title") },
            h(Panel, { sources, loading, refreshing, refreshFailed, t, onRefresh })),
          document.body));
    }

    // -- Settings page ------------------------------------------------------
    function Switch({ checked, onChange, label }) {
      return h("label", { className: "pq-switch", title: label },
        h("input", { type: "checkbox", role: "switch", checked, "aria-checked": checked, onChange: (e) => onChange(e.target.checked), "aria-label": label }),
        h("span", { className: "pq-track" }));
    }

    function SettingsPage({ t }) {
      const [prefs, setPrefs] = useState(null);
      const [sources, setSources] = useState([]);
      const [intervalDraft, setIntervalDraft] = useState("");
      const [msg, setMsg] = useState(null);
      const [resetting, setResetting] = useState(false);
      const [pending, setPending] = useState([]);
      const [loadFailed, setLoadFailed] = useState(false);
      const [loadAttempt, setLoadAttempt] = useState(0);
      const failedInBatch = useRef(false);
      const queuedCount = useRef(0);
      const mounted = useRef(false);
      const resetPending = useRef(false);
      const msgTimer = useRef(null);

      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearTimeout(msgTimer.current); };
      }, []);
      const showMessage = (message) => {
        clearTimeout(msgTimer.current);
        setMsg(message);
        if (message.ok) msgTimer.current = setTimeout(() => setMsg(null), 2500);
      };

      useEffect(() => {
        let live = true;
        setLoadFailed(false);
        (async () => {
          try {
            await preferenceWrites; // The previous Settings section may have unmounted while saving.
            if (!live) return;
            const data = await readSourceList(await fetch("/api/provider-quota/list", { cache: "no-store", signal: AbortSignal.timeout(15000) }));
            if (!data.prefs) throw new Error("missing preferences");
            if (!live) return;
            setPrefs(data.prefs);
            setSources(data.sources);
            setIntervalDraft(String(data.prefs.refreshSeconds ?? 60));
          } catch { if (live) setLoadFailed(true); }
        })();
        return () => { live = false; };
      }, [loadAttempt]);

      // Render unacknowledged intents over the last confirmed prefs. Removing
      // a failed intent rolls back only that switch, not newer user input.
      const save = (patch) => {
        if (queuedCount.current++ === 0) failedInBatch.current = false;
        setPending((items) => [...items, patch]);
        preferenceWrites = preferenceWrites.then(async () => {
          try {
            const res = await fetch("/api/provider-quota/prefs", {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch), signal: AbortSignal.timeout(15000),
            });
            const data = await res.json();
            if (!res.ok || !data?.ok || !data.value?.hidden) throw new Error("save failed");
            const item = patch.visibility;
            if (item && item.visible === isHidden(data.value.hidden, item.id)) throw new Error("visibility not applied");
            if (mounted.current) setPrefs(data.value);
            window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { prefs: data.value } }));
          } catch {
            failedInBatch.current = true;
            if (mounted.current) showMessage({ ok: false, itemId: patch.visibility?.id, text: t("saveFail") });
          } finally {
            queuedCount.current--;
            if (mounted.current) {
              setPending((items) => items.filter((item) => item !== patch));
              if (!queuedCount.current && !failedInBatch.current) showMessage({ ok: true, text: t("saved") });
            }
          }
        });
        return preferenceWrites;
      };

      const applyInterval = () => {
        const n = Number(intervalDraft);
        const saved = prefs?.refreshSeconds ?? 60;
        if (!Number.isFinite(n) || n < 5) { setIntervalDraft(String(saved)); return; }
        const next = Math.min(3600, Math.round(n));
        setIntervalDraft(String(next));
        const latest = pending.findLast((patch) => patch.refreshSeconds !== undefined)?.refreshSeconds ?? saved;
        if (next !== latest) save({ refreshSeconds: next });
      };
      const toggleHidden = (id, visible) => save({ visibility: { id, visible } });
      const resetUsage = async () => {
        if (resetPending.current || !window.confirm(t("resetConfirm"))) return;
        resetPending.current = true;
        setResetting(true);
        clearTimeout(msgTimer.current);
        setMsg(null);
        try {
          const res = await fetch("/api/provider-quota/usage/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const data = await res.json();
          if (!res.ok || !data?.ok) throw new Error("reset failed");
          window.dispatchEvent(new CustomEvent(PREFS_EVENT));
          showMessage({ ok: true, text: t("resetSuccess") });
        } catch { showMessage({ ok: false, text: t("resetFail") }); }
        finally { resetPending.current = false; setResetting(false); }
      };

      if (!prefs) return h("div", { className: "pq-set" }, loadFailed
        ? h("div", { role: "alert" }, t("error"), " ", h("button", { className: "pq-btn", type: "button", onClick: () => setLoadAttempt((n) => n + 1) }, t("refresh")))
        : h("p", { className: "pq-desc" }, t("loading")));
      const draft = { ...prefs };
      const hidden = Object.assign(Object.create(null), prefs.hidden);
      for (const patch of pending) {
        if (patch.visibility) hidden[patch.visibility.id] = !patch.visibility.visible;
        else Object.assign(draft, patch);
      }

      return h("div", { className: "pq-set" },
        h("div", null,
          h("h3", null, t("settingsTitle")),
          h("p", { className: "pq-desc" }, t("settingsDesc"))),

        h("div", { className: "pq-set-group" },
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("refreshInterval")),
            h("div", { className: "pq-num" },
              h("input", { type: "number", min: 5, max: 3600, value: intervalDraft,
                onChange: (e) => setIntervalDraft(e.target.value),
                onBlur: applyInterval,
                onKeyDown: (e) => { if (e.key === "Enter") { e.target.blur(); } } }),
              h("button", { type: "button", className: "pq-btn", onClick: applyInterval }, t("apply"))))),

        h("div", { className: "pq-set-group" },
          h("h3", null, t("bridges")),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("bridgeFactory")),
            h(Switch, { checked: !!draft.bridgeFactory, onChange: (v) => save({ bridgeFactory: v }), label: t("bridgeFactory") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("bridgeSubscriptions")),
            h(Switch, { checked: !!draft.bridgeSubscriptions, onChange: (v) => save({ bridgeSubscriptions: v }), label: t("bridgeSubscriptions") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("bridgeMagpie")),
            h(Switch, { checked: draft.bridgeMagpie !== false, onChange: (v) => save({ bridgeMagpie: v }), label: t("bridgeMagpie") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("queryProviders")),
            h(Switch, { checked: !!draft.queryProviders, onChange: (v) => save({ queryProviders: v }), label: t("queryProviders") }))),

        h("div", { className: "pq-set-group" },
          h("h3", null, t("usageTitle")),
          h("p", { className: "pq-desc" }, t("usageDesc")),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("trackUsage")),
            h(Switch, { checked: !!draft.trackUsage, onChange: (v) => save({ trackUsage: v }), label: t("trackUsage") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("usageTitle")),
            h("button", { type: "button", className: "pq-btn", disabled: resetting, "aria-busy": resetting, onClick: resetUsage }, t(resetting ? "resetting" : "reset")))),

        h("div", { className: "pq-set-group" },
          h("h3", null, t("visibility")),
          sources.length === 0 ? h("p", { className: "pq-desc" }, t("noSources"))
            : sources.map((s) => h("div", { className: "pq-set-row", key: s.id },
                h("span", { className: "pq-k", title: s.label }, s.label),
                msg?.itemId === s.id && h("span", { className: "pq-msg pq-err", role: "alert" }, t("saveFail")),
                h(Switch, { checked: !hidden[s.id], onChange: (v) => toggleHidden(s.id, v), label: s.label })))),

        msg && msg.itemId === undefined ? h("span", { className: "pq-msg" + (msg.ok ? "" : " pq-err"), role: msg.ok ? "status" : "alert" }, msg.text) : null);
    }

    return {
      inject: ["slots", "locale", "connection"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register("providerQuota", { zh, en }), "provider-quota: dictionaries");
        const t = ctx.locale.bind("providerQuota");
        const getRpc = () => ctx.get("connection")?.rpc;
        ctx.effect(() => {
          const tagId = "@keyboard-dog/dsh-provider-quota/widget.css";
          let tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`);
          if (!tag) {
            tag = document.createElement("style");
            tag.dataset.plugin = "@keyboard-dog/dsh-provider-quota";
            tag.dataset.pluginCss = tagId;
            tag.textContent = css;
            document.head.appendChild(tag);
          }
          return () => { tag?.remove(); };
        }, "provider-quota: styles");

        const Bound = (props) => h(QuotaWidget, { ...props, t, getRpc });
        ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
          name: "sidebar.footer.action", id: "provider-quota", order: 10, label: () => t("title"),
        }, Bound));

        const BoundSettings = (props) => h(SettingsPage, { ...props, t });
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section", id: "provider-quota", order: 60, label: () => t("settingsTitle"), locale: "providerQuota",
        }, BoundSettings));
      },
    };
  },
});