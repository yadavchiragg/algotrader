import os, asyncio, random, logging, math
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Set
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Depends, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime, Text, func
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./trading.db")
if DATABASE_URL.startswith("postgres://"): DATABASE_URL = DATABASE_URL.replace("postgres://","postgresql://",1)
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Account(Base):
    __tablename__ = "accounts"
    id=Column(Integer,primary_key=True); cash_balance=Column(Float,default=10_000.0)
    shares_held=Column(Float,default=0.0); ticker=Column(String(10),default="AAPL")
    created_at=Column(DateTime(timezone=True),server_default=func.now())

class Trade(Base):
    __tablename__ = "trades"
    id=Column(Integer,primary_key=True); ticker=Column(String(10)); action=Column(String(4))
    price=Column(Float); shares=Column(Float); pnl=Column(Float,nullable=True)
    cash_after=Column(Float); fast_sma=Column(Float,nullable=True); slow_sma=Column(Float,nullable=True)
    signal_reason=Column(Text,nullable=True)
    executed_at=Column(DateTime(timezone=True),default=lambda: datetime.now(timezone.utc))

class WSManager:
    def __init__(self): self.subs: Dict[str,Set[WebSocket]] = {}
    async def connect(self,ws,ticker):
        await ws.accept(); self.subs.setdefault(ticker,set()).add(ws)
    def disconnect(self,ws,ticker): self.subs.get(ticker,set()).discard(ws)
    async def send(self,ws,data):
        try: await ws.send_json(data); return True
        except: return False
manager = WSManager()

STOCKS = {
    "AAPL":{"name":"Apple Inc.","sector":"Technology","base":211.0,"vol":0.018},
    "MSFT":{"name":"Microsoft Corp.","sector":"Technology","base":420.0,"vol":0.015},
    "GOOGL":{"name":"Alphabet Inc.","sector":"Technology","base":175.0,"vol":0.017},
    "AMZN":{"name":"Amazon.com Inc.","sector":"Consumer Cyclical","base":192.0,"vol":0.019},
    "NVDA":{"name":"NVIDIA Corp.","sector":"Technology","base":130.0,"vol":0.030},
    "META":{"name":"Meta Platforms","sector":"Technology","base":590.0,"vol":0.020},
    "TSLA":{"name":"Tesla Inc.","sector":"Automotive","base":248.0,"vol":0.035},
    "JPM":{"name":"JPMorgan Chase","sector":"Finance","base":242.0,"vol":0.014},
    "V":{"name":"Visa Inc.","sector":"Finance","base":340.0,"vol":0.012},
    "WMT":{"name":"Walmart Inc.","sector":"Consumer Def.","base":97.0,"vol":0.011},
    "JNJ":{"name":"Johnson & Johnson","sector":"Healthcare","base":157.0,"vol":0.010},
    "PG":{"name":"Procter & Gamble","sector":"Consumer Def.","base":172.0,"vol":0.010},
    "HD":{"name":"Home Depot Inc.","sector":"Consumer Cyclical","base":390.0,"vol":0.014},
    "KO":{"name":"Coca-Cola Co.","sector":"Consumer Def.","base":72.0,"vol":0.009},
    "NFLX":{"name":"Netflix Inc.","sector":"Communication","base":1148.0,"vol":0.022},
    "AMD":{"name":"Advanced Micro Devices","sector":"Technology","base":116.0,"vol":0.028},
    "ADBE":{"name":"Adobe Inc.","sector":"Technology","base":383.0,"vol":0.016},
    "QCOM":{"name":"Qualcomm Inc.","sector":"Technology","base":158.0,"vol":0.016},
    "INTC":{"name":"Intel Corp.","sector":"Technology","base":21.0,"vol":0.020},
    "ORCL":{"name":"Oracle Corp.","sector":"Technology","base":166.0,"vol":0.015},
    "CRM":{"name":"Salesforce Inc.","sector":"Technology","base":290.0,"vol":0.017},
    "GS":{"name":"Goldman Sachs","sector":"Finance","base":578.0,"vol":0.016},
    "BAC":{"name":"Bank of America","sector":"Finance","base":43.0,"vol":0.015},
    "MA":{"name":"Mastercard Inc.","sector":"Finance","base":538.0,"vol":0.013},
    "AVGO":{"name":"Broadcom Inc.","sector":"Technology","base":226.0,"vol":0.019},
    "AMGN":{"name":"Amgen Inc.","sector":"Healthcare","base":310.0,"vol":0.013},
    "TXN":{"name":"Texas Instruments","sector":"Technology","base":180.0,"vol":0.014},
    "SBUX":{"name":"Starbucks Corp.","sector":"Consumer Cyclical","base":85.0,"vol":0.016},
    "IBM":{"name":"IBM Corp.","sector":"Technology","base":236.0,"vol":0.013},
    "CSCO":{"name":"Cisco Systems","sector":"Technology","base":60.0,"vol":0.012},
}
TICKERS = list(STOCKS.keys())
_prices: Dict[str,float] = {t:STOCKS[t]["base"] for t in TICKERS}

