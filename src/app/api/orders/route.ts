import { NextResponse } from "next/server";
import { submitOrder } from "@/server/desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await submitOrder(await request.json().catch(() => ({})));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
