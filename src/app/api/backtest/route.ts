import { NextResponse } from "next/server";
import { requestBacktest } from "@/server/desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await requestBacktest(await request.json().catch(() => ({})));
  if (result && typeof result === "object" && "error" in result && !("trades" in result)) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
