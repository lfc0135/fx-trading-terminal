import { NextResponse } from "next/server";
import { getDesk } from "@/server/desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const timeframe = Number(url.searchParams.get("timeframe"));
    const snapshot = await getDesk({
      symbol: url.searchParams.get("symbol") ?? undefined,
      timeframe: timeframe === 60 ? 60 : 15,
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Desk failed to load.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
