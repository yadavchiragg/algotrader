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
  ticker: string;
  onPriceUpdate?: (price: number) => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function TradingChart({ bars, ticker, onPriceUpdate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<any>(null);
  const candleRef    = useRef<any>(null);
  const fastRef      = useRef<any>(null);
  const slowRef      = useRef<any>(null);
  const wsRef        = useRef<WebSocket | null>(null);
  const retryDelay   = useRef(1000);
  const deadRef      = useRef(false);
  const lastBarRef   = useRef<Bar | null>(null);

  // Keep lastBar in sync
  useEffect(() => {
    if (bars.length > 0) lastBarRef.current = bars[bars.length - 1];
  }, [bars]);

  // ── Build chart ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || bars.length === 0) return;
    let resizeObs: ResizeObserver | null = null;

    import("lightweight-charts").then((lc) => {
      const { createChart, CrosshairMode, LineStyle } = lc;

      // Destroy old instance
      if (chartRef.current) { try { chartRef.current.remove(); } catch {} }

      const chart = createChart(containerRef.current!, {
        width:  containerRef.current!.clientWidth,
        height: 400,
        layout: {
          background: { color: "#111827" },
          textColor:  "#4a5568",
        },
        grid: {
          vertLines: { color: "#1a2535", style: LineStyle.Dotted },
          horzLines: { color: "#1a2535", style: LineStyle.Dotted },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: "#1e2d40",
          textColor:   "#4a5568",
        },
        timeScale: {
          borderColor:    "#1e2d40",
          timeVisible:    true,
          secondsVisible: false,
          fixLeftEdge:    false,
          fixRightEdge:   false,
        },
        handleScroll:  true,
        handleScale:   true,
      });

      // Responsive width
      resizeObs = new ResizeObserver(() => {
        if (containerRef.current) {
          chart.applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      resizeObs.observe(containerRef.current!);

      // ── Candlestick series ──
      const candle = chart.addCandlestickSeries({
        upColor:         "#00ff88",
        downColor:       "#ff4466",
        borderUpColor:   "#00ff88",
        borderDownColor: "#ff4466",
        wickUpColor:     "#00ff88",
        wickDownColor:   "#ff4466",
      });

      // ── Fast SMA ──
      const fastLine = chart.addLineSeries({
        color:            "#00aaff",
        lineWidth:        2,
        title:            "Fast SMA (5)",
        priceLineVisible: false,
        lastValueVisible: true,
      });

      // ── Slow SMA ──
      const slowLine = chart.addLineSeries({
        color:            "#ffd700",
        lineWidth:        2,
        title:            "Slow SMA (20)",
        priceLineVisible: false,
        lastValueVisible: true,
      });

      // Set data
      candle.setData(bars.map(b => ({
        time: b.time as any, open: b.open, high: b.high, low: b.low, close: b.close,
      })));
      fastLine.setData(bars.filter(b => b.fast_sma !== null).map(b => ({
        time: b.time as any, value: b.fast_sma!,
      })));
      slowLine.setData(bars.filter(b => b.slow_sma !== null).map(b => ({
        time: b.time as any, value: b.slow_sma!,
      })));

      chart.timeScale().fitContent();

      chartRef.current  = chart;
      candleRef.current = candle;
      fastRef.current   = fastLine;
      slowRef.current   = slowLine;
    });

    return () => {
      resizeObs?.disconnect();
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch {}
        chartRef.current = null;
        candleRef.current = null;
        fastRef.current = null;
        slowRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, ticker]);

  // ── WebSocket with exponential backoff ────────────────────────────────────
  const connectWS = useCallback(() => {
    if (deadRef.current) return;

    // Build WS URL: convert http→ws, https→wss
    const base = API_URL.replace(/^http/, "ws");
    const url  = `${base}/ws/price/${ticker}`;

    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch { scheduleReconnect(); return; }

    wsRef.current = ws;

    ws.onopen = () => {
      retryDelay.current = 1000; // reset backoff on success
    };

    ws.onmessage = (evt) => {
      try {
        const tick = JSON.parse(evt.data) as { price: number };
        if (!tick.price) return;

        // Notify parent for header price display
        onPriceUpdate?.(tick.price);

        // Patch the last candle live
        if (candleRef.current && lastBarRef.current) {
          const last = lastBarRef.current;
          candleRef.current.update({
            time:  last.time as any,
            open:  last.open,
            high:  Math.max(last.high, tick.price),
            low:   Math.min(last.low,  tick.price),
            close: tick.price,
          });
        }
      } catch { /* bad frame */ }
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => { if (!deadRef.current) scheduleReconnect(); };

  }, [ticker, onPriceUpdate]);

  function scheduleReconnect() {
    const delay = Math.min(retryDelay.current, 30_000);
    retryDelay.current = delay * 2;
    setTimeout(connectWS, delay);
  }

  useEffect(() => {
    deadRef.current   = false;
    retryDelay.current = 1000;
    connectWS();
    return () => {
      deadRef.current = true;
      try { wsRef.current?.close(); } catch {}
    };
  }, [connectWS]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: 400, backgroundColor: "#111827", borderRadius: "2px" }}
    />
  );
}