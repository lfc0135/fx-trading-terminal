"use client";

import { useEffect, useRef } from "react";
import { ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/engine/types";

export function CandleChart({
  candles,
  decimals,
}: {
  candles: Candle[];
  decimals: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const next = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#b7c7bc",
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
      },
      grid: {
        vertLines: { color: "rgba(183, 199, 188, 0.06)" },
        horzLines: { color: "rgba(183, 199, 188, 0.06)" },
      },
      rightPriceScale: { borderColor: "rgba(183, 199, 188, 0.12)" },
      timeScale: { borderColor: "rgba(183, 199, 188, 0.12)", timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "rgba(214, 176, 96, 0.45)", labelBackgroundColor: "#3a3118" },
        horzLine: { color: "rgba(214, 176, 96, 0.45)", labelBackgroundColor: "#3a3118" },
      },
      localization: {
        timeFormatter: (time: number) =>
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Dubai",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).format(new Date(time * 1000)),
      },
    });
    const candleSeries = next.addCandlestickSeries({
      upColor: "#3cbe86",
      downColor: "#e36d64",
      borderVisible: false,
      wickUpColor: "#3cbe86",
      wickDownColor: "#e36d64",
      priceFormat: { type: "price", precision: decimals, minMove: 10 ** -decimals },
    });
    chart.current = next;
    series.current = candleSeries;
    return () => {
      next.remove();
      chart.current = null;
      series.current = null;
    };
  }, [decimals]);

  useEffect(() => {
    if (!series.current) return;
    const unique = new Map<number, Candle>();
    for (const candle of candles) unique.set(candle.time, candle);
    const data = [...unique.values()]
      .sort((a, b) => a.time - b.time)
      .map((candle) => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }));
    series.current.setData(data);
    chart.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={host} className="h-[340px] w-full md:h-[420px]" />;
}
