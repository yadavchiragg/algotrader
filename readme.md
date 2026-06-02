# AlgoTrader v4 — Single-Service Render Deployment

Real-time algorithmic trading dashboard.
**One Render service** — FastAPI serves both the REST API, WebSocket stream, and the Next.js static build.

---

## Architecture

```
Render Free Tier (single Web Service)
│
├── FastAPI (uvicorn)
│   ├── GET  /api/v1/account          → account balance + PnL
│   ├── GET  /api/v1/trades           → trade history
│   ├── GET  /api/v1/chart/{ticker}   → OHLCV + SMA bars
│   ├── GET  /api/v1/search           → stock search with live quotes
│   ├── POST /api/v1/run-strategy     → execute SMA crossover strategy
│   ├── POST /api/v1/reset-account    → reset to $10,000
│   └── WS   /ws/price/{ticker}       → live price stream every 3s
│
├── Static file serving
│   └── GET  /*  → serves frontend/out/ (Next.js static export)
│
└── PostgreSQL (Render free tier)
```

## Project Structure

```
algotrader/
├── render.yaml              ← Render IaC config
├── build.sh                 ← build script
├── backend/
│   ├── main.py              ← FastAPI app (API + WS + static serving)
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx     ← main dashboard
    │   │   ├── layout.tsx
    │   │   └── globals.css
    │   └── components/
    │       └── TradingChart.tsx  ← TradingView Lightweight Charts + WS
    ├── package.json
    ├── next.config.js       ← output: "export" (static)
    └── tsconfig.json
```

---

## Deploy to Render — Step by Step

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "AlgoTrader v4"
git remote add origin https://github.com/YOUR_USERNAME/algotrader.git
git push -u origin main
```

### Step 2 — Create PostgreSQL on Render
1. Render Dashboard → **New** → **PostgreSQL**
2. Name: `algotrader-db`
3. Plan: **Free**
4. Region: **Oregon**
5. Click **Create Database**
6. Copy the **Internal Database URL** (looks like `postgresql://user:pass@dpg-xxx.oregon-postgres.render.com/algotrader`)

### Step 3 — Create Web Service on Render
1. Render Dashboard → **New** → **Web Service**
2. Connect your GitHub repo
3. Settings:
   | Field | Value |
   |-------|-------|
   | **Name** | `algotrader` |
   | **Region** | Oregon (same as DB!) |
   | **Runtime** | Python 3 |
   | **Root Directory** | *(leave blank — repo root)* |
   | **Build Command** | `cd frontend && npm ci && npm run build && cd ../backend && pip install -r requirements.txt` |
   | **Start Command** | `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT` |
   | **Plan** | Free |

4. Under **Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | paste your Internal Database URL from Step 2 |

5. Click **Create Web Service**

### Step 4 — Wait for deploy (~5 minutes)
Render will:
1. Install Node.js deps (`npm ci`)
2. Build Next.js static export → `frontend/out/`
3. Install Python deps (`pip install -r requirements.txt`)
4. Start uvicorn

Your app will be live at `https://algotrader.onrender.com`

---

## Local Development

```bash
# Terminal 1 — backend
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd frontend
npm install
# Create .env.local:
echo "NEXT_PUBLIC_API_URL=http://localhost:8000" > .env.local
npm run dev
# open http://localhost:3000
```

---

## WebSocket — Exponential Backoff

The frontend (`TradingChart.tsx`) implements proper reconnection:

```
Attempt 1: immediate
Fail → wait 1s → Attempt 2
Fail → wait 2s → Attempt 3
Fail → wait 4s → Attempt 4
Fail → wait 8s → Attempt 5
...
Cap at 30s between attempts
Success → reset delay to 1s
```

This handles Render's free tier sleeping and network micro-interruptions silently.

---

## Data Sources

| Condition | Data |
|-----------|------|
| Market hours (Mon–Fri 9:30–16:00 ET) | Live from Yahoo Finance via yfinance |
| After hours / weekends | Realistic simulation (geometric Brownian motion) |
| Yahoo Finance rate-limited | Automatic simulation fallback |

The SIM badge appears on the chart when simulated data is in use.

---

## Interview Talking Points

**"How does the live chart work?"**
> TradingView Lightweight Charts renders candlesticks from historical OHLCV bars. A WebSocket connection to the FastAPI backend pushes a price tick every 3 seconds, and I update the last candle's close, high, and low in real time using the chart's `.update()` API.

**"How do you handle connection drops on Render's free tier?"**
> Exponential backoff — the client starts at 1 second, doubles on each failure, caps at 30 seconds, and resets to 1 second on success. This prevents flooding the server while ensuring recovery as fast as possible.

**"Explain the SMA crossover in pandas."**
> I use `.rolling(n).mean()` for both SMAs, then cast the boolean `fast > slow` to an integer regime column (1/0), then call `.diff()` on it. The diff produces +1 exactly when a bullish crossover fires and -1 on a bearish one — meaning the signal fires only once per crossover, not on every bar where fast > slow.