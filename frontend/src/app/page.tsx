"use client";

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";

// Dynamic import — lightweight-charts is browser-only
const TradingChart = lazy(() => import("../components/TradingChart"));

// ── API base: same origin on Render (single service), override via env locally ──
const API = process.env.NEXT_PUBLIC_API_URL ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Account  { id:number; cash_balance:number; shares_held:number; ticker:string; portfolio_value:number; total_pnl:number }
interface Trade    { id:number; ticker:string; action:string; price:number; shares:number; pnl:number|null; cash_after:number; fast_sma:number|null; slow_sma:number|null; signal_reason:string|null; executed_at:string }
interface Bar      { time:string; open:number; high:number; low:number; close:number; volume:number; fast_sma:number|null; slow_sma:number|null }
interface ChartData{ ticker:string; company_name:string; current_price:number; change:number; change_pct:number; bars:Bar[]; is_simulated:boolean }
interface Quote    { ticker:string; name:string; price:number; change:number; change_pct:number; market_cap:string; sector:string; is_simulated:boolean }
interface LiveTick { ticker:string; price:number; change:number; change_pct:number; source:string; timestamp:string }
interface StrategyResult { signal:string; message:string; current_price:number; fast_sma:number; slow_sma:number; account:Account; trade:Trade|null }

const PERIODS = [
  { label:"1M", value:"1mo" },
  { label:"3M", value:"3mo" },
  { label:"6M", value:"6mo" },
  { label:"1Y", value:"1y"  },
  { label:"2Y", value:"2y"  },
];

const BANNER_TICKERS = ["AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","JPM","NFLX","AMD","V","ADBE","CRM","ORCL","MA"];

