"""
AlgoTrader — Production Backend
Serves FastAPI (JSON + WebSocket) AND the Next.js static build from one process.
Single Render Web Service — no Vercel needed.
"""
import os, asyncio, random, logging, math
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Set

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Depends, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime, Text, func
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./trading.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine       = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base         = declarative_base()

class Account(Base):
    __tablename__ = "accounts"
    id           = Column(Integer, primary_key=True)
    cash_balance = Column(Float, default=10_000.0)
    shares_held  = Column(Float, default=0.0)
    ticker       = Column(String(10), default="AAPL")
    created_at   = Column(DateTime(timezone=True), server_default=func.now())

class Trade(Base):
    __tablename__ = "trades"
    id            = Column(Integer, primary_key=True)
    ticker        = Column(String(10))
    action        = Column(String(4))   # BUY | SELL
    price         = Column(Float)
    shares        = Column(Float)
    pnl           = Column(Float, nullable=True)
    cash_after    = Column(Float)
    fast_sma      = Column(Float, nullable=True)
    slow_sma      = Column(Float, nullable=True)
    signal_reason = Column(Text, nullable=True)
    executed_at   = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# ── WebSocket manager ─────────────────────────────────────────────────────────
class WSManager:
    def __init__(self):
        self.subs: Dict[str, Set[WebSocket]] = {}

    async def connect(self, ws: WebSocket, ticker: str):
        await ws.accept()
        self.subs.setdefault(ticker, set()).add(ws)

    def disconnect(self, ws: WebSocket, ticker: str):
        self.subs.get(ticker, set()).discard(ws)

    async def broadcast(self, ticker: str, payload: dict):
        dead = set()
        for ws in list(self.subs.get(ticker, set())):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.subs.get(ticker, set()).discard(ws)

ws_manager = WSManager()

# ── Price cache ───────────────────────────────────────────────────────────────
_price_cache: Dict[str, dict] = {}

# ── Stock metadata (fallback prices + names) ──────────────────────────────────
STOCK_META = {
    "AAPL":  {"name": "Apple Inc.",              "sector": "Technology",        "base": 213.0},
    "MSFT":  {"name": "Microsoft Corp.",          "sector": "Technology",        "base": 421.0},
    "GOOGL": {"name": "Alphabet Inc.",            "sector": "Technology",        "base": 175.0},
    "AMZN":  {"name": "Amazon.com Inc.",          "sector": "Consumer Cyclical", "base": 193.0},
    "NVDA":  {"name": "NVIDIA Corp.",             "sector": "Technology",        "base": 131.0},
    "META":  {"name": "Meta Platforms",           "sector": "Technology",        "base": 590.0},
    "TSLA":  {"name": "Tesla Inc.",               "sector": "Automotive",        "base": 248.0},
    "JPM":   {"name": "JPMorgan Chase",           "sector": "Finance",           "base": 242.0},
    "V":     {"name": "Visa Inc.",                "sector": "Finance",           "base": 340.0},
    "WMT":   {"name": "Walmart Inc.",             "sector": "Consumer Def.",     "base": 97.0 },
    "JNJ":   {"name": "Johnson & Johnson",        "sector": "Healthcare",        "base": 157.0},
    "PG":    {"name": "Procter & Gamble",         "sector": "Consumer Def.",     "base": 172.0},
    "HD":    {"name": "Home Depot Inc.",          "sector": "Consumer Cyclical", "base": 390.0},
    "KO":    {"name": "Coca-Cola Co.",            "sector": "Consumer Def.",     "base": 72.0 },
    "NFLX":  {"name": "Netflix Inc.",             "sector": "Communication",     "base": 1148.0},
    "AMD":   {"name": "Advanced Micro Devices",   "sector": "Technology",        "base": 116.0},
    "ADBE":  {"name": "Adobe Inc.",               "sector": "Technology",        "base": 383.0},
    "QCOM":  {"name": "Qualcomm Inc.",            "sector": "Technology",        "base": 158.0},
    "INTC":  {"name": "Intel Corp.",              "sector": "Technology",        "base": 21.0 },
    "ORCL":  {"name": "Oracle Corp.",             "sector": "Technology",        "base": 166.0},
    "CRM":   {"name": "Salesforce Inc.",          "sector": "Technology",        "base": 290.0},
    "CSCO":  {"name": "Cisco Systems",            "sector": "Technology",        "base": 60.0 },
    "IBM":   {"name": "IBM Corp.",                "sector": "Technology",        "base": 236.0},
    "GS":    {"name": "Goldman Sachs",            "sector": "Finance",           "base": 578.0},
    "BAC":   {"name": "Bank of America",          "sector": "Finance",           "base": 43.0 },
    "MA":    {"name": "Mastercard Inc.",          "sector": "Finance",           "base": 538.0},
    "AVGO":  {"name": "Broadcom Inc.",            "sector": "Technology",        "base": 226.0},
    "AMGN":  {"name": "Amgen Inc.",               "sector": "Healthcare",        "base": 310.0},
    "TXN":   {"name": "Texas Instruments",        "sector": "Technology",        "base": 180.0},
    "SBUX":  {"name": "Starbucks Corp.",          "sector": "Consumer Cyclical", "base": 85.0 },
}
TICKERS = list(STOCK_META.keys())

# ── Simulated OHLCV (geometric Brownian motion) ───────────────────────────────
def simulate_ohlcv(ticker: str, days: int = 90) -> pd.DataFrame:
    meta  = STOCK_META.get(ticker, {"base": 100.0})
    price = meta["base"]
    mu    = 0.0003
    sigma = 0.015
    rows  = []
    dt    = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    for i in range(days, 0, -1):
        date  = dt.replace(day=dt.day) if i == 0 else dt.__class__(
            dt.year, dt.month, 1, tzinfo=timezone.utc
        )
        # simple date offset
        import datetime as _dt
        day = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=i)).replace(
            hour=0, minute=0, second=0, microsecond=0)

        ret   = math.exp((mu - 0.5 * sigma**2) + sigma * random.gauss(0, 1)) - 1
        close = max(1.0, round(price * (1 + ret), 2))
        high  = round(close * (1 + abs(random.gauss(0, 0.006))), 2)
        low   = round(close * (1 - abs(random.gauss(0, 0.006))), 2)
        open_ = round(price * (1 + random.gauss(0, 0.004)), 2)
        vol   = int(random.uniform(20_000_000, 80_000_000))
        rows.append({"Date": day, "Open": open_, "High": high, "Low": low, "Close": close, "Volume": vol})
        price = close

    df = pd.DataFrame(rows).set_index("Date")
    return df

# ── Fetch OHLCV with simulation fallback ──────────────────────────────────────
def fetch_df(ticker: str, period: str = "3mo") -> tuple[pd.DataFrame, bool]:
    """Returns (DataFrame, is_simulated)."""
    try:
        t    = yf.Ticker(ticker)
        hist = t.history(period=period, interval="1d", auto_adjust=True)
        if isinstance(hist.columns, pd.MultiIndex):
            hist.columns = hist.columns.get_level_values(0)
        if not hist.empty and len(hist) >= 25:
            log.info(f"yfinance OK: {ticker} {len(hist)} bars")
            return hist, False
    except Exception as e:
        log.warning(f"yfinance failed {ticker}: {e}")

    log.info(f"Using simulation for {ticker}")
    days_map = {"1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730}
    return simulate_ohlcv(ticker, days_map.get(period, 90)), True

# ── Live price ────────────────────────────────────────────────────────────────
def get_live_price(ticker: str) -> dict:
    try:
        fi    = yf.Ticker(ticker).fast_info
        price = float(getattr(fi, "last_price", 0) or 0)
        prev  = float(getattr(fi, "previous_close", price) or price)
        if price > 0:
            chg  = round(price - prev, 2)
            chgp = round(chg / prev * 100, 2) if prev else 0.0
            result = {"price": round(price, 2), "change": chg, "change_pct": chgp, "source": "live"}
            _price_cache[ticker] = result
            return result
    except Exception as e:
        log.warning(f"live price {ticker}: {e}")

    cached = _price_cache.get(ticker)
    base   = cached["price"] if cached else STOCK_META.get(ticker, {}).get("base", 100.0)
    tick   = base * random.uniform(-0.0008, 0.0012)
    price  = round(max(1.0, base + tick), 2)
    prev_b = STOCK_META.get(ticker, {}).get("base", price)
    chg    = round(price - prev_b, 2)
    chgp   = round(chg / prev_b * 100, 2) if prev_b else 0.0
    result = {"price": price, "change": chg, "change_pct": chgp, "source": "simulated"}
    _price_cache[ticker] = result
    return result

# ── SMA logic ─────────────────────────────────────────────────────────────────
def add_signals(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["fast_sma"] = df["Close"].rolling(5).mean()
    df["slow_sma"] = df["Close"].rolling(20).mean()
    df["position"] = (df["fast_sma"] > df["slow_sma"]).astype(int)
    df["signal"]   = df["position"].diff()
    return df

# ── Lifespan ──────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if not db.query(Account).first():
            db.add(Account(cash_balance=10_000.0, shares_held=0.0, ticker="AAPL"))
            db.commit()
            log.info("Seeded account with $10,000")
    finally:
        db.close()
    yield

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="AlgoTrader", version="4.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"], allow_credentials=True)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ── Pydantic schemas ──────────────────────────────────────────────────────────
class AccountOut(BaseModel):
    id: int; cash_balance: float; shares_held: float; ticker: str
    portfolio_value: float; total_pnl: float
    class Config: from_attributes = True

class TradeOut(BaseModel):
    id: int; ticker: str; action: str; price: float; shares: float
    pnl: Optional[float]; cash_after: float; fast_sma: Optional[float]
    slow_sma: Optional[float]; signal_reason: Optional[str]; executed_at: datetime
    class Config: from_attributes = True

class StrategyResult(BaseModel):
    signal: str; message: str; current_price: float
    fast_sma: float; slow_sma: float; account: AccountOut; trade: Optional[TradeOut]

class Bar(BaseModel):
    time: str; open: float; high: float; low: float
    close: float; volume: float
    fast_sma: Optional[float]; slow_sma: Optional[float]

class ChartData(BaseModel):
    ticker: str; company_name: str; current_price: float
    change: float; change_pct: float; bars: List[Bar]; is_simulated: bool

class Quote(BaseModel):
    ticker: str; name: str; price: float; change: float
    change_pct: float; market_cap: str; sector: str; is_simulated: bool

def _acct_out(a: Account, price: float) -> AccountOut:
    pv = a.cash_balance + a.shares_held * price
    return AccountOut(id=a.id, cash_balance=a.cash_balance, shares_held=a.shares_held,
                      ticker=a.ticker, portfolio_value=round(pv, 2),
                      total_pnl=round(pv - 10_000.0, 2))

# ─────────────────────────────────────────────────────────────────────────────
# REST ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok", "version": "4.0.0"}

@app.get("/api/v1/account", response_model=AccountOut)
def get_account(db: Session = Depends(get_db)):
    a = db.query(Account).first()
    if not a: raise HTTPException(404, "Account not found")
    p = get_live_price(a.ticker)
    return _acct_out(a, p["price"])

@app.get("/api/v1/trades", response_model=List[TradeOut])
def get_trades(limit: int = 50, db: Session = Depends(get_db)):
    return db.query(Trade).order_by(Trade.executed_at.desc()).limit(limit).all()

@app.get("/api/v1/chart/{ticker}", response_model=ChartData)
def get_chart(ticker: str,
              period: str = Query("3mo", enum=["1mo","3mo","6mo","1y","2y"])):
    ticker = ticker.upper()
    df, sim = fetch_df(ticker, period)
    df = add_signals(df)
    df = df.dropna(subset=["Close"])

    name = STOCK_META.get(ticker, {}).get("name", ticker)
    try:
        info = yf.Ticker(ticker).info
        name = info.get("shortName") or info.get("longName") or name
    except Exception:
        pass

    last  = float(df["Close"].iloc[-1])
    prev  = float(df["Close"].iloc[-2]) if len(df) > 1 else last
    chg   = round(last - prev, 2)
    chgp  = round(chg / prev * 100, 2) if prev else 0.0

    bars = []
    for ts, row in df.iterrows():
        f = row.get("fast_sma"); s = row.get("slow_sma")
        bars.append(Bar(
            time=str(ts)[:10],
            open=round(float(row["Open"]), 2),
            high=round(float(row["High"]), 2),
            low=round(float(row["Low"]),  2),
            close=round(float(row["Close"]), 2),
            volume=float(row.get("Volume", 0) or 0),
            fast_sma=round(float(f), 2) if pd.notna(f) else None,
            slow_sma=round(float(s), 2) if pd.notna(s) else None,
        ))
    return ChartData(ticker=ticker, company_name=name, current_price=round(last, 2),
                     change=chg, change_pct=chgp, bars=bars, is_simulated=sim)

@app.get("/api/v1/search", response_model=List[Quote])
def search(q: str = Query("")):
    q = q.upper().strip()
    pool = [t for t in TICKERS if q in t][:10] if q else TICKERS[:20]
    out  = []
    for sym in pool:
        meta  = STOCK_META.get(sym, {})
        d     = get_live_price(sym)
        price = d["price"]
        mcap  = meta.get("mcap", "—")
        out.append(Quote(
            ticker=sym, name=meta.get("name", sym),
            price=price, change=d["change"], change_pct=d["change_pct"],
            market_cap=mcap if isinstance(mcap, str) else f"${mcap}",
            sector=meta.get("sector", "—"),
            is_simulated=(d["source"] == "simulated"),
        ))
    return out

@app.get("/api/v1/price/{ticker}")
def get_price(ticker: str):
    ticker = ticker.upper()
    d = get_live_price(ticker)
    return {"ticker": ticker, **d, "timestamp": datetime.now(timezone.utc).isoformat()}

@app.post("/api/v1/run-strategy", response_model=StrategyResult)
def run_strategy(ticker: str = Query("AAPL"), db: Session = Depends(get_db)):
    a = db.query(Account).first()
    if not a: raise HTTPException(404, "Account not found")
    ticker = ticker.upper()

    df, _ = fetch_df(ticker, "3mo")
    df    = add_signals(df)
    clean = df.dropna()
    if clean.empty:
        raise HTTPException(422, "Not enough data for SMAs")

    row   = clean.iloc[-1]
    price = float(row["Close"])
    fsma  = round(float(row["fast_sma"]), 4)
    ssma  = round(float(row["slow_sma"]), 4)
    sig   = float(row["signal"])

    signal  = "HOLD"
    message = "No crossover detected — holding position."
    trade   = None

    if sig == 1.0:
        cost = price * 10
        if a.cash_balance >= cost:
            a.cash_balance -= cost
            a.shares_held  += 10
            a.ticker        = ticker
            signal  = "BUY"
            message = f"BUY 10 shares @ ${price:.2f} — Fast SMA crossed above Slow SMA."
            trade   = Trade(ticker=ticker, action="BUY", price=price, shares=10,
                            pnl=None, cash_after=a.cash_balance,
                            fast_sma=fsma, slow_sma=ssma, signal_reason=message)
            db.add(trade)
        else:
            message = "BUY signal — insufficient cash."

    elif sig == -1.0:
        if a.shares_held >= 10:
            proceeds = price * 10
            last_buy = (db.query(Trade).filter(Trade.action=="BUY", Trade.ticker==ticker)
                        .order_by(Trade.executed_at.desc()).first())
            basis = (last_buy.price * 10) if last_buy else proceeds
            pnl   = round(proceeds - basis, 2)
            a.cash_balance += proceeds
            a.shares_held  -= 10
            signal  = "SELL"
            message = f"SELL 10 shares @ ${price:.2f} — PnL ${pnl:+.2f}"
            trade   = Trade(ticker=ticker, action="SELL", price=price, shares=10,
                            pnl=pnl, cash_after=a.cash_balance,
                            fast_sma=fsma, slow_sma=ssma, signal_reason=message)
            db.add(trade)
        else:
            message = "SELL signal — no shares held."

    db.commit()
    if trade: db.refresh(trade)
    return StrategyResult(signal=signal, message=message,
                          current_price=round(price, 2),
                          fast_sma=fsma, slow_sma=ssma,
                          account=_acct_out(a, price),
                          trade=TradeOut.model_validate(trade) if trade else None)

@app.post("/api/v1/reset-account")
def reset_account(db: Session = Depends(get_db)):
    a = db.query(Account).first()
    if a: a.cash_balance = 10_000.0; a.shares_held = 0.0
    db.query(Trade).delete()
    db.commit()
    return {"message": "Account reset to $10,000"}

# ── WebSocket — price stream ──────────────────────────────────────────────────
@app.websocket("/ws/price/{ticker}")
async def ws_price(ws: WebSocket, ticker: str):
    """
    Streams price tick every 3 seconds.
    Render free tier may drop connections — client uses exponential backoff to reconnect.
    """
    ticker = ticker.upper()
    await ws_manager.connect(ws, ticker)
    log.info(f"WS connected: {ticker}")
    try:
        while True:
            d = await asyncio.get_event_loop().run_in_executor(None, get_live_price, ticker)
            await ws.send_json({
                "ticker":     ticker,
                "price":      d["price"],
                "change":     d["change"],
                "change_pct": d["change_pct"],
                "source":     d["source"],
                "timestamp":  datetime.now(timezone.utc).isoformat(),
            })
            await asyncio.sleep(3)
    except WebSocketDisconnect:
        log.info(f"WS disconnected: {ticker}")
    except Exception as e:
        log.error(f"WS error {ticker}: {e}")
    finally:
        ws_manager.disconnect(ws, ticker)

# ── Serve Next.js static build ────────────────────────────────────────────────
# The Next.js `out/` folder (static export) is placed at ../frontend/out
# FastAPI serves it so we only need ONE Render service.
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "out")

if os.path.isdir(STATIC_DIR):
    # Mount _next (JS/CSS chunks)
    app.mount("/_next", StaticFiles(directory=os.path.join(STATIC_DIR, "_next")), name="next-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        """Catch-all — serve Next.js pages or index.html for SPA routing."""
        candidate = os.path.join(STATIC_DIR, full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)
        # Try .html variant (Next.js static export naming)
        html_candidate = candidate + ".html"
        if os.path.isfile(html_candidate):
            return FileResponse(html_candidate)
        # Fallback to index
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
else:
    log.warning(f"Static build not found at {STATIC_DIR} — API-only mode")

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)