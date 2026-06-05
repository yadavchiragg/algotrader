# AlgoTrader — Real-Time Algorithmic Trading Dashboard

> A production-grade, event-driven algorithmic trading engine with live WebSocket price streaming, TradingView Lightweight Charts, and an SMA crossover strategy engine. Built with FastAPI + Next.js. Deployed on Render.

![AlgoTrader Dashboard](https://img.shields.io/badge/status-live-00ff88?style=flat-square&labelColor=0a0e17)
![Python](https://img.shields.io/badge/python-3.11-00aaff?style=flat-square&labelColor=0a0e17)
![Next.js](https://img.shields.io/badge/next.js-14-ffffff?style=flat-square&labelColor=0a0e17)
![FastAPI](https://img.shields.io/badge/fastapi-0.115-00ff88?style=flat-square&labelColor=0a0e17)
![License](https://img.shields.io/badge/license-MIT-ffd700?style=flat-square&labelColor=0a0e17)

---

## What This Is

AlgoTrader is a full-stack portfolio project that simulates a real algorithmic trading system. It:

- Fetches live stock data from Yahoo Finance via `yfinance`
- Computes **Fast SMA (5-period)** and **Slow SMA (20-period)** using pandas
- Detects crossover signals using `pandas .diff()` — the industry-standard technique
- Executes mock BUY/SELL trades on a $10,000 simulated account stored in PostgreSQL
- Streams live price ticks via WebSocket every 2 seconds to the frontend
- Renders a real-time candlestick chart with SMA overlays using TradingView Lightweight Charts
- Falls back to geometric Brownian motion simulation when markets are closed

---

## Live Demo

| Service | URL |
|---------|-----|
| Frontend | `https://algotrader-frontend.onrender.com` |
| Backend API | `https://algotrader-api.onrender.com` |
| API Docs | `https://algotrader-api.onrender.com/docs` |

> **Note:** Render free tier spins down after 15 minutes of inactivity. First load may take 30–60 seconds to wake up.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Render Free Tier                          │
│                                                             │
│  ┌──────────────────────┐    ┌─────────────────────────┐   │
│  │  Static Site         │    │  Web Service             │   │
│  │  (Next.js frontend)  │    │  (FastAPI backend)       │   │
│  │                      │    │                          │   │
│  │  - TradingView Charts│◄──►│  REST API  /api/v1/*     │   │
│  │  - WebSocket client  │    │  WebSocket /ws/price/*   │   │
│  │  - Tailwind CSS UI   │    │  SQLAlchemy ORM          │   │
│  │  - Exponential retry │    │  yfinance + simulation   │   │
│  └──────────────────────┘    └────────────┬────────────┘   │
│                                            │                 │
│                               ┌────────────▼────────────┐   │
│                               │  PostgreSQL Database     │   │
│                               │  accounts + trades       │   │
│                               └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │   Yahoo Finance API     │
                    │   (yfinance library)    │
                    │   Live during market    │
                    │   hours, sim otherwise  │
                    └────────────────────────┘
```

---

## Tech Stack

### Backend
| Technology | Purpose |
|-----------|---------|
| **FastAPI** | REST API framework + WebSocket server |
| **SQLAlchemy** | ORM — works with SQLite locally, PostgreSQL on Render |
| **psycopg2** | PostgreSQL driver |
| **pandas** | SMA calculation + crossover signal detection |
| **yfinance** | Yahoo Finance data fetcher |
| **uvicorn** | ASGI server |
| **pydantic** | Request/response validation and serialisation |

### Frontend
| Technology | Purpose |
|-----------|---------|
| **Next.js 14** | React framework (static export mode) |
| **TypeScript** | Type safety |
| **Tailwind CSS** | Utility-first styling |
| **Lightweight Charts** | TradingView's charting library for candlesticks + SMA lines |
| **WebSocket API** | Native browser WebSocket with exponential backoff reconnect |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| **Render Web Service** | Hosts the FastAPI backend |
| **Render Static Site** | Hosts the Next.js static export |
| **Render PostgreSQL** | Managed Postgres database (free tier) |

---

## Project Structure

```
algotrader/
│
├── .python-version          ← pins Python 3.11.4 for Render
├── render.yaml              ← Render infrastructure as code
├── README.md
│
├── backend/
│   ├── main.py              ← entire FastAPI application
│   │   ├── ORM models       (Account, Trade)
│   │   ├── WebSocket manager
│   │   ├── yfinance fetcher + GBM simulation fallback
│   │   ├── SMA signal engine
│   │   └── REST endpoints + WebSocket endpoint
│   └── requirements.txt
│
└── frontend/
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx     ← main dashboard (all UI logic)
    │   │   ├── layout.tsx   ← root HTML shell
    │   │   └── globals.css  ← terminal aesthetic + animations
    │   └── components/
    │       └── TradingChart.tsx  ← TradingView chart + WS connection
    ├── next.config.js       ← static export config
    ├── package.json
    ├── tailwind.config.js
    └── tsconfig.json
```

---

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/v1/account` | Current balance, shares held, portfolio value, PnL |
| `GET` | `/api/v1/trades` | All executed trades (newest first) |
| `GET` | `/api/v1/chart/{ticker}` | OHLCV bars + precomputed SMA values |
| `GET` | `/api/v1/quotes` | Live quotes for all 30 stocks |
| `POST` | `/api/v1/run-strategy` | Execute SMA crossover strategy on a ticker |
| `POST` | `/api/v1/reset-account` | Reset account to $10,000, clear trades |

### WebSocket

```
ws://your-api.onrender.com/ws/price/{TICKER}
```

Pushes a JSON message every 2 seconds:
```json
{
  "ticker": "AAPL",
  "price": 213.45,
  "timestamp": "2025-01-15T14:32:01.234Z"
}
```

---

## The Strategy — SMA Crossover Explained

### What are the two lines?

**Fast SMA (blue line, 5-period)**
Rolling mean of the last 5 closing prices. Reacts quickly to price changes — represents short-term momentum.

**Slow SMA (yellow line, 20-period)**
Rolling mean of the last 20 closing prices. Moves slowly, filters out noise — represents the medium-term trend.

### The pandas implementation

```python
df["fast_sma"] = df["Close"].rolling(window=5).mean()
df["slow_sma"] = df["Close"].rolling(window=20).mean()

# Regime: 1 = fast above slow (bullish), 0 = fast below slow (bearish)
df["position"] = (df["fast_sma"] > df["slow_sma"]).astype(int)

# Signal: fires ONLY at the exact bar the relationship changes
# +1.0 = bullish crossover (BUY)
# -1.0 = bearish crossover (SELL)
#  0.0 = no change (HOLD)
df["signal"] = df["position"].diff()
```

### Why `.diff()` is the key insight

Without `.diff()`, you would get a BUY signal on every single bar where fast > slow — that's over-trading. The `.diff()` call computes the change between consecutive rows, so it produces a non-zero value **only at the exact bar the relationship flips**. This is the standard quant technique for detecting crossovers in pandas.

### The three signals

| Signal | Condition | Action |
|--------|-----------|--------|
| **BUY** | Fast SMA crosses **above** Slow SMA | Buy 10 shares, deduct cost from cash |
| **SELL** | Fast SMA crosses **below** Slow SMA | Sell 10 shares, add proceeds to cash, log PnL |
| **HOLD** | No crossover on latest bar | Do nothing |

---

## WebSocket — Exponential Backoff

Render's free tier occasionally drops connections during sleep/wake cycles. The frontend (`TradingChart.tsx`) implements proper reconnection:

```
Connect attempt 1 → success → reset delay to 1s
Connect attempt 1 → fail    → wait 1s
Connect attempt 2 → fail    → wait 2s
Connect attempt 3 → fail    → wait 4s
Connect attempt 4 → fail    → wait 8s
Connect attempt 5 → fail    → wait 16s
...capped at 30s between attempts...
Connect attempt N → success → reset delay to 1s ✓
```

This handles cold starts silently without flooding the server or freezing the chart permanently.

---

## Data Sources

| Condition | Data Source | Notes |
|-----------|------------|-------|
| Market hours (Mon–Fri 9:30–16:00 ET) | Yahoo Finance via `yfinance` | Real prices |
| After hours / weekends | Geometric Brownian Motion simulation | Realistic random walk using each stock's historical volatility |
| Yahoo Finance rate limited | GBM simulation fallback | Automatic, no user action needed |

A **SIM** badge appears on the chart header when simulated data is being used.

---

## Deploying to Render

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "AlgoTrader v5"
git remote add origin https://github.com/YOUR_USERNAME/algotrader.git
git push -u origin main
```

### Step 2 — Create PostgreSQL Database
1. Render Dashboard → **New +** → **PostgreSQL**
2. Name: `algotrader-db` | Region: `Oregon` | Plan: `Free`
3. Click **Create Database**
4. Copy the **Internal Database URL**

### Step 3 — Create Backend Web Service
1. **New +** → **Web Service** → connect your repo
2. Settings:

| Field | Value |
|-------|-------|
| Root Directory | `backend` |
| Runtime | `Python 3` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Plan | Free |

3. Environment Variables:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | your PostgreSQL Internal URL |
| `PYTHON_VERSION` | `3.11.4` |

### Step 4 — Create Frontend Static Site
1. **New +** → **Static Site** → connect your repo
2. Settings:

| Field | Value |
|-------|-------|
| Root Directory | `frontend` |
| Build Command | `npm install && npm run build` |
| Publish Directory | `out` |

3. Environment Variables:

| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_API_URL` | your backend URL (e.g. `https://algotrader-api.onrender.com`) |

### Step 5 — Deploy
Both services build in ~3–5 minutes. Your app is live at the Static Site URL.

---

## Running Locally

### Backend
```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
echo "DATABASE_URL=sqlite:///./trading.db" > .env
python3 -m uvicorn main:app --reload --port 8000
```
API docs: http://localhost:8000/docs

### Frontend
```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
npm run dev
```
Dashboard: http://localhost:3000

---

## Interview Talking Points

**"Walk me through the system architecture."**
> The backend is a FastAPI application running on Render's free tier. It exposes a REST API for account data and trade history, a chart endpoint that returns pre-computed OHLCV bars with SMA values, and a WebSocket endpoint that pushes price ticks every 2 seconds. The frontend is a Next.js static export hosted on Render's Static Site service — completely separate from the API, which solves the CSS serving problem you get when trying to proxy static assets through FastAPI.

**"How does the live chart work?"**
> TradingView's Lightweight Charts library renders historical candlesticks from the OHLCV data returned by the REST endpoint. Simultaneously, a WebSocket connection to the backend receives a price tick every 2 seconds. I call the chart's `.update()` method with the new close, and update the high and low if the new price exceeds them — so the last candle visually grows in real time exactly like a professional trading terminal.

**"How do you handle WebSocket drops on Render's free tier?"**
> Exponential backoff — starting at 1 second, doubling on each failure, capped at 30 seconds, resetting to 1 second on a successful reconnect. This is implemented in a `connectWS` function that schedules itself recursively using `setTimeout`. The `dead` ref flag ensures cleanup on component unmount so we don't leak connections.

**"Explain the SMA crossover strategy in pandas."**
> I use `.rolling(n).mean()` to compute both SMAs, then cast the boolean expression `fast_sma > slow_sma` to an integer to create a regime column — 1 for bullish, 0 for bearish. Then I call `.diff()` on the regime column. The diff produces +1 exactly when a bullish crossover fires, -1 on a bearish one, and 0 otherwise. The key insight is that `.diff()` fires only at the exact bar the relationship changes — not on every bar where fast is above slow — which prevents the over-trading problem you'd get with a naive greater-than comparison.

**"Why simulate data instead of failing when markets are closed?"**
> I use geometric Brownian motion — the same stochastic process that underlies the Black-Scholes options pricing model. Each stock has a calibrated volatility parameter so NVDA moves more than KO, for example. This keeps the WebSocket stream and charts fully functional 24/7 for demos, which is critical for a portfolio project where you can't guarantee the interviewer will look at it during NYSE hours.

---

## License

MIT — free to use, modify, and deploy.