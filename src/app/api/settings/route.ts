import { NextResponse } from "next/server";
import { updateSettings } from "@/server/desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(request: Request) {
  const result = await updateSettings(await request.json().catch(() => ({})));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