def simulate_history(ticker:str, days:int=90) -> pd.DataFrame:
    import datetime as _dt
    m=STOCKS.get(ticker,{"base":100.0,"vol":0.018}); price=m["base"]; sigma=m["vol"]; rows=[]
    now=_dt.datetime.now(_dt.timezone.utc)
    for i in range(days,0,-1):
        day=(now-_dt.timedelta(days=i)).replace(hour=0,minute=0,second=0,microsecond=0)
        ret=math.exp(-0.5*sigma**2+sigma*random.gauss(0,1))-1
        close=max(1.0,round(price*(1+ret),2))
        rows.append({"Date":day,"Open":round(price*(1+random.gauss(0,sigma*0.3)),2),
                     "High":round(close*(1+abs(random.gauss(0,sigma*0.4))),2),
                     "Low":round(close*(1-abs(random.gauss(0,sigma*0.4))),2),
                     "Close":close,"Volume":int(random.uniform(20e6,80e6))})
        price=close
    _prices[ticker]=price
    return pd.DataFrame(rows).set_index("Date")

def fetch_history(ticker:str,period:str="3mo") -> tuple:
    try:
        hist=yf.Ticker(ticker).history(period=period,interval="1d",auto_adjust=True)
        if isinstance(hist.columns,pd.MultiIndex): hist.columns=hist.columns.get_level_values(0)
        if not hist.empty and len(hist)>=25:
            _prices[ticker]=float(hist["Close"].iloc[-1]); return hist,False
    except Exception as e: log.warning(f"yfinance {ticker}: {e}")
    days={"1mo":30,"3mo":90,"6mo":180,"1y":365,"2y":730}.get(period,90)
    return simulate_history(ticker,days),True

def next_tick(ticker:str) -> float:
    sigma=STOCKS.get(ticker,{}).get("vol",0.018)
    cur=_prices.get(ticker,STOCKS.get(ticker,{}).get("base",100.0))
    tick_sigma=sigma*math.sqrt(2/23400)
    new=max(0.01,round(cur*math.exp(random.gauss(0,tick_sigma)),2))
    _prices[ticker]=new; return new

def get_quote(ticker:str) -> dict:
    try:
        fi=yf.Ticker(ticker).fast_info
        price=float(getattr(fi,"last_price",0) or 0)
        prev=float(getattr(fi,"previous_close",price) or price)
        if price>0:
            _prices[ticker]=price
            return {"price":round(price,2),"change":round(price-prev,2),
                    "change_pct":round((price-prev)/prev*100,2) if prev else 0.0,"source":"live"}
    except: pass
    price=_prices.get(ticker,STOCKS.get(ticker,{}).get("base",100.0))
    base=STOCKS.get(ticker,{}).get("base",price)
    return {"price":price,"change":round(price-base,2),
            "change_pct":round((price-base)/base*100,2) if base else 0.0,"source":"sim"}

