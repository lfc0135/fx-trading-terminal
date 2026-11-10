import fs from "fs";
import path from "path";
import { createBook } from "@/engine/paper";
import { UNIVERSE } from "@/engine/instruments";
import { DEFAULT_SETTINGS, type PaperBook, type StoredSettings } from "@/engine/types";
import { readConfig } from "./config";

export type EtoroMarks = {
  dayKey: string;
  monthKey: string;
  dayStartEquity: number;
  monthStartEquity: number;
  peakEquity: number;
  kill: { daily: boolean; drawdown: boolean };
};

export type FileState = {
  version: 1;
  book: PaperBook;
  instrumentIds: Record<string, number>;
  etoroMarks: EtoroMarks | null;
};

const dataFile = () => path.join(process.cwd(), "data", "desk.json");

function fresh(): FileState {
  const config = readConfig();
  return {
    version: 1,
    book: createBook(config.startingBalance, new Date(), DEFAULT_SETTINGS),
    instrumentIds: {},
    etoroMarks: null,
  };
}

function asSettings(value: unknown): StoredSettings {
  const raw = value && typeof value === "object" ? (value as Partial<StoredSettings>) : {};
  const watchlist = Array.isArray(raw.watchlist)
    ? raw.watchlist.map((item) => String(item).toUpperCase()).filter((item) => UNIVERSE.includes(item))
    : [];
  return {
    ...DEFAULT_SETTINGS,
    perTradeRiskPct: numberOr(raw.perTradeRiskPct, DEFAULT_SETTINGS.perTradeRiskPct),
    maxPositionNotionalPct: numberOr(raw.maxPositionNotionalPct, DEFAULT_SETTINGS.maxPositionNotionalPct),
    dailyLossKillPct: numberOr(raw.dailyLossKillPct, DEFAULT_SETTINGS.dailyLossKillPct),
    maxDrawdownKillPct: numberOr(raw.maxDrawdownKillPct, DEFAULT_SETTINGS.maxDrawdownKillPct),
    minStopPips: numberOr(raw.minStopPips, DEFAULT_SETTINGS.minStopPips),
    watchlist: watchlist.length > 0 ? watchlist : [...DEFAULT_SETTINGS.watchlist],
    realMoneyConfirmed: raw.realMoneyConfirmed === true,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeState(raw: unknown): FileState {
  if (!raw || typeof raw !== "object") return fresh();
  const record = raw as Partial<FileState>;
  const book = record.book;
  if (!book || typeof book !== "object" || typeof book.cash !== "number") return fresh();
  const settings = asSettings(book.settings);
  return {
    version: 1,
    instrumentIds:
      record.instrumentIds && typeof record.instrumentIds === "object"
        ? Object.fromEntries(
            Object.entries(record.instrumentIds).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
          )
        : {},
    etoroMarks: normalizeMarks((record as { etoroMarks?: unknown }).etoroMarks),
    book: {
      ...book,
      settings,
      positions: Array.isArray(book.positions) ? book.positions : [],
      orders: Array.isArray(book.orders) ? book.orders : [],
      trades: Array.isArray(book.trades) ? book.trades : [],
      equityCurve: Array.isArray(book.equityCurve) ? book.equityCurve : [],
      notices: Array.isArray(book.notices) ? book.notices : [],
      kill: {
        daily: book.kill?.daily === true,
        drawdown: book.kill?.drawdown === true,
      },
    },
  };
}

function normalizeMarks(value: unknown): EtoroMarks | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<EtoroMarks>;
  if (
    typeof raw.dayKey !== "string" ||
    typeof raw.monthKey !== "string" ||
    typeof raw.dayStartEquity !== "number" ||
    typeof raw.monthStartEquity !== "number" ||
    typeof raw.peakEquity !== "number"
  ) {
    return null;
  }
  return {
    dayKey: raw.dayKey,
    monthKey: raw.monthKey,
    dayStartEquity: raw.dayStartEquity,
    monthStartEquity: raw.monthStartEquity,
    peakEquity: raw.peakEquity,
    kill: {
      daily: raw.kill?.daily === true,
      drawdown: raw.kill?.drawdown === true,
    },
  };
}

function load(): FileState {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(dataFile(), "utf8")));
  } catch {
    const state = fresh();
    persist(state);
    return state;
  }
}

function persist(state: FileState): void {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, file);
}

export function readDesk(): FileState {
  return load();
}

let queue: Promise<unknown> = Promise.resolve();

export function withDesk<T>(
  fn: (state: FileState) => Promise<{ state: FileState; result: T }> | { state: FileState; result: T },
): Promise<T> {
  const run = queue.then(async () => {
    const current = load();
    const out = await fn(current);
    persist(out.state);
    return out.result;
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
