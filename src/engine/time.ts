export const DUBAI_TZ = "Asia/Dubai";

export type ZonedParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  dayKey: string;
  monthKey: string;
};

export function zonedParts(date: Date, timeZone = DUBAI_TZ): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = bag.hour ?? "00";
  if (hour === "24") hour = "00";
  const year = bag.year ?? "1970";
  const month = bag.month ?? "01";
  const day = bag.day ?? "01";
  return {
    year,
    month,
    day,
    hour,
    minute: bag.minute ?? "00",
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
  };
}

/**
 * Spot FX week used by this desk: open Sunday 22:00 UTC, close Friday 22:00 UTC.
 * That is Monday 02:00 through Saturday 02:00 in Asia/Dubai.
 */
export function isFxMarketOpen(date: Date): boolean {
  const day = date.getUTCDay();
  const tod =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3_600_000;
  if (day === 6) return false;
  if (day === 5 && tod >= 22) return false;
  if (day === 0 && tod < 22) return false;
  return true;
}

export type SessionInfo = {
  id: "sydney" | "tokyo" | "london" | "newyork";
  name: string;
  open: boolean;
  hoursUtc: string;
};

const SESSIONS: { id: SessionInfo["id"]; name: string; start: number; end: number; hoursUtc: string }[] = [
  { id: "sydney", name: "Sydney", start: 22, end: 7, hoursUtc: "22:00–07:00 UTC", },
  { id: "tokyo", name: "Tokyo", start: 0, end: 9, hoursUtc: "00:00–09:00 UTC" },
  { id: "london", name: "London", start: 7, end: 16, hoursUtc: "07:00–16:00 UTC" },
  { id: "newyork", name: "New York", start: 12, end: 21, hoursUtc: "12:00–21:00 UTC" },
];

function hourInside(hour: number, start: number, end: number): boolean {
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function fxSessions(date: Date): SessionInfo[] {
  const market = isFxMarketOpen(date);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return SESSIONS.map((session) => ({
    id: session.id,
    name: session.name,
    hoursUtc: session.hoursUtc,
    open: market && hourInside(hour, session.start, session.end),
  }));
}

export function dubaiTradingDaysElapsed(now: Date): number {
  const z = zonedParts(now);
  const year = Number(z.year);
  const month = Number(z.month);
  const day = Number(z.day);
  let count = 0;
  for (let d = 1; d <= day; d++) {
    const noonDubai = new Date(Date.UTC(year, month - 1, d, 8, 0, 0));
    const weekday = noonDubai.getUTCDay();
    if (weekday >= 1 && weekday <= 5) count += 1;
  }
  return count;
}

export function formatDubai(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DUBAI_TZ,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
