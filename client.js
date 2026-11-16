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
      console: "控制台查看", notSignedIn: "未登录",
      settingsTitle: "供应商额度", settingsDesc: "配置额度面板的刷新与显示。",
      refreshInterval: "刷新间隔（秒）", apply: "应用",
      bridges: "数据来源", bridgeFactory: "Factory (Droid) 订阅额度",
      bridgeSubscriptions: "订阅插件用量（Codex / Claude / Grok 等）",
      queryProviders: "DSH 配置的供应商余额",
      visibility: "显示条目", visible: "显示", hidden: "隐藏",
      saved: "已保存", saveFail: "保存失败", noSources: "暂无可配置的条目",
      requests: "次请求", in: "输入", out: "输出", cache: "缓存", noUsageYet: "暂无 DSH 用量",
      trackUsage: "本地统计千问经 DSH 的用量", usageTitle: "千问本地用量",
      usageDesc: "仅统计经 DSH 的 token 消耗，非套餐真实剩余 Credits。", reset: "重置统计",
    };
    const en = {
      title: "Quota", refresh: "Refresh", empty: "No quota data", loading: "Loading…",
      unsupported: "Not queryable", error: "Query failed", open: "View provider quota",
      console: "Open console", notSignedIn: "Not signed in",
      settingsTitle: "Provider quota", settingsDesc: "Configure refresh and visibility of the quota panel.",
      refreshInterval: "Refresh interval (seconds)", apply: "Apply",
      bridges: "Data sources", bridgeFactory: "Factory (Droid) subscription quota",
      bridgeSubscriptions: "Subscription usage (Codex / Claude / Grok …)",
      queryProviders: "DSH-configured provider balances",
      visibility: "Visible items", visible: "Show", hidden: "Hide",
      saved: "Saved", saveFail: "Save failed", noSources: "No configurable items",
      requests: "requests", in: "in", out: "out", cache: "cache", noUsageYet: "No DSH usage yet",
      trackUsage: "Track Qwen usage through DSH locally", usageTitle: "Qwen local usage",
      usageDesc: "Counts DSH token traffic only, not the plan's real remaining Credits.", reset: "Reset stats",
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
.pq-rows{display:flex;flex-direction:column;gap:1px;width:100%;max-height:220px;overflow-y:auto;}
.pq-row{display:flex;flex-direction:column;gap:3px;padding:5px 6px;border-radius:6px;width:100%;min-width:0;box-sizing:border-box;}
.pq-row:hover{background:var(--dsw-specific-sidebar-nav-item-hover);}
.pq-line{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;width:100%;}
.pq-label{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}
.pq-value{font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none;}
.pq-value.pq-muted{color:var(--dsw-alias-label-tertiary);font-size:11px;}
.pq-value.pq-err{color:var(--dsw-alias-state-error-primary);font-size:11px;}
.pq-link{font-size:11px;color:var(--dsw-alias-link);text-decoration:none;flex:none;}
.pq-link:hover{text-decoration:underline;}
.pq-localval{display:inline-flex;align-items:center;gap:6px;flex:none;min-width:0;}
.pq-bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;width:100%;}
.pq-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);}
.pq-bar-fill.pq-warn{background:var(--dsw-alias-state-warning-primary);}
.pq-bar-fill.pq-hot{background:var(--dsw-alias-state-error-primary);}
.pq-detail{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;}
.pq-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:4px 6px;}
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
.pq-switch{position:relative;display:inline-block;width:34px;height:20px;flex:none;}
.pq-switch input{opacity:0;width:0;height:0;}
.pq-switch .pq-track{position:absolute;inset:0;border-radius:20px;background:var(--dsw-alias-border-l2);transition:background .15s;cursor:pointer;}
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
      const usable = (windows ?? []).filter((w) => w && Number.isFinite(Number(w.usedPercent)));
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
    async function resolveSubscriptionUsage(rpc, providers, provider) {
      if (!providers) return { status: "error", error: "subscription status unavailable" };
      const state = providers?.[provider];
      const accounts = (state?.accounts ?? []).slice().sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      if (accounts.length === 0) return { status: "not-signed-in" };
      try {
        const result = await rpc.call("/api", "subscriptions-auth.usage", { provider, account: accounts[0].key });
        if (!result || result.ok === false) return { status: "error", error: "usage query rejected" };
        const usage = result.value;
        if (!usage || usage.supported === false) return { status: "unsupported", detail: usage?.reason ?? "not supported" };
        const windows = (usage.windows ?? []).map((w) => ({
          label: w.kind === "session" ? "5h" : w.kind === "weekly" ? "weekly" : (w.kind ?? "window"),
          usedPercent: w.usedPercent, resetsAt: w.resetsAt,
        }));
        const view = usageToView(windows);
        if (view.status === "ok" && usage.credits?.balance !== undefined) view.detail = `${view.detail ?? ""} · credits ${usage.credits.balance}`;
        return view;
      } catch (error) {
        return { status: "error", error: "usage fetch failed" };
      }
    }
    async function fetchSubscriptionProviders(rpc) {
      try {
        const result = await rpc.call("/api", "subscriptions-auth.status", {});
        return result?.value?.providers ?? result?.providers ?? null;
      } catch { return null; }
    }
    const PREFS_EVENT = "provider-quota:changed";

    function Row({ source, t }) {
      const s = source.snapshot ?? {};
      let value, detail = null;
      if (s.status === "ok") {
        value = h("span", { className: "pq-value" }, s.remaining ?? "—");
        if (s.detail) detail = h("div", { className: "pq-detail", title: s.detail }, s.detail);
      } else if (s.status === "local") {
        const u = s.usage;
        value = h("span", { className: "pq-localval" },
          h("span", { className: "pq-value", title: u ? `${u.requests} ${t("requests")}` : "" }, u ? fmtTokens(u.total) : "—"),
          h("a", { className: "pq-link", href: s.link, target: "_blank", rel: "noreferrer" }, t("console")));
        detail = h("div", { className: "pq-detail" },
          u ? `${t("in")} ${fmtTokens(u.input)} · ${t("out")} ${fmtTokens(u.output)} · ${t("cache")} ${fmtTokens(u.cacheRead)}` : t("noUsageYet"));
      } else if (s.status === "loading" || s.status === "client-fetch") {
        value = h("span", { className: "pq-value pq-muted" }, "…");
      } else if (s.status === "console") {
        value = h("a", { className: "pq-link", href: s.link, target: "_blank", rel: "noreferrer" }, t("console"));
      } else if (s.status === "not-signed-in") {
        value = h("span", { className: "pq-value pq-muted", title: s.detail ?? "" }, t("notSignedIn"));
      } else if (s.status === "unsupported") {
        value = h("span", { className: "pq-value pq-muted", title: s.detail ?? "" }, t("unsupported"));
      } else {
        value = h("span", { className: "pq-value pq-err", title: s.error ?? "" }, t("error"));
      }
      const showBar = s.status === "ok" && s.usedPercent != null && Number.isFinite(Number(s.usedPercent));
      return h("div", { className: "pq-row" },
        h("div", { className: "pq-line" },
          h("span", { className: "pq-label", title: source.label }, source.label),
          value),
        showBar && h("div", { className: "pq-bar" },
          h("div", { className: barClass(Number(s.usedPercent)), style: { width: `${Math.min(100, Math.max(0, Number(s.usedPercent)))}%` } })),
        detail);
    }

    function Panel({ sources, loading, t, onRefresh }) {
      return h("div", { className: "pq-wrap" },
        h("div", { className: "pq-head" },
          h("span", { className: "pq-title" }, t("title")),
          h("button", { type: "button", className: "pq-iconbtn", title: t("refresh"), "aria-label": t("refresh"), onClick: onRefresh }, h(RefreshIcon, null))),
        loading && sources.length === 0 ? h("div", { className: "pq-empty" }, t("loading"))
          : sources.length === 0 ? h("div", { className: "pq-empty" }, t("empty"))
          : h("div", { className: "pq-rows" }, sources.map((s) => h(Row, { key: s.id, source: s, t }))));
    }

    function QuotaWidget({ wide, t, getRpc }) {
      const [sources, setSources] = useState([]);
      const [loading, setLoading] = useState(true);
      const [refreshSeconds, setRefreshSeconds] = useState(60);
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState({ top: 0, left: 0 });
      const btnRef = useRef(null);
      const popRef = useRef(null);

      const load = useCallback(async () => {
        try {
          const res = await fetch("/api/provider-quota/list", { cache: "no-store" });
          const data = await res.json();
          let list = data?.ok && Array.isArray(data.value?.sources) ? data.value.sources : [];
          setRefreshSeconds(Math.min(3600, Math.max(5, Number(data?.value?.prefs?.refreshSeconds) || 60)));
          const hidden = data?.value?.prefs?.hidden ?? {};
          const rpc = getRpc ? getRpc() : undefined;
          if (rpc && list.some((s) => s.snapshot?.status === "client-fetch")) {
            const providers = await fetchSubscriptionProviders(rpc);
            list = await Promise.all(list.map(async (s) => {
              if (s.snapshot && s.snapshot.status === "client-fetch") {
                return { ...s, snapshot: await resolveSubscriptionUsage(rpc, providers, s.snapshot.provider) };
              }
              return s;
            }));
          }
          setSources(list.filter((s) => !hidden[s.id] && s.snapshot?.status !== "not-signed-in"));
        } catch { /* keep last state; never throw */ }
        finally { setLoading(false); }
      }, [getRpc]);

      useEffect(() => {
        load();
        const onChanged = () => load();
        window.addEventListener(PREFS_EVENT, onChanged);
        return () => { window.removeEventListener(PREFS_EVENT, onChanged); };
      }, [load]);
      useEffect(() => {
        const timer = setInterval(load, refreshSeconds * 1000);
        return () => clearInterval(timer);
      }, [load, refreshSeconds]);

      const onRefresh = useCallback(async () => {
        try { await fetch("/api/provider-quota/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch {}
        load();
      }, [load]);

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

      if (wide) return h("div", { className: "pq-root" }, h(Panel, { sources, loading, t, onRefresh }));
      return h(React.Fragment, null,
        h("button", { type: "button", ref: btnRef, className: "pq-railbtn", title: t("open"), "aria-label": t("open"), onClick: openPop }, h(GaugeIcon, { size: 18 })),
        open && ReactDOM.createPortal(
          h("div", { className: "pq-pop", ref: popRef, style: { top: pos.top, left: pos.left }, role: "dialog", "aria-label": t("title") },
            h(Panel, { sources, loading, t, onRefresh })),
          document.body));
    }

    // -- Settings page ------------------------------------------------------
    function Switch({ checked, onChange, label }) {
      return h("label", { className: "pq-switch", title: label },
        h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked), "aria-label": label }),
        h("span", { className: "pq-track" }));
    }

    function SettingsPage({ t }) {
      const [prefs, setPrefs] = useState(null);
      const [sources, setSources] = useState([]);
      const [intervalDraft, setIntervalDraft] = useState("");
      const [msg, setMsg] = useState(null);

      const load = useCallback(async () => {
        try {
          const [p, l] = await Promise.all([
            fetch("/api/provider-quota/prefs", { cache: "no-store" }).then((r) => r.json()),
            fetch("/api/provider-quota/list", { cache: "no-store" }).then((r) => r.json()),
          ]);
          if (p?.ok) { setPrefs(p.value); setIntervalDraft(String(p.value.refreshSeconds ?? 60)); }
          if (l?.ok) setSources(l.value.sources ?? []);
        } catch {}
      }, []);
      useEffect(() => { load(); }, [load]);

      const save = useCallback(async (patch) => {
        try {
          const res = await fetch("/api/provider-quota/prefs", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
          });
          const data = await res.json();
          if (data?.ok) {
            setPrefs(data.value); setMsg({ ok: true, text: t("saved") });
            window.dispatchEvent(new CustomEvent(PREFS_EVENT));
          }
          else setMsg({ ok: false, text: t("saveFail") });
        } catch { setMsg({ ok: false, text: t("saveFail") }); }
        setTimeout(() => setMsg(null), 2500);
      }, [t]);

      const applyInterval = () => {
        const n = Number(intervalDraft);
        if (!Number.isFinite(n) || n < 5) { setIntervalDraft(String(prefs?.refreshSeconds ?? 60)); return; }
        save({ refreshSeconds: Math.round(n) });
      };
      const toggleHidden = (id, visible) => {
        const hidden = { ...(prefs?.hidden ?? {}) };
        if (visible) delete hidden[id]; else hidden[id] = true;
        save({ hidden });
      };
      const resetUsage = async () => {
        try {
          const res = await fetch("/api/provider-quota/usage/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const data = await res.json();
          if (!res.ok || !data?.ok) throw new Error("reset failed");
          window.dispatchEvent(new CustomEvent(PREFS_EVENT));
          setMsg({ ok: true, text: t("saved") });
        } catch { setMsg({ ok: false, text: t("saveFail") }); }
        setTimeout(() => setMsg(null), 2500);
      };

      if (!prefs) return h("div", { className: "pq-set" }, h("p", { className: "pq-desc" }, t("loading")));

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
            h(Switch, { checked: !!prefs.bridgeFactory, onChange: (v) => save({ bridgeFactory: v }), label: t("bridgeFactory") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("bridgeSubscriptions")),
            h(Switch, { checked: !!prefs.bridgeSubscriptions, onChange: (v) => save({ bridgeSubscriptions: v }), label: t("bridgeSubscriptions") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("queryProviders")),
            h(Switch, { checked: !!prefs.queryProviders, onChange: (v) => save({ queryProviders: v }), label: t("queryProviders") }))),

        h("div", { className: "pq-set-group" },
          h("h3", null, t("usageTitle")),
          h("p", { className: "pq-desc" }, t("usageDesc")),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("trackUsage")),
            h(Switch, { checked: !!prefs.trackUsage, onChange: (v) => save({ trackUsage: v }), label: t("trackUsage") })),
          h("div", { className: "pq-set-row" },
            h("span", { className: "pq-k" }, t("usageTitle")),
            h("button", { type: "button", className: "pq-btn", onClick: resetUsage }, t("reset")))),

        h("div", { className: "pq-set-group" },
          h("h3", null, t("visibility")),
          sources.length === 0 ? h("p", { className: "pq-desc" }, t("noSources"))
            : sources.map((s) => h("div", { className: "pq-set-row", key: s.id },
                h("span", { className: "pq-k", title: s.label }, s.label),
                h(Switch, { checked: !(prefs.hidden ?? {})[s.id], onChange: (v) => toggleHidden(s.id, v), label: s.label })))),

        msg ? h("span", { className: "pq-msg" + (msg.ok ? "" : " pq-err") }, msg.text) : null);
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