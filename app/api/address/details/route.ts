import { NextResponse } from "next/server";
import { getAddressDetails } from "@/lib/pdok";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  try {
    const details = await getAddressDetails(id);
    return NextResponse.json({ details });
  } catch (err) {
    console.error("Address details lookup failed", err);
    return NextResponse.json({ error: "lookup_failed" }, { status: 502 });
  }
}