const $  = (v:number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(v);
const dt = (s:string) => new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function TickerBanner({ liveMap }: { liveMap: Record<string, LiveTick> }) {
  const filled = BANNER_TICKERS.filter(t => liveMap[t]);
  if (filled.length === 0) return null;
  const items = [...filled, ...filled];
  return (
    <div className="overflow-hidden border-b border-[#1e2d40] bg-[#0a0e17] h-7 flex items-center">
      <div className="ticker-tape flex whitespace-nowrap">
        {items.map((t, i) => {
          const d = liveMap[t]; if (!d) return null;
          const up = d.change_pct >= 0;
          return (
            <span key={i} className="inline-flex items-center gap-1.5 px-4 text-[10px] font-mono">
              <span className="text-[#00aaff] font-bold">{t}</span>
              <span className="text-[#e2e8f0]">${d.price.toFixed(2)}</span>
              <span className={up ? "text-[#00ff88]" : "text-[#ff4466]"}>
                {up ? "▲" : "▼"}{Math.abs(d.change_pct).toFixed(2)}%
              </span>
              <span className="text-[#1e2d40] mx-1">|</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label:string; value:string; sub:string; color:string }) {
  return (
    <div className={`bg-[#111827] border border-[#1e2d40] border-l-2 ${color} rounded-sm p-4`}>
      <div className="text-[9px] tracking-widest text-[#4a5568] uppercase mb-1">{label}</div>
      <div className={`text-xl font-bold ${color.replace("border-l-","text-")}`}>{value}</div>
      <div className="text-[10px] text-[#4a5568] mt-0.5">{sub}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [account,  setAccount]  = useState<Account|null>(null);
  const [trades,   setTrades]   = useState<Trade[]>([]);
  const [quotes,   setQuotes]   = useState<Quote[]>([]);
  const [chart,    setChart]    = useState<ChartData|null>(null);
  const [ticker,   setTicker]   = useState("AAPL");
  const [period,   setPeriod]   = useState("3mo");
  const [liveTick, setLiveTick] = useState<LiveTick|null>(null);
  const [liveMap,  setLiveMap]  = useState<Record<string,LiveTick>>({});
  const [running,  setRunning]  = useState(false);
  const [cLoading, setCLoading] = useState(false);
  const [booting,  setBooting]  = useState(true);
  const [search,   setSearch]   = useState("");
  const [error,    setError]    = useState<string|null>(null);
  const [log,      setLog]      = useState<string[]>([]);
  const [lastSig,  setLastSig]  = useState<string|null>(null);
  const [flashDir, setFlashDir] = useState<"up"|"down"|null>(null);
  const prevPrice               = useRef(0);
  const mounted                 = useRef(false);
  const searchTimer             = useRef<ReturnType<typeof setTimeout>>();

  const addLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    setLog(p => [`[${ts}] ${msg}`, ...p].slice(0, 60));
  };

  // ── Fetchers ───────────────────────────────────────────────────────────────
  const getAccount = useCallback(async () => {
    const r = await fetch(`${API}/api/v1/account`);
    if (!r.ok) throw new Error("Account fetch failed");
    return r.json() as Promise<Account>;
  }, []);

  const getTrades = useCallback(async () => {
    const r = await fetch(`${API}/api/v1/trades`);
    if (!r.ok) throw new Error("Trades fetch failed");
    return r.json() as Promise<Trade[]>;
  }, []);

  const loadChart = useCallback(async (t: string, p: string) => {
    setCLoading(true);
    try {
      const r = await fetch(`${API}/api/v1/chart/${t}?period=${p}`);
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail ?? "Chart error"); }
      const d = await r.json() as ChartData;
      setChart(d);
      addLog(`${t} chart loaded (${p}) — ${d.bars.length} bars${d.is_simulated ? " [sim]" : ""}`);
    } catch(e: unknown) {
      addLog(`Chart error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setCLoading(false);
    }
  }, []);

  const loadQuotes = useCallback(async (q: string) => {
    try {
      const r = await fetch(`${API}/api/v1/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return;
      const data = await r.json() as Quote[];
      setQuotes(data);
      // Seed liveMap from quotes
      const map: Record<string, LiveTick> = {};
      data.forEach(q => {
        map[q.ticker] = { ticker:q.ticker, price:q.price, change:q.change,
                          change_pct:q.change_pct, source:"quote", timestamp:"" };
      });
      setLiveMap(prev => ({ ...prev, ...map }));
    } catch { /* silent */ }
  }, []);

  // ── Boot ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      addLog("Connecting to engine…");
      try {
        const [a, t] = await Promise.all([getAccount(), getTrades()]);
        setAccount(a); setTrades(t);
        prevPrice.current = a.portfolio_value;
        addLog(`Engine online — ${$(a.cash_balance)}`);
        await Promise.all([loadChart("AAPL", "3mo"), loadQuotes("")]);
      } catch(e: unknown) {
        setError(e instanceof Error ? e.message : "Connection failed");
        addLog("ERROR: Could not connect to backend");
      } finally {
        setBooting(false);
      }
    })();
  }, [getAccount, getTrades, loadChart, loadQuotes]);

  // ── Reload chart when ticker/period changes ────────────────────────────────
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    loadChart(ticker, period);
  }, [ticker, period, loadChart]);

  // ── Search debounce ────────────────────────────────────────────────────────
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => loadQuotes(search), 400);
  }, [search, loadQuotes]);

  // ── WebSocket for active ticker — exponential backoff ─────────────────────
  useEffect(() => {
    let ws: WebSocket | null = null;
    let dead    = false;
    let delay   = 1000;   // start 1s, doubles each failure, caps at 30s

    const base = (process.env.NEXT_PUBLIC_API_URL ?? window.location.origin)
                   .replace(/^http/, "ws");

    function connect() {
      if (dead) return;
      try { ws = new WebSocket(`${base}/ws/price/${ticker}`); }
      catch { schedule(); return; }

      ws.onopen = () => {
        delay = 1000;   // reset backoff
        addLog(`WS connected: ${ticker}`);
      };

      ws.onmessage = (e) => {
        try {
          const tick: LiveTick = JSON.parse(e.data);
          // Flash direction
          if (tick.price !== prevPrice.current) {
            setFlashDir(tick.price > prevPrice.current ? "up" : "down");
            setTimeout(() => setFlashDir(null), 600);
          }
          prevPrice.current = tick.price;
          setLiveTick(tick);
          setLiveMap(prev => ({ ...prev, [tick.ticker]: tick }));
        } catch { /* bad frame */ }
      };

      ws.onerror = () => ws?.close();
      ws.onclose = () => { if (!dead) schedule(); };
    }

    function schedule() {
      const d = Math.min(delay, 30_000);
      delay   = d * 2;
      addLog(`WS reconnect in ${(d/1000).toFixed(0)}s…`);
      setTimeout(connect, d);
    }

    connect();
    return () => { dead = true; ws?.close(); };
  }, [ticker]);

  // ── Strategy ───────────────────────────────────────────────────────────────
  const runStrategy = async () => {
    if (running) return;
    setRunning(true); setError(null);
    addLog(`Running strategy on ${ticker}…`);
    try {
      const r = await fetch(`${API}/api/v1/run-strategy?ticker=${ticker}`, { method:"POST" });
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail ?? "Strategy failed"); }
      const res: StrategyResult = await r.json();
      setLastSig(res.signal);
      setAccount(res.account);
      setTrades(await getTrades());
      addLog(`Signal: ${res.signal} | ${ticker} @ ${$(res.current_price)}`);
      if (res.trade) addLog(`Executed ${res.trade.action} — ${res.trade.shares} shares @ ${$(res.trade.price)}`);
      await loadChart(ticker, period);
    } catch(e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg); addLog(`ERROR: ${msg}`);
    } finally { setRunning(false); }
  };

  const doReset = async () => {
    if (!confirm("Reset account to $10,000?")) return;
    await fetch(`${API}/api/v1/reset-account`, { method:"POST" });
    const [a,t] = await Promise.all([getAccount(), getTrades()]);
    setAccount(a); setTrades(t); setLastSig(null);
    addLog("Account reset to $10,000.");
  };

  // ── Current display price ──────────────────────────────────────────────────
  const displayPrice = liveTick?.price ?? chart?.current_price ?? 0;
  const displayChg   = liveTick?.change_pct ?? chart?.change_pct ?? 0;
  const pnlPos       = (account?.total_pnl ?? 0) >= 0;

  if (booting) return (
    <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="text-[#00ff88] text-3xl font-bold animate-pulse">LOADING</div>
        <div className="text-[#4a5568] text-xs tracking-widest">CONNECTING TO ENGINE…</div>
      </div>
    </div>
  );

  const filteredQuotes = quotes.filter(q =>
    q.ticker.includes(search.toUpperCase()) || q.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#0a0e17] text-[#e2e8f0] font-mono">

      {/* ── Ticker tape ── */}
      <TickerBanner liveMap={liveMap} />

      {/* ── Header ── */}
      <header className="border-b border-[#1e2d40] px-5 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="live-dot w-2 h-2 bg-[#00ff88] rounded-full inline-block" />
          <span className="text-[#00ff88] font-bold tracking-widest">AlgoTrader</span>
          <span className="text-[#1e2d40]">//</span>
          <span className="text-[#4a5568] text-xs">{ticker} · SMA 5/20 · {period}</span>
          {lastSig && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold border rounded-sm ${
              lastSig==="BUY"  ? "text-[#00ff88] border-[#00ff88]/30 bg-[#00ff88]/10":
              lastSig==="SELL" ? "text-[#ff4466] border-[#ff4466]/30 bg-[#ff4466]/10":
                                 "text-[#ffd700] border-[#ffd700]/30 bg-[#ffd700]/10"
            }`}>
              <span className="w-1 h-1 rounded-full bg-current animate-pulse" />{lastSig}
            </span>
          )}
        </div>
        <button onClick={doReset}
          className="text-[10px] text-[#4a5568] hover:text-[#ff4466] border border-[#1e2d40] hover:border-[#ff4466]/30 px-3 py-1 rounded-sm transition-colors">
          RESET
        </button>
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 py-4 space-y-4">

        {/* Error */}
        {error && (
          <div className="border border-[#ff4466]/30 bg-[#ff4466]/5 rounded-sm px-4 py-2 text-[#ff4466] text-xs flex justify-between">
            <span>⚠ {error}</span>
            <button onClick={() => setError(null)} className="text-[#4a5568] hover:text-[#ff4466] ml-4">✕</button>
          </div>
        )}

        {/* Stat cards */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <StatCard label="Cash Balance"    value={$(account?.cash_balance   ?? 0)} sub="Available to deploy"       color="border-l-[#00aaff]" />
          <StatCard label="Portfolio Value" value={$(account?.portfolio_value ?? 0)} sub={`${account?.shares_held ?? 0} shares held`} color="border-l-[#00ff88]" />
          <StatCard label="Total PnL"       value={$(account?.total_pnl       ?? 0)} sub="vs $10,000 starting capital" color={pnlPos ? "border-l-[#00ff88]" : "border-l-[#ff4466]"} />
          <div className="bg-[#111827] border border-[#1e2d40] border-l-2 border-l-[#ffd700] rounded-sm p-4">
            <div className="text-[9px] tracking-widest text-[#4a5568] uppercase mb-1">Live Price · {ticker}</div>
            <div className={`text-xl font-bold transition-colors duration-200 ${
              flashDir==="up" ? "text-[#00ff88]" : flashDir==="down" ? "text-[#ff4466]" : "text-[#ffd700]"
            }`}>
              ${displayPrice.toFixed(2)}
            </div>
            <div className={`text-[10px] mt-0.5 flex items-center gap-1 ${displayChg >= 0 ? "text-[#00ff88]" : "text-[#ff4466]"}`}>
              {displayChg >= 0 ? "▲" : "▼"} {Math.abs(displayChg).toFixed(2)}%
              <span className="text-[#4a5568] ml-1">· updates every 3s</span>
            </div>
          </div>
        </div>

        {/* Stock list + Chart */}
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">

          {/* Stock search list */}
          <div className="xl:col-span-1 bg-[#111827] border border-[#1e2d40] rounded-sm flex flex-col" style={{height:500}}>
            <div className="px-3 py-2.5 border-b border-[#1e2d40]">
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search: AAPL, TSLA, NVDA…"
                className="w-full bg-[#0a0e17] border border-[#1e2d40] focus:border-[#00aaff]/50 rounded-sm px-3 py-1.5 text-xs outline-none text-[#e2e8f0] placeholder-[#4a5568]"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredQuotes.map(q => {
                const live = liveMap[q.ticker];
                const price = live?.price ?? q.price;
                const chg   = live?.change_pct ?? q.change_pct;
                return (
                  <button key={q.ticker} onClick={() => { setTicker(q.ticker); addLog(`Selected ${q.ticker}`); }}
                    className={`w-full px-3 py-2 flex items-center justify-between hover:bg-[#1e2d40]/40 transition-colors border-b border-[#1e2d40]/30 text-left ${
                      ticker === q.ticker ? "bg-[#1e2d40]/60 border-l-2 border-l-[#00ff88]" : ""
                    }`}>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[#00aaff]">{q.ticker}</div>
                      <div className="text-[9px] text-[#4a5568] truncate max-w-[130px]">{q.name}</div>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <div className="text-xs font-bold">${price.toFixed(2)}</div>
                      <div className={`text-[9px] ${chg >= 0 ? "text-[#00ff88]" : "text-[#ff4466]"}`}>
                        {chg >= 0 ? "+" : ""}{chg.toFixed(2)}%
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Chart panel */}
          <div className="xl:col-span-3 bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            {/* Toolbar */}
            <div className="px-4 py-2.5 border-b border-[#1e2d40] flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-[#00aaff]">{ticker}</span>
                {chart && (
                  <>
                    <span className={`text-base font-bold transition-colors ${flashDir==="up"?"text-[#00ff88]":flashDir==="down"?"text-[#ff4466]":"text-[#e2e8f0]"}`}>
                      ${displayPrice.toFixed(2)}
                    </span>
                    <span className={`text-xs font-bold ${displayChg >= 0 ? "text-[#00ff88]" : "text-[#ff4466]"}`}>
                      {displayChg >= 0 ? "▲" : "▼"} {Math.abs(displayChg).toFixed(2)}%
                    </span>
                    <span className="text-[10px] text-[#4a5568] hidden sm:inline">{chart.company_name}</span>
                    {chart.is_simulated && (
                      <span className="text-[9px] text-[#ffd700] border border-[#ffd700]/30 px-1.5 py-0.5 rounded-sm">SIM</span>
                    )}
                  </>
                )}
                {cLoading && <span className="w-3 h-3 border border-[#4a5568] border-t-[#00aaff] rounded-full animate-spin inline-block" />}
              </div>
              <div className="flex items-center gap-1">
                {PERIODS.map(p => (
                  <button key={p.value} onClick={() => setPeriod(p.value)}
                    className={`px-2.5 py-1 text-[10px] font-bold rounded-sm border transition-colors ${
                      period === p.value
                        ? "text-[#00aaff] bg-[#00aaff]/15 border-[#00aaff]/40"
                        : "text-[#4a5568] border-transparent hover:text-[#e2e8f0]"
                    }`}>{p.label}</button>
                ))}
              </div>
            </div>

            {/* TradingView chart */}
            <div className="p-3">
              {cLoading ? (
                <div className="tv-chart flex items-center justify-center text-[#4a5568] text-xs gap-2">
                  <span className="w-4 h-4 border border-[#4a5568] border-t-[#00aaff] rounded-full animate-spin" />
                  Loading chart data…
                </div>
              ) : chart && chart.bars.length > 0 ? (
                <Suspense fallback={<div className="tv-chart flex items-center justify-center text-[#4a5568] text-xs">Initialising chart…</div>}>
                  <TradingChart
                    bars={chart.bars}
                    livePrice={liveTick?.price ?? null}
                    ticker={ticker}
                  />
                </Suspense>
              ) : (
                <div className="tv-chart flex items-center justify-center text-[#4a5568] text-xs">
                  No chart data — select a stock from the list
                </div>
              )}
            </div>

            {/* Legend */}
            <div className="px-4 py-1.5 border-t border-[#1e2d40] flex items-center gap-4 text-[10px] text-[#4a5568]">
              <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5 bg-[#00aaff]" />Fast SMA (5)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5 bg-[#ffd700]" />Slow SMA (20)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 bg-[#00ff88] rounded-sm opacity-80" />Bullish candle</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 border border-[#ff4466] rounded-sm" />Bearish candle</span>
            </div>

            {/* Strategy button */}
            <div className="px-4 pb-4 pt-2 flex items-center gap-4 flex-wrap">
              <button onClick={runStrategy} disabled={running}
                className={`px-6 py-2.5 text-xs font-bold tracking-widest uppercase border rounded-sm transition-all ${
                  running ? "border-[#1e2d40] text-[#4a5568] cursor-not-allowed"
                           : "border-[#00ff88] text-[#00ff88] hover:bg-[#00ff88]/10 active:scale-95"
                }`}>
                {running
                  ? <span className="flex items-center gap-2"><span className="w-3 h-3 border border-[#4a5568] border-t-transparent rounded-full animate-spin" />EVALUATING…</span>
                  : `▶  RUN STRATEGY ON ${ticker}`}
              </button>
            </div>
          </div>
        </div>

        {/* Ledger + Log */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Ledger */}
          <div className="xl:col-span-2 bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#1e2d40] flex justify-between">
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">Execution Ledger</span>
              <span className="text-[9px] text-[#4a5568]">{trades.length} trades</span>
            </div>
            {trades.length === 0
              ? <div className="py-12 text-center text-[#4a5568] text-xs">No trades yet — run the strategy to execute your first trade.</div>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-[9px] text-[#4a5568] uppercase tracking-widest border-b border-[#1e2d40]">
                      {["Time","Ticker","Side","Price","Shares","PnL","Cash After"].map(h => (
                        <th key={h} className={`px-3 py-2 ${["Price","Shares","PnL","Cash After"].includes(h)?"text-right":"text-left"}`}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {trades.map(t => (
                        <tr key={t.id} className="border-b border-[#1e2d40]/30 hover:bg-[#1e2d40]/20 transition-colors">
                          <td className="px-3 py-2 text-[#4a5568] text-[10px]">{dt(t.executed_at)}</td>
                          <td className="px-3 py-2 text-[#00aaff] font-bold">{t.ticker}</td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded-sm ${
                              t.action==="BUY" ? "bg-[#00ff88]/10 text-[#00ff88]" : "bg-[#ff4466]/10 text-[#ff4466]"
                            }`}>{t.action}</span>
                          </td>
                          <td className="px-3 py-2 text-right">{$(t.price)}</td>
                          <td className="px-3 py-2 text-right">{t.shares}</td>
                          <td className={`px-3 py-2 text-right font-bold ${
                            t.pnl==null?"text-[#4a5568]":t.pnl>=0?"text-[#00ff88]":"text-[#ff4466]"
                          }`}>{t.pnl!=null?$(t.pnl):"—"}</td>
                          <td className="px-3 py-2 text-right text-[#4a5568]">{$(t.cash_after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>

          {/* System Log */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-sm flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#1e2d40] flex items-center gap-2">
              <span className="live-dot w-1.5 h-1.5 bg-[#00ff88] rounded-full" />
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">System Log</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1" style={{maxHeight:300}}>
              {log.map((e, i) => (
                <p key={i} className={`text-[10px] leading-relaxed ${
                  e.includes("ERROR") ? "text-[#ff4466]" :
                  e.includes("BUY") || e.includes("SELL") || e.includes("online") ? "text-[#00ff88]" :
                  e.includes("WS") ? "text-[#00aaff]" : "text-[#4a5568]"
                }`}>{e}</p>
              ))}
            </div>
          </div>
        </div>

        {/* ── Strategy Rules + Metrics explainer ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

          {/* Strategy Rules */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1e2d40]">
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">⚡ Strategy Rules — How The Algorithm Works</span>
            </div>
            <div className="p-4 space-y-3">
              <div className="border border-[#1e2d40] rounded-sm p-3 space-y-2.5">
                <p className="text-[9px] text-[#00aaff] font-bold uppercase tracking-widest">The Two Lines</p>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-0.5 bg-[#00aaff] rounded mt-2 shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-[#e2e8f0]">Fast SMA — Blue (5-period)</p>
                    <p className="text-[10px] text-[#4a5568]">Average of last 5 closes. Reacts quickly. Represents <span className="text-[#e2e8f0]">short-term momentum</span>.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-0.5 bg-[#ffd700] rounded mt-2 shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-[#e2e8f0]">Slow SMA — Yellow (20-period)</p>
                    <p className="text-[10px] text-[#4a5568]">Average of last 20 closes. Moves slowly. Represents <span className="text-[#e2e8f0]">medium-term trend</span>.</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                {[
                  { sig:"BUY",  col:"[#00ff88]", border:"[#00ff88]/20", bg:"[#00ff88]/5",  title:"Fast crosses ABOVE Slow", desc:"Bullish crossover — algorithm buys 10 shares, deducts cost from cash balance." },
                  { sig:"SELL", col:"[#ff4466]", border:"[#ff4466]/20", bg:"[#ff4466]/5",  title:"Fast crosses BELOW Slow", desc:"Bearish crossover — algorithm sells 10 shares, adds proceeds, calculates PnL." },
                  { sig:"HOLD", col:"[#ffd700]", border:"[#ffd700]/20", bg:"[#ffd700]/5",  title:"No crossover on latest bar", desc:"Relationship unchanged — no trade executed. Algorithm only fires at the exact moment of a crossover." },
                ].map(r => (
                  <div key={r.sig} className={`flex items-start gap-3 bg-${r.bg} border border-${r.border} rounded-sm p-2.5`}>
                    <span className={`text-${r.col} font-bold text-[10px] bg-${r.col}/15 px-2 py-0.5 rounded-sm shrink-0`}>{r.sig}</span>
                    <div>
                      <p className="text-xs font-bold text-[#e2e8f0]">{r.title}</p>
                      <p className="text-[10px] text-[#4a5568]">{r.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="bg-[#0a0e17] border border-[#1e2d40] rounded-sm px-3 py-2">
                <p className="text-[10px] text-[#4a5568]">💡 Uses pandas <span className="text-[#e2e8f0]">.diff()</span> on the crossover position — fires only at the <span className="text-[#e2e8f0]">exact bar the relationship changes</span>, preventing over-trading.</p>
              </div>
            </div>
          </div>

          {/* Metrics */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1e2d40]">
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">$ Dashboard Metrics — What Each Number Means</span>
            </div>
            <div className="p-4 space-y-3">
              {[
                { col:"[#00aaff]", label:"Cash Balance", tag:"starts at $10,000", desc:"Your liquid money not invested. Goes DOWN on BUY (spent on shares), UP on SELL (received from sale). Like your bank account balance." },
                { col:"[#00ff88]", label:"Portfolio Value", tag:"Cash + Shares × Price", desc:"Total net worth = Cash Balance + current market value of all shares held. Moves up/down with the stock price even without trading." },
                { col:"[#ffd700]", label:"Total PnL (Profit & Loss)", tag:"Portfolio − $10,000", desc:"Bottom line — how much you've made or lost vs your $10,000 starting capital. Green = profitable, Red = losing. Per-trade PnL = (sell price − buy price) × shares." },
              ].map(m => (
                <div key={m.label} className={`border border-${m.col}/20 bg-${m.col}/5 rounded-sm p-3`}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className={`w-2 h-2 rounded-full bg-${m.col}`} />
                    <p className={`text-xs font-bold text-${m.col}`}>{m.label}</p>
                    <span className="text-[9px] text-[#4a5568] ml-auto">{m.tag}</span>
                  </div>
                  <p className="text-[10px] text-[#4a5568]">{m.desc}</p>
                </div>
              ))}
              <div className="bg-[#0a0e17] border border-[#1e2d40] rounded-sm px-3 py-2">
                <p className="text-[10px] text-[#4a5568]">💡 Strategy makes money by <span className="text-[#00ff88]">BUYing low</span> and <span className="text-[#ff4466]">SELLing high</span> on momentum crossovers. Won't be right every time — but over many trades the win rate should beat random buying.</p>
              </div>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}