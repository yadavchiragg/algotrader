# AlgoTrader — Real-Time Algorithmic Trading Dashboard

Deployment Link: https://algotrader-frontend.onrender.com

> A production-grade, event-driven algorithmic trading engine with live WebSocket price streaming, TradingView Lightweight Charts, and an SMA crossover strategy — deployed entirely on Render (free tier).

---

## Exact Project Structure

```
algotrader/                         ← your GitHub repo root
│
├── .python-version                 ← tells Render to use Python 3.11.4
├── render.yaml                     ← Render infrastructure config
├── README.md                       ← this file
│
├── backend/                        ← FastAPI backend (Render Web Service)
│   ├── main.py                     ← entire backend: API + WebSocket + DB + strategy
│   └── requirements.txt            ← Python dependencies
│
└── frontend/                       ← static frontend (Render Static Site)
    ├── index.html                  ← entire dashboard: HTML + CSS + JS in one file
    └── build.sh                    ← injects API URL into index.html at deploy time
```

**That's it. 6 files total. No Node.js. No npm. No build pipeline.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Render Free Tier                          │
│                                                                  │
│   ┌──────────────────────┐      ┌──────────────────────────┐   │
│   │   Static Site         │      │   Web Service             │   │
│   │   algotrader-frontend │      │   algotrader-api          │   │
│   │                       │      │                           │   │
│   │  index.html           │◄────►│  FastAPI (uvicorn)        │   │
│   │  - TradingView Charts │      │  REST  → /api/v1/*        │   │
│   │  - WebSocket client   │      │  WS    → /ws/price/*      │   │
│   │  - Vanilla JS/CSS     │      │  SQLAlchemy ORM           │   │
│   │  - Exp. backoff retry │      │  yfinance + GBM sim       │   │
│   └──────────────────────┘      └────────────┬─────────────┘   │
│                                               │                  │
│                                  ┌────────────▼─────────────┐   │
│                                  │   PostgreSQL Database     │   │
│                                  │   accounts + trades       │   │
│                                  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                               │
                                  ┌────────────▼─────────────┐
                                  │   Yahoo Finance API       │
                                  │   Live market hours only  │
                                  │   GBM simulation fallback │
                                  └──────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Backend framework | FastAPI | Async, fast, native WebSocket support |
| Database ORM | SQLAlchemy | Works with SQLite locally + PostgreSQL on Render |
| DB driver | psycopg2-binary | PostgreSQL connector |
| Data | pandas + yfinance | SMA calculation + Yahoo Finance OHLCV |
| Server | uvicorn | ASGI server, required for async FastAPI |
| Frontend | Vanilla HTML/CSS/JS | Zero build step — no CSS loading bugs |
| Charts | TradingView Lightweight Charts (CDN) | Industry-standard candlestick + SMA rendering |
| Hosting | Render (free tier) | Static Site + Web Service + PostgreSQL |

---

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check — returns `{"status":"ok"}` |
| `GET` | `/api/v1/account` | Cash balance, shares held, portfolio value, PnL |
| `GET` | `/api/v1/trades` | All executed trades, newest first |
| `GET` | `/api/v1/chart/{ticker}?period=3mo` | OHLCV bars + precomputed Fast/Slow SMA |
| `GET` | `/api/v1/quotes?q=` | Live quotes for all 30 stocks |
| `POST` | `/api/v1/run-strategy?ticker=AAPL` | Execute SMA crossover — returns BUY/SELL/HOLD |
| `POST` | `/api/v1/reset-account` | Reset to $10,000, wipe trade history |

### WebSocket

```
wss://algotrader-api.onrender.com/ws/price/AAPL
```

Pushes every 2 seconds:
```json
{
  "ticker": "AAPL",
  "price": 213.45,
  "timestamp": "2025-06-05T14:32:01.234Z"
}
```

---

## The Strategy — SMA Crossover

### Two lines on the chart

| Line | Period | Color | Meaning |
|------|--------|-------|---------|
| Fast SMA | 5 bars | Blue | Short-term momentum — reacts quickly |
| Slow SMA | 20 bars | Yellow | Medium-term trend — moves slowly |

### The pandas code

```python
# Compute both SMAs
df["fast_sma"] = df["Close"].rolling(window=5).mean()
df["slow_sma"] = df["Close"].rolling(window=20).mean()

# Regime: 1 = fast above slow (bullish), 0 = bearish
df["position"] = (df["fast_sma"] > df["slow_sma"]).astype(int)

# Signal fires ONLY when relationship CHANGES
# +1.0 = BUY (bullish crossover)
# -1.0 = SELL (bearish crossover)
#  0.0 = HOLD (no change)
df["signal"] = df["position"].diff()
```

### Why `.diff()` is the key

Without `.diff()`, you'd get a signal on every single bar where fast > slow — massively over-trading. `.diff()` produces a non-zero value **only at the exact bar the relationship flips**. That's the industry-standard crossover detection technique.

### The three signals

| Signal | Condition | What happens |
|--------|-----------|--------------|
| **BUY** | Fast crosses **above** Slow | Buy 10 shares, deduct cost from cash |
| **SELL** | Fast crosses **below** Slow | Sell 10 shares, add proceeds, calculate PnL |
| **HOLD** | No crossover | Nothing — algorithm stays silent |

---

## Data Sources

| When | Source | Notes |
|------|--------|-------|
| Mon–Fri 9:30am–4pm ET | Yahoo Finance (live) | Real prices via yfinance |
| Weekends / after hours | Geometric Brownian Motion | Math simulation using each stock's real historical volatility |
| Yahoo Finance rate-limited | GBM fallback (auto) | No user action needed |

**SIM** badge shows on chart when simulated data is in use. The simulation uses the same stochastic process as the Black-Scholes options pricing model, so volatility looks realistic per stock (NVDA moves more than KO, etc.).

---

## WebSocket Reconnect — Exponential Backoff

Render free tier drops connections on sleep/wake. The frontend handles this silently:

```
Connect → success            → reset delay to 1s ✓
Connect → fail → wait  1s
Connect → fail → wait  2s
Connect → fail → wait  4s
Connect → fail → wait  8s
Connect → fail → wait 16s
Connect → fail → wait 30s  (capped)
...
Connect → success            → reset delay to 1s ✓
```

---


## 30 Supported Stocks

AAPL · MSFT · GOOGL · AMZN · NVDA · META · TSLA · JPM · V · WMT ·
JNJ · PG · HD · KO · NFLX · AMD · ADBE · QCOM · INTC · ORCL ·
CRM · GS · BAC · MA · AVGO · AMGN · TXN · SBUX · IBM · CSCO

---

## License

MIT — free to use, modify, and deploy.
