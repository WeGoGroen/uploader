import { NextResponse } from "next/server";
import { suggestAddresses } from "@/lib/pdok";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  if (!q || q.trim().length < 3) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const suggestions = await suggestAddresses(q.trim());
    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error("Address search failed", err);
    return NextResponse.json({ error: "search_failed" }, { status: 502 });
  }
}