def add_sma(df):
    df=df.copy(); df["fast_sma"]=df["Close"].rolling(5).mean()
    df["slow_sma"]=df["Close"].rolling(20).mean()
    df["position"]=(df["fast_sma"]>df["slow_sma"]).astype(int)
    df["signal"]=df["position"].diff(); return df

@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(bind=engine)
    db=SessionLocal()
    try:
        if not db.query(Account).first():
            db.add(Account(cash_balance=10_000.0,shares_held=0.0,ticker="AAPL")); db.commit()
    finally: db.close()
    yield

app=FastAPI(title="AlgoTrader",version="5.0.0",lifespan=lifespan)
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_credentials=True,allow_methods=["*"],allow_headers=["*"])

def get_db():
    db=SessionLocal()
    try: yield db
    finally: db.close()

class AccountOut(BaseModel):
    id:int;cash_balance:float;shares_held:float;ticker:str;portfolio_value:float;total_pnl:float
    class Config: from_attributes=True
class TradeOut(BaseModel):
    id:int;ticker:str;action:str;price:float;shares:float;pnl:Optional[float];cash_after:float
    fast_sma:Optional[float];slow_sma:Optional[float];signal_reason:Optional[str];executed_at:datetime
    class Config: from_attributes=True
class StrategyResult(BaseModel):
    signal:str;message:str;current_price:float;fast_sma:float;slow_sma:float
    account:AccountOut;trade:Optional[TradeOut]
class Bar(BaseModel):
    time:str;open:float;high:float;low:float;close:float;volume:float
    fast_sma:Optional[float];slow_sma:Optional[float]
class ChartData(BaseModel):
    ticker:str;company_name:str;current_price:float;change:float;change_pct:float
    bars:List[Bar];is_simulated:bool
class Quote(BaseModel):
    ticker:str;name:str;price:float;change:float;change_pct:float;sector:str;is_simulated:bool

def _acct(a,price):
    pv=a.cash_balance+a.shares_held*price
    return AccountOut(id=a.id,cash_balance=a.cash_balance,shares_held=a.shares_held,
                      ticker=a.ticker,portfolio_value=round(pv,2),total_pnl=round(pv-10_000.0,2))

@app.get("/api/health")
def health(): return {"status":"ok","version":"5.0.0"}

@app.get("/api/v1/account",response_model=AccountOut)
def get_account(db:Session=Depends(get_db)):
    a=db.query(Account).first()
    if not a: raise HTTPException(404,"Account not found")
    return _acct(a,get_quote(a.ticker)["price"])

@app.get("/api/v1/trades",response_model=List[TradeOut])
def get_trades(limit:int=50,db:Session=Depends(get_db)):
    return db.query(Trade).order_by(Trade.executed_at.desc()).limit(limit).all()

@app.get("/api/v1/chart/{ticker}",response_model=ChartData)
def get_chart(ticker:str,period:str=Query("3mo",enum=["1mo","3mo","6mo","1y","2y"])):
    ticker=ticker.upper()
    df,sim=fetch_history(ticker,period)
    df=add_sma(df).dropna(subset=["Close"])
    name=STOCKS.get(ticker,{}).get("name",ticker)
    try:
        info=yf.Ticker(ticker).info; name=info.get("shortName") or info.get("longName") or name
    except: pass
    last=float(df["Close"].iloc[-1]); prev=float(df["Close"].iloc[-2]) if len(df)>1 else last
    chg=round(last-prev,2); chgp=round(chg/prev*100,2) if prev else 0.0
    bars=[]
    for ts,row in df.iterrows():
        f=row.get("fast_sma"); s=row.get("slow_sma")
        bars.append(Bar(time=str(ts)[:10],open=round(float(row["Open"]),2),
            high=round(float(row["High"]),2),low=round(float(row["Low"]),2),
            close=round(float(row["Close"]),2),volume=float(row.get("Volume",0) or 0),
            fast_sma=round(float(f),2) if pd.notna(f) else None,
            slow_sma=round(float(s),2) if pd.notna(s) else None))
    return ChartData(ticker=ticker,company_name=name,current_price=round(last,2),
                     change=chg,change_pct=chgp,bars=bars,is_simulated=sim)

