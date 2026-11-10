import { clampLeverageCap, DEFAULT_LEVERAGE_CAP } from "@/engine/leverage";

export type AppConfig = {
  venue: "paper" | "etoro";
  etoroMode: "demo" | "real";
  apiKey: string;
  userKey: string;
  baseUrl: string;
  leverageCap: number;
  startingBalance: number;
  keysConfigured: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const venue = env.TRADING_VENUE === "etoro" ? "etoro" : "paper";
  const etoroMode = env.ETORO_TRADING_MODE === "real" ? "real" : "demo";
  const apiKey = (env.ETORO_API_KEY ?? "").trim();
  const userKey = (env.ETORO_USER_KEY ?? "").trim();
  const leverageCap = clampLeverageCap(Number(env.LEVERAGE_CAP ?? DEFAULT_LEVERAGE_CAP));
  let startingBalance = Number(env.PAPER_STARTING_BALANCE ?? "50000");
  if (!Number.isFinite(startingBalance) || startingBalance < 1000) startingBalance = 50_000;
  const baseUrl = (env.ETORO_API_BASE || "https://public-api.etoro.com").replace(/\/$/, "");
  return {
    venue,
    etoroMode,
    apiKey,
    userKey,
    baseUrl,
    leverageCap,
    startingBalance,
    keysConfigured: Boolean(apiKey && userKey),
  };
}
