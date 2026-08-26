import { NextResponse } from "next/server";
import { getNearbyAddresses } from "@/lib/pdok";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat") ?? "");
  const lon = parseFloat(url.searchParams.get("lon") ?? "");

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return NextResponse.json({ error: "missing_coordinates" }, { status: 400 });
  }

  try {
    const addresses = await getNearbyAddresses(lat, lon, 20);
    return NextResponse.json({ addresses });
  } catch (err) {
    console.error("Nearby address lookup failed", err);
    return NextResponse.json({ error: "nearby_failed" }, { status: 502 });
  }
}
