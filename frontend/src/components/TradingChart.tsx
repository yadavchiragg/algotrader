"use client";
import { useEffect, useRef, useCallback } from "react";

interface Bar {
  time: string;
  open: number; high: number; low: number; close: number;
  volume: number;
  fast_sma: number | null;
  slow_sma: number | null;
}

interface Props {
  bars: Bar[];
  livePrice: number | null;
  ticker: string;
}

// Determine the API base URL — same origin on Render (single service)
const getBase = () => {
  if (typeof window === "undefined") return "";
  return process.env.NEXT_PUBLIC_API_URL ?? window.location.origin;
};

export default function TradingChart({ bars, livePrice, ticker }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<unknown>(null);
  const candleRef    = useRef<unknown>(null);
  const fastRef      = useRef<unknown>(null);
  const slowRef      = useRef<unknown>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const retryDelay   = useRef(1000);   // exponential backoff start: 1s
  const dead         = useRef(false);

  // ── Build chart ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;

    // Dynamic import so SSR doesn't break (lightweight-charts is browser-only)
    import("lightweight-charts").then(({ createChart, CrosshairMode, LineStyle }) => {
      // Clean up previous chart instance
      if (chartRef.current) {
        (chartRef.current as { remove: () => void }).remove();
      }

      const chart = createChart(containerRef.current!, {
        width:  containerRef.current!.clientWidth,
        height: 380,
        layout: {
          background: { color: "#111827" },
          textColor:  "#4a5568",
        },
        grid: {
          vertLines: { color: "#1e2d40", style: LineStyle.Dotted },
          horzLines: { color: "#1e2d40", style: LineStyle.Dotted },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#1e2d40" },
        timeScale: {
          borderColor:      "#1e2d40",
          timeVisible:      true,
          secondsVisible:   false,
        },
      });

      // Responsive resize
      const ro = new ResizeObserver(() => {
        chart.applyOptions({ width: containerRef.current!.clientWidth });
      });
      ro.observe(containerRef.current!);

      // ── Candlestick series ──
      const candleSeries = chart.addCandlestickSeries({
        upColor:        "#00ff88",
        downColor:      "#ff4466",
        borderUpColor:  "#00ff88",
        borderDownColor:"#ff4466",
        wickUpColor:    "#00ff88",
        wickDownColor:  "#ff4466",
      });

      // ── Fast SMA line (blue) ──
      const fastSeries = chart.addLineSeries({
        color:     "#00aaff",
        lineWidth: 2,
        title:     "Fast SMA (5)",
        priceLineVisible: false,
        lastValueVisible: true,
      });

      // ── Slow SMA line (yellow) ──
      const slowSeries = chart.addLineSeries({
        color:     "#ffd700",
        lineWidth: 2,
        title:     "Slow SMA (20)",
        priceLineVisible: false,
        lastValueVisible: true,
      });

      // ── Populate data ──
      const candleData = bars.map(b => ({
        time:  b.time as unknown,
        open:  b.open,
        high:  b.high,
        low:   b.low,
        close: b.close,
      }));
      const fastData = bars
        .filter(b => b.fast_sma !== null)
        .map(b => ({ time: b.time as unknown, value: b.fast_sma! }));
      const slowData = bars
        .filter(b => b.slow_sma !== null)
        .map(b => ({ time: b.time as unknown, value: b.slow_sma! }));

      candleSeries.setData(candleData as Parameters<typeof candleSeries.setData>[0]);
      fastSeries.setData(fastData   as Parameters<typeof fastSeries.setData>[0]);
      slowSeries.setData(slowData   as Parameters<typeof slowSeries.setData>[0]);

      chart.timeScale().fitContent();

      chartRef.current  = chart;
      candleRef.current = candleSeries;
      fastRef.current   = fastSeries;
      slowRef.current   = slowSeries;

      return () => { ro.disconnect(); };
    });

    return () => {
      if (chartRef.current) {
        (chartRef.current as { remove: () => void }).remove();
        chartRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars]);

  // ── Patch last candle with live price ────────────────────────────────────
  useEffect(() => {
    if (!livePrice || !candleRef.current || bars.length === 0) return;
    const lastBar = bars[bars.length - 1];
    const update  = {
      time:  lastBar.time as unknown,
      open:  lastBar.open,
      high:  Math.max(lastBar.high, livePrice),
      low:   Math.min(lastBar.low,  livePrice),
      close: livePrice,
    };
    (candleRef.current as { update: (d: unknown) => void }).update(update);
  }, [livePrice, bars]);

  // ── WebSocket with exponential backoff ───────────────────────────────────
  const connectWS = useCallback(() => {
    if (dead.current) return;

    const base = getBase().replace(/^http/, "ws");   // http→ws, https→wss
    const url  = `${base}/ws/price/${ticker}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      retryDelay.current = 1000;   // reset backoff on successful connect
    };

    ws.onmessage = (e) => {
      try {
        const tick = JSON.parse(e.data) as { price: number };
        // The parent component handles state; we just patch the chart here
        if (candleRef.current && bars.length > 0) {
          const last = bars[bars.length - 1];
          (candleRef.current as { update: (d: unknown) => void }).update({
            time:  last.time,
            open:  last.open,
            high:  Math.max(last.high, tick.price),
            low:   Math.min(last.low,  tick.price),
            close: tick.price,
          });
        }
      } catch { /* malformed frame */ }
    };

    ws.onerror = () => { ws.close(); };

    ws.onclose = () => {
      if (!dead.current) scheduleReconnect();
    };
  }, [ticker, bars]);

  function scheduleReconnect() {
    // Exponential backoff: 1s → 2s → 4s → 8s → 16s → cap 30s
    const delay = Math.min(retryDelay.current, 30_000);
    retryDelay.current = delay * 2;
    setTimeout(connectWS, delay);
  }

  useEffect(() => {
    dead.current = false;
    retryDelay.current = 1000;
    connectWS();
    return () => {
      dead.current = true;
      wsRef.current?.close();
    };
  }, [connectWS]);

  return (
    <div ref={containerRef} className="tv-chart rounded-sm overflow-hidden" />
  );
}