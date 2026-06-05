"use client";
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";

const TradingChart = lazy(() => import("../components/TradingChart"));

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Account { id:number; cash_balance:number; shares_held:number; ticker:string; portfolio_value:number; total_pnl:number }
interface Trade   { id:number; ticker:string; action:string; price:number; shares:number; pnl:number|null; cash_after:number; fast_sma:number|null; slow_sma:number|null; signal_reason:string|null; executed_at:string }
interface Bar     { time:string; open:number; high:number; low:number; close:number; volume:number; fast_sma:number|null; slow_sma:number|null }
interface ChartData { ticker:string; company_name:string; current_price:number; change:number; change_pct:number; bars:Bar[]; is_simulated:boolean }
interface Quote   { ticker:string; name:string; price:number; change:number; change_pct:number; sector:string; is_simulated:boolean }
interface StrategyResult { signal:string; message:string; current_price:number; fast_sma:number; slow_sma:number; account:Account; trade:Trade|null }

const PERIODS = [
  {label:"1M",value:"1mo"},{label:"3M",value:"3mo"},
  {label:"6M",value:"6mo"},{label:"1Y",value:"1y"},{label:"2Y",value:"2y"},
];

const BANNER = ["AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","JPM","NFLX","AMD","V","ADBE","CRM","ORCL","MA","GS","AVGO","IBM"];

const $f = (v:number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(v);
const tf = (s:string) => new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

// ── Ticker Tape ───────────────────────────────────────────────────────────────
function TickerTape({ quotes }:{ quotes: Quote[] }) {
  const map = Object.fromEntries(quotes.map(q => [q.ticker, q]));
  const visible = BANNER.filter(t => map[t]);
  if (!visible.length) return (
    <div className="h-7 border-b border-[#1e2d40] bg-[#080c14] flex items-center px-4">
      <span className="text-[10px] text-[#4a5568]">Loading market data…</span>
    </div>
  );
  const doubled = [...visible, ...visible];
  return (
    <div className="h-7 border-b border-[#1e2d40] bg-[#080c14] overflow-hidden flex items-center">
      <div className="ticker-tape flex whitespace-nowrap">
        {doubled.map((t, i) => {
          const q = map[t]; if (!q) return null;
          const up = q.change_pct >= 0;
          return (
            <span key={i} className="inline-flex items-center gap-1.5 px-3 text-[10px] font-mono">
              <span className="text-[#00aaff] font-bold">{t}</span>
              <span className="text-[#e2e8f0]">${q.price.toFixed(2)}</span>
              <span className={up ? "text-[#00ff88]" : "text-[#ff4466]"}>
                {up ? "▲" : "▼"}{Math.abs(q.change_pct).toFixed(2)}%
              </span>
              <span className="text-[#1e2d40] ml-1">·</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [account,     setAccount]     = useState<Account|null>(null);
  const [trades,      setTrades]      = useState<Trade[]>([]);
  const [quotes,      setQuotes]      = useState<Quote[]>([]);
  const [chart,       setChart]       = useState<ChartData|null>(null);
  const [ticker,      setTicker]      = useState("AAPL");
  const [period,      setPeriod]      = useState("3mo");
  const [livePrice,   setLivePrice]   = useState<number|null>(null);
  const [liveFlash,   setLiveFlash]   = useState<"up"|"down"|null>(null);
  const [running,     setRunning]     = useState(false);
  const [chartLoading,setChartLoading]= useState(false);
  const [booting,     setBooting]     = useState(true);
  const [search,      setSearch]      = useState("");
  const [error,       setError]       = useState<string|null>(null);
  const [log,         setLog]         = useState<string[]>([]);
  const [lastSignal,  setLastSignal]  = useState<string|null>(null);
  const prevLive      = useRef<number>(0);
  const isFirstChart  = useRef(true);
  const searchTimer   = useRef<ReturnType<typeof setTimeout>>();

  const addLog = (msg:string) => {
    const ts = new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    setLog(p => [`[${ts}] ${msg}`, ...p].slice(0,60));
  };

  const fetchAccount = useCallback(async () => {
    const r = await fetch(`${API}/api/v1/account`);
    if (!r.ok) throw new Error("Account fetch failed");
    return r.json() as Promise<Account>;
  }, []);

  const fetchTrades = useCallback(async () => {
    const r = await fetch(`${API}/api/v1/trades`);
    if (!r.ok) throw new Error("Trades fetch failed");
    return r.json() as Promise<Trade[]>;
  }, []);

  const fetchQuotes = useCallback(async (q:string="") => {
    const r = await fetch(`${API}/api/v1/quotes?q=${encodeURIComponent(q)}`);
    if (!r.ok) return;
    const data = await r.json() as Quote[];
    setQuotes(data);
  }, []);

  const loadChart = useCallback(async (t:string, p:string) => {
    setChartLoading(true);
    setLivePrice(null);
    try {
      const r = await fetch(`${API}/api/v1/chart/${t}?period=${p}`);
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail ?? "Chart error"); }
      const d = await r.json() as ChartData;
      setChart(d);
      prevLive.current = d.current_price;
      addLog(`${t} chart loaded (${p}) — ${d.bars.length} bars${d.is_simulated?" [sim]":""}`);
    } catch(e:unknown) {
      addLog(`Chart error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setChartLoading(false);
    }
  }, []);

  // Boot
  useEffect(() => {
    (async () => {
      addLog("Connecting to AlgoTrader engine…");
      try {
        const [a, t] = await Promise.all([fetchAccount(), fetchTrades()]);
        setAccount(a); setTrades(t);
        addLog(`Engine online — balance: ${$f(a.cash_balance)}`);
        await Promise.all([loadChart("AAPL","3mo"), fetchQuotes("")]);
      } catch(e:unknown) {
        const msg = e instanceof Error ? e.message : "Connection failed";
        setError(msg); addLog(`ERROR: ${msg}`);
      } finally { setBooting(false); }
    })();
  }, [fetchAccount, fetchTrades, loadChart, fetchQuotes]);

  // Reload chart when ticker or period changes (skip first render)
  useEffect(() => {
    if (isFirstChart.current) { isFirstChart.current = false; return; }
    loadChart(ticker, period);
  }, [ticker, period, loadChart]);

  // Refresh quotes periodically (every 30s)
  useEffect(() => {
    const id = setInterval(() => fetchQuotes(search), 30_000);
    return () => clearInterval(id);
  }, [fetchQuotes, search]);

  // Search debounce
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchQuotes(search), 400);
  }, [search, fetchQuotes]);

  // Handle live price update from WebSocket (passed up from TradingChart)
  const handlePriceUpdate = useCallback((price:number) => {
    setLivePrice(prev => {
      const dir = prev !== null ? (price > prev ? "up" : price < prev ? "down" : null) : null;
      if (dir && price !== prevLive.current) {
        setLiveFlash(dir);
        setTimeout(() => setLiveFlash(null), 600);
      }
      prevLive.current = price;
      return price;
    });
  }, []);

  const runStrategy = async () => {
    if (running) return;
    setRunning(true); setError(null);
    addLog(`Running strategy on ${ticker}…`);
    try {
      const r = await fetch(`${API}/api/v1/run-strategy?ticker=${ticker}`,{method:"POST"});
      if (!r.ok) { const e = await r.json(); throw new Error(e.detail ?? "Strategy failed"); }
      const res:StrategyResult = await r.json();
      setLastSignal(res.signal);
      setAccount(res.account);
      setTrades(await fetchTrades());
      addLog(`Signal: ${res.signal} | ${ticker} @ ${$f(res.current_price)}`);
      if (res.trade) addLog(`${res.trade.action} executed — ${res.trade.shares} shares @ ${$f(res.trade.price)}`);
      await loadChart(ticker, period);
    } catch(e:unknown) {
      const msg = e instanceof Error ? e.message : "Unknown"; setError(msg); addLog(`ERROR: ${msg}`);
    } finally { setRunning(false); }
  };

  const doReset = async () => {
    if (!confirm("Reset account to $10,000 and clear all trades?")) return;
    await fetch(`${API}/api/v1/reset-account`,{method:"POST"});
    const [a,t] = await Promise.all([fetchAccount(),fetchTrades()]);
    setAccount(a); setTrades(t); setLastSignal(null); setLivePrice(null);
    addLog("Account reset to $10,000.");
  };

  const displayPrice = livePrice ?? chart?.current_price ?? 0;
  const displayChgPct = chart?.change_pct ?? 0;
  const pnlPos = (account?.total_pnl ?? 0) >= 0;

  const filteredQuotes = quotes.filter(q =>
    !search || q.ticker.includes(search.toUpperCase()) || q.name.toLowerCase().includes(search.toLowerCase())
  );

  if (booting) return (
    <div className="min-h-screen bg-[#0a0e17] flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="text-[#00ff88] text-4xl font-bold font-mono animate-pulse">LOADING</div>
        <div className="text-[#4a5568] text-xs font-mono tracking-widest">CONNECTING TO ENGINE…</div>
        <div className="flex items-center justify-center gap-1">
          {[0,1,2].map(i => (
            <div key={i} className="w-2 h-2 bg-[#00ff88] rounded-full animate-bounce" style={{animationDelay:`${i*150}ms`}} />
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0a0e17] text-[#e2e8f0] font-mono text-xs">

      {/* ── Ticker tape ── */}
      <TickerTape quotes={quotes} />

      {/* ── Header ── */}
      <header className="border-b border-[#1e2d40] px-5 py-3 flex items-center justify-between bg-[#0d1220]">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="live-blink w-2 h-2 bg-[#00ff88] rounded-full inline-block" />
            <span className="text-[#00ff88] font-bold tracking-widest text-sm">AlgoTrader</span>
          </div>
          <span className="text-[#1e2d40]">//</span>
          <span className="text-[#4a5568]">{ticker} · SMA 5/20 · {period}</span>
          {lastSignal && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 font-bold border rounded-sm ${
              lastSignal==="BUY"  ? "text-[#00ff88] border-[#00ff88]/40 bg-[#00ff88]/10" :
              lastSignal==="SELL" ? "text-[#ff4466] border-[#ff4466]/40 bg-[#ff4466]/10" :
                                    "text-[#ffd700] border-[#ffd700]/40 bg-[#ffd700]/10"
            }`}>
              <span className="w-1 h-1 rounded-full bg-current animate-pulse" />
              {lastSignal}
            </span>
          )}
        </div>
        <button onClick={doReset}
          className="text-[10px] text-[#4a5568] hover:text-[#ff4466] border border-[#1e2d40] hover:border-[#ff4466]/40 px-3 py-1.5 rounded-sm transition-all">
          RESET
        </button>
      </header>

      <main className="max-w-screen-2xl mx-auto px-4 py-4 space-y-4">

        {/* Error banner */}
        {error && (
          <div className="border border-[#ff4466]/30 bg-[#ff4466]/5 rounded-sm px-4 py-2 text-[#ff4466] flex justify-between items-center">
            <span>⚠ {error}</span>
            <button onClick={() => setError(null)} className="ml-4 text-[#4a5568] hover:text-[#ff4466]">✕</button>
          </div>
        )}

        {/* ── Stat Cards ── */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {[
            { label:"Cash Balance",    val:$f(account?.cash_balance??0),   sub:"Available to deploy",              bl:"border-l-[#00aaff]", tc:"text-[#00aaff]" },
            { label:"Portfolio Value", val:$f(account?.portfolio_value??0), sub:`${account?.shares_held??0} shares held`, bl:"border-l-[#00ff88]", tc:"text-[#00ff88]" },
            { label:"Total PnL",       val:$f(account?.total_pnl??0),       sub:"vs $10,000 starting capital",      bl:pnlPos?"border-l-[#00ff88]":"border-l-[#ff4466]", tc:pnlPos?"text-[#00ff88]":"text-[#ff4466]" },
            { label:`Live · ${ticker}`,
              val: `$${displayPrice.toFixed(2)}`,
              sub: `${displayChgPct>=0?"+":""}${displayChgPct.toFixed(2)}% · ticks every 2s`,
              bl: (liveFlash==="up"||displayChgPct>=0)?"border-l-[#ffd700]":"border-l-[#ff4466]",
              tc: liveFlash==="up"?"text-[#00ff88]":liveFlash==="down"?"text-[#ff4466]":"text-[#ffd700]",
              flash: liveFlash },
          ].map((c,i) => (
            <div key={i} className={`bg-[#111827] border border-[#1e2d40] border-l-2 ${c.bl} rounded-sm p-4 transition-all ${
              (c as any).flash==="up"?"flash-green":(c as any).flash==="down"?"flash-red":""
            }`}>
              <div className="text-[9px] tracking-widest text-[#4a5568] uppercase mb-1">{c.label}</div>
              <div className={`text-xl font-bold ${c.tc} transition-colors duration-200`}>{c.val}</div>
              <div className="text-[10px] text-[#4a5568] mt-0.5">{c.sub}</div>
            </div>
          ))}
        </div>

        {/* ── Stock list + Chart ── */}
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">

          {/* Stock list */}
          <div className="xl:col-span-1 bg-[#111827] border border-[#1e2d40] rounded-sm flex flex-col" style={{height:520}}>
            <div className="px-3 py-2.5 border-b border-[#1e2d40]">
              <input
                value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Search: AAPL, TSLA…"
                className="w-full bg-[#0a0e17] border border-[#1e2d40] focus:border-[#00aaff]/50 rounded-sm px-3 py-1.5 text-xs outline-none text-[#e2e8f0] placeholder-[#4a5568]"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredQuotes.length===0 && (
                <div className="px-4 py-4 text-[10px] text-[#4a5568]">Loading quotes…</div>
              )}
              {filteredQuotes.map(q => (
                <button key={q.ticker} onClick={() => { setTicker(q.ticker); addLog(`Selected ${q.ticker}`); }}
                  className={`w-full px-3 py-2.5 flex items-center justify-between hover:bg-[#1a2535] transition-colors border-b border-[#1e2d40]/40 text-left ${
                    ticker===q.ticker ? "bg-[#1a2535] border-l-2 border-l-[#00ff88]" : ""
                  }`}>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-[#00aaff]">{q.ticker}</div>
                    <div className="text-[9px] text-[#4a5568] truncate max-w-[130px]">{q.name}</div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <div className="text-xs font-bold text-[#e2e8f0]">${q.price.toFixed(2)}</div>
                    <div className={`text-[9px] ${q.change_pct>=0?"text-[#00ff88]":"text-[#ff4466]"}`}>
                      {q.change_pct>=0?"+":""}{q.change_pct.toFixed(2)}%
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Chart panel */}
          <div className="xl:col-span-3 bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            {/* Chart toolbar */}
            <div className="px-4 py-2.5 border-b border-[#1e2d40] flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-[#00aaff]">{ticker}</span>
                {chart && (
                  <>
                    <span className={`text-base font-bold transition-colors duration-150 ${
                      liveFlash==="up"?"text-[#00ff88]":liveFlash==="down"?"text-[#ff4466]":"text-[#e2e8f0]"
                    }`}>${displayPrice.toFixed(2)}</span>
                    <span className={`font-bold ${displayChgPct>=0?"text-[#00ff88]":"text-[#ff4466]"}`}>
                      {displayChgPct>=0?"▲":"▼"} {Math.abs(displayChgPct).toFixed(2)}%
                    </span>
                    <span className="text-[#4a5568] hidden sm:inline">{chart.company_name}</span>
                    {chart.is_simulated && (
                      <span className="text-[9px] text-[#ffd700] border border-[#ffd700]/30 px-1.5 py-0.5 rounded-sm">SIM</span>
                    )}
                    <span className="flex items-center gap-1 text-[9px] text-[#4a5568]">
                      <span className="live-blink w-1.5 h-1.5 bg-[#00ff88] rounded-full inline-block" />
                      LIVE
                    </span>
                  </>
                )}
                {chartLoading && <span className="w-3 h-3 border border-[#4a5568] border-t-[#00aaff] rounded-full animate-spin inline-block" />}
              </div>
              {/* Period selector */}
              <div className="flex gap-1">
                {PERIODS.map(p => (
                  <button key={p.value} onClick={() => setPeriod(p.value)}
                    className={`px-2.5 py-1 font-bold rounded-sm border transition-all ${
                      period===p.value
                        ? "text-[#00aaff] bg-[#00aaff]/15 border-[#00aaff]/40"
                        : "text-[#4a5568] border-transparent hover:text-[#e2e8f0] hover:border-[#1e2d40]"
                    }`}>{p.label}</button>
                ))}
              </div>
            </div>

            {/* TradingView Lightweight Chart */}
            <div className="relative">
              {chartLoading ? (
                <div className="flex items-center justify-center bg-[#111827]" style={{height:400}}>
                  <div className="text-center space-y-2">
                    <div className="w-8 h-8 border-2 border-[#1e2d40] border-t-[#00aaff] rounded-full animate-spin mx-auto" />
                    <div className="text-[#4a5568] text-xs">Loading {ticker} chart…</div>
                  </div>
                </div>
              ) : chart && chart.bars.length > 0 ? (
                <Suspense fallback={
                  <div className="flex items-center justify-center bg-[#111827]" style={{height:400}}>
                    <span className="text-[#4a5568] text-xs">Initialising chart engine…</span>
                  </div>
                }>
                  <TradingChart
                    bars={chart.bars}
                    ticker={ticker}
                    onPriceUpdate={handlePriceUpdate}
                  />
                </Suspense>
              ) : (
                <div className="flex items-center justify-center bg-[#111827]" style={{height:400}}>
                  <span className="text-[#4a5568] text-xs">Select a stock to view chart</span>
                </div>
              )}
            </div>

            {/* Legend */}
            <div className="px-4 py-2 border-t border-[#1e2d40] flex items-center gap-5 text-[9px] text-[#4a5568] flex-wrap">
              <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-0.5 bg-[#00aaff]"/>Fast SMA (5)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-5 h-0.5 bg-[#ffd700]"/>Slow SMA (20)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 bg-[#00ff88] rounded-sm opacity-80"/>Bullish</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 border border-[#ff4466] rounded-sm"/>Bearish</span>
              <span className="ml-auto flex items-center gap-1">
                <span className="live-blink w-1.5 h-1.5 bg-[#00ff88] rounded-full inline-block"/>
                Last candle updates live via WebSocket every 2s
              </span>
            </div>

            {/* Strategy trigger */}
            <div className="px-4 pb-4 pt-2 flex items-center gap-4 flex-wrap">
              <button onClick={runStrategy} disabled={running}
                className={`px-6 py-2.5 font-bold tracking-widest uppercase border rounded-sm transition-all ${
                  running ? "border-[#1e2d40] text-[#4a5568] cursor-not-allowed"
                           : "border-[#00ff88] text-[#00ff88] hover:bg-[#00ff88]/10 hover:shadow-[0_0_20px_rgba(0,255,136,0.15)] active:scale-95"
                }`}>
                {running
                  ? <span className="flex items-center gap-2">
                      <span className="w-3 h-3 border border-[#4a5568] border-t-[#00ff88] rounded-full animate-spin"/>
                      EVALUATING MARKET…
                    </span>
                  : `▶  RUN STRATEGY ON ${ticker}`}
              </button>
              {lastSignal && chart && (
                <span className="text-[10px] text-[#4a5568]">
                  Last: {lastSignal} @ ${displayPrice.toFixed(2)} — F:{chart.bars[chart.bars.length-1]?.fast_sma?.toFixed(2)} S:{chart.bars[chart.bars.length-1]?.slow_sma?.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Ledger + Log ── */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Ledger */}
          <div className="xl:col-span-2 bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#1e2d40] flex justify-between items-center">
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">Execution Ledger</span>
              <span className="text-[9px] text-[#4a5568]">{trades.length} trades</span>
            </div>
            {trades.length===0
              ? <div className="py-14 text-center text-[#4a5568]">No trades yet — run the strategy to execute your first trade.</div>
              : <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead><tr className="text-[9px] text-[#4a5568] uppercase tracking-widest border-b border-[#1e2d40]">
                      {["Time","Ticker","Side","Price","Shares","PnL","Cash After"].map(h=>(
                        <th key={h} className={`px-3 py-2 ${["Price","Shares","PnL","Cash After"].includes(h)?"text-right":"text-left"}`}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {trades.map(t=>(
                        <tr key={t.id} className="border-b border-[#1e2d40]/30 hover:bg-[#1a2535] transition-colors">
                          <td className="px-3 py-2.5 text-[#4a5568]">{tf(t.executed_at)}</td>
                          <td className="px-3 py-2.5 text-[#00aaff] font-bold">{t.ticker}</td>
                          <td className="px-3 py-2.5">
                            <span className={`px-2 py-0.5 font-bold rounded-sm ${t.action==="BUY"?"bg-[#00ff88]/10 text-[#00ff88]":"bg-[#ff4466]/10 text-[#ff4466]"}`}>{t.action}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right">{$f(t.price)}</td>
                          <td className="px-3 py-2.5 text-right">{t.shares}</td>
                          <td className={`px-3 py-2.5 text-right font-bold ${t.pnl==null?"text-[#4a5568]":t.pnl>=0?"text-[#00ff88]":"text-[#ff4466]"}`}>
                            {t.pnl!=null?$f(t.pnl):"—"}
                          </td>
                          <td className="px-3 py-2.5 text-right text-[#4a5568]">{$f(t.cash_after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
            }
          </div>

          {/* System Log */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-sm flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[#1e2d40] flex items-center gap-2">
              <span className="live-blink w-1.5 h-1.5 bg-[#00ff88] rounded-full inline-block"/>
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">System Log</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1" style={{maxHeight:300}}>
              {log.map((e,i)=>(
                <p key={i} className={`leading-relaxed ${
                  e.includes("ERROR") ? "text-[#ff4466]" :
                  e.includes("BUY")||e.includes("SELL")||e.includes("online") ? "text-[#00ff88]" :
                  e.includes("WS")||e.includes("chart") ? "text-[#00aaff]" :
                  "text-[#4a5568]"
                }`}>{e}</p>
              ))}
            </div>
          </div>
        </div>

        {/* ── Strategy Rules + Metrics ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

          {/* Strategy Rules */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1e2d40]">
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">⚡ Strategy Rules — How The Algorithm Works</span>
            </div>
            <div className="p-4 space-y-3">
              <div className="border border-[#1e2d40] rounded-sm p-3 space-y-2.5">
                <p className="text-[9px] text-[#00aaff] font-bold uppercase tracking-widest">The Two Lines On The Chart</p>
                <div className="flex items-start gap-3">
                  <span className="inline-block w-5 h-0.5 bg-[#00aaff] mt-2 shrink-0"/>
                  <div>
                    <p className="font-bold text-[#e2e8f0]">Fast SMA — Blue Line (5-period)</p>
                    <p className="text-[#4a5568] mt-0.5">Average of the last 5 closing prices. Reacts quickly to price moves. Represents <span className="text-[#e2e8f0]">short-term momentum</span> — what the stock is doing RIGHT NOW.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="inline-block w-5 h-0.5 bg-[#ffd700] mt-2 shrink-0"/>
                  <div>
                    <p className="font-bold text-[#e2e8f0]">Slow SMA — Yellow Line (20-period)</p>
                    <p className="text-[#4a5568] mt-0.5">Average of the last 20 closing prices. Moves slowly, filters out noise. Represents the <span className="text-[#e2e8f0]">medium-term trend</span>.</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                {[
                  {sig:"BUY",  bg:"bg-[#00ff88]/5",  border:"border-[#00ff88]/20", tc:"text-[#00ff88]", bc:"bg-[#00ff88]/15", title:"Fast crosses ABOVE Slow", desc:"Bullish crossover — short-term momentum stronger than trend. Algorithm buys 10 shares, cost deducted from cash."},
                  {sig:"SELL", bg:"bg-[#ff4466]/5",  border:"border-[#ff4466]/20", tc:"text-[#ff4466]", bc:"bg-[#ff4466]/15", title:"Fast crosses BELOW Slow",  desc:"Bearish crossover — momentum fading. Algorithm sells 10 shares, proceeds added to cash, PnL calculated."},
                  {sig:"HOLD", bg:"bg-[#ffd700]/5",  border:"border-[#ffd700]/20", tc:"text-[#ffd700]", bc:"bg-[#ffd700]/15", title:"No crossover on latest bar", desc:"Relationship unchanged — no trade. Algorithm fires only at the exact moment of a crossover, never continuously."},
                ].map(r => (
                  <div key={r.sig} className={`flex items-start gap-3 ${r.bg} border ${r.border} rounded-sm p-2.5`}>
                    <span className={`font-bold ${r.tc} ${r.bc} px-2 py-0.5 rounded-sm shrink-0`}>{r.sig}</span>
                    <div>
                      <p className="font-bold text-[#e2e8f0]">{r.title}</p>
                      <p className="text-[#4a5568] mt-0.5">{r.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="bg-[#0a0e17] border border-[#1e2d40] rounded-sm px-3 py-2">
                <p className="text-[#4a5568]">💡 Pandas <span className="text-[#e2e8f0]">.diff()</span> on the crossover position fires only at the <span className="text-[#e2e8f0]">exact bar the relationship changes</span> — prevents over-trading.</p>
              </div>
            </div>
          </div>

          {/* Metrics Explainer */}
          <div className="bg-[#111827] border border-[#1e2d40] rounded-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1e2d40]">
              <span className="text-[9px] tracking-widest text-[#4a5568] uppercase">$ Dashboard Metrics — What Each Number Means</span>
            </div>
            <div className="p-4 space-y-3">
              {[
                {col:"[#00aaff]", label:"Cash Balance",          tag:"starts at $10,000",       desc:"Your liquid money not invested in any stock. Goes DOWN on BUY (spent on shares), UP on SELL (cash received). Think of it like your bank account balance."},
                {col:"[#00ff88]", label:"Portfolio Value",        tag:"Cash + Shares × Price",   desc:"Total net worth = Cash Balance + current market value of all shares held. Fluctuates with the stock price even without any trades being made."},
                {col:"[#ffd700]", label:"Total PnL (Profit & Loss)", tag:"Portfolio − $10,000", desc:"The bottom line — how much you've made or lost vs your $10,000 starting capital. Green = profitable, Red = losing. Per-trade PnL in the ledger = (sell price − buy price) × shares."},
              ].map(m => (
                <div key={m.label} className={`border border-${m.col}/20 bg-${m.col}/5 rounded-sm p-3`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className={`w-2 h-2 rounded-full bg-${m.col} shrink-0`}/>
                    <p className={`font-bold text-${m.col}`}>{m.label}</p>
                    <span className="text-[9px] text-[#4a5568] ml-auto">{m.tag}</span>
                  </div>
                  <p className="text-[#4a5568] leading-relaxed">{m.desc}</p>
                </div>
              ))}
              <div className="bg-[#0a0e17] border border-[#1e2d40] rounded-sm px-3 py-2">
                <p className="text-[#4a5568]">💡 Strategy profits by <span className="text-[#00ff88]">BUYing on upward crossovers</span> and <span className="text-[#ff4466]">SELLing on downward ones</span>. Won't be right every trade — but statistically beats random over many trades.</p>
              </div>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}