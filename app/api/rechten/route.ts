import { NextResponse } from "next/server";
import { huidigeRechten } from "@/lib/rechten-server";

export const dynamic = "force-dynamic";

/** Wat de actieve gebruiker mag uploaden. Gebruikt door de knoppen op het
    startscherm, zodat er geen knop staat die tot een leeg formulier leidt. */
export async function GET() {
  return NextResponse.json(await huidigeRechten());
}
