import { NextResponse } from "next/server";
import { resetPaperBook } from "@/server/desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await resetPaperBook(await request.json().catch(() => ({})));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
