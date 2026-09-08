import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/**
 * Uitloggen is nu hetzelfde als "wissel van gebruiker": de sessie weg, en je
 * komt op het scherm waar je opnieuw je naam en code kiest. Er was hiervóór
 * helemaal geen uitlogroute — met één gedeelde code viel er ook niets uit te
 * loggen.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