@app.get("/api/v1/quotes",response_model=List[Quote])
def get_quotes(q:str=Query("")):
    q=q.upper().strip()
    pool=[t for t in TICKERS if q in t][:10] if q else TICKERS
    return [Quote(ticker=t,name=STOCKS[t]["name"],**{k:v for k,v in get_quote(t).items() if k!="source"},
                  sector=STOCKS[t]["sector"],is_simulated=(get_quote(t)["source"]=="sim")) for t in pool]

@app.post("/api/v1/run-strategy",response_model=StrategyResult)
def run_strategy(ticker:str=Query("AAPL"),db:Session=Depends(get_db)):
    a=db.query(Account).first()
    if not a: raise HTTPException(404,"Not found")
    ticker=ticker.upper()
    df,_=fetch_history(ticker,"3mo"); df=add_sma(df).dropna()
    if df.empty: raise HTTPException(422,"Not enough data")
    row=df.iloc[-1]; price=float(row["Close"])
    fsma=round(float(row["fast_sma"]),4); ssma=round(float(row["slow_sma"]),4); sig=float(row["signal"])
    signal="HOLD"; message="No crossover — holding."; trade=None
    if sig==1.0:
        cost=price*10
        if a.cash_balance>=cost:
            a.cash_balance-=cost; a.shares_held+=10; a.ticker=ticker
            signal="BUY"; message=f"BUY 10 @ ${price:.2f} — Fast crossed above Slow."
            trade=Trade(ticker=ticker,action="BUY",price=price,shares=10,pnl=None,
                        cash_after=a.cash_balance,fast_sma=fsma,slow_sma=ssma,signal_reason=message)
            db.add(trade)
        else: message="BUY signal — insufficient cash."
    elif sig==-1.0:
        if a.shares_held>=10:
            proceeds=price*10; lb=(db.query(Trade).filter(Trade.action=="BUY",Trade.ticker==ticker)
                                   .order_by(Trade.executed_at.desc()).first())
            basis=(lb.price*10) if lb else proceeds; pnl=round(proceeds-basis,2)
            a.cash_balance+=proceeds; a.shares_held-=10
            signal="SELL"; message=f"SELL 10 @ ${price:.2f} — PnL ${pnl:+.2f}"
            trade=Trade(ticker=ticker,action="SELL",price=price,shares=10,pnl=pnl,
                        cash_after=a.cash_balance,fast_sma=fsma,slow_sma=ssma,signal_reason=message)
            db.add(trade)
        else: message="SELL signal — no shares held."
    db.commit()
    if trade: db.refresh(trade)
    return StrategyResult(signal=signal,message=message,current_price=round(price,2),
                          fast_sma=fsma,slow_sma=ssma,account=_acct(a,price),
                          trade=TradeOut.model_validate(trade) if trade else None)

@app.post("/api/v1/reset-account")
def reset(db:Session=Depends(get_db)):
    a=db.query(Account).first()
    if a: a.cash_balance=10_000.0; a.shares_held=0.0
    db.query(Trade).delete(); db.commit()
    return {"message":"Reset to $10,000"}

@app.websocket("/ws/price/{ticker}")
async def ws_price(ws:WebSocket, ticker:str):
    ticker=ticker.upper()
    await manager.connect(ws,ticker)
    try:
        while True:
            price=next_tick(ticker)
            ok=await manager.send(ws,{"ticker":ticker,"price":price,
                                       "timestamp":datetime.now(timezone.utc).isoformat()})
            if not ok: break
            await asyncio.sleep(2)
    except WebSocketDisconnect: log.info(f"WS disconnected: {ticker}")
    except Exception as e: log.error(f"WS error {ticker}: {e}")
    finally: manager.disconnect(ws,ticker)

if __name__=="__main__":
    import uvicorn
    uvicorn.run("main:app",host="0.0.0.0",port=int(os.environ.get("PORT",8000)),reload=False)