import { NextResponse } from "next/server";
import { haalPersoneel } from "@/lib/personeel";

export const dynamic = "force-dynamic";

/**
 * De namen voor het inlogscherm. Publiek, want je hebt hem nodig vóórdat je
 * ingelogd bent — vandaar alleen naam, avatar en of de startcode nog geldt.
 * Codes, rollen, mailadressen en tokens blijven erbuiten.
 */
export async function GET() {
  try {
    const mensen = await haalPersoneel();
    return NextResponse.json({
      accounts: mensen.map((p) => ({ naam: p.naam, avatar: p.avatar, codeGewijzigd: p.codeGewijzigd })),
    });
  } catch (err) {
    return NextResponse.json(
      { accounts: [], fout: err instanceof Error ? err.message.slice(0, 200) : "onbekende fout" },
      { status: 200 }
    );
  }
}
