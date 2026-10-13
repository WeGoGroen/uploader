"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "@/lib/upload-queue";

type Slot = { released?: boolean; release: () => Promise<void> };
type WakeLockApi = { request: (soort: "screen") => Promise<Slot> };

/**
 * Houdt het scherm wakker zolang er ergens een upload loopt.
 *
 * Een webpagina kan niet doorwerken als iOS het tabblad opschort: valt het
 * scherm in slaap, dan stopt de upload en gaat hij pas verder als je de app
 * weer opent. Dit is het enige wat een webapp daar realistisch tegen kan doen;
 * Safari kent geen achtergrond-upload.
 *
 * Dit stond in het mediascherm, en daar ging het op drie manieren mis:
 *  - Het keek alleen naar de opname die open stond. Na "Afronden" is er geen
 *    opname meer open, dus ging het slot eraf — terwijl het scherm er net bij
 *    zei dat de uploads doorliepen.
 *  - Het hing aan het áántal lopende uploads, dus bij elk afgerond bestand
 *    ging het slot los en werd het opnieuw aangevraagd, met telkens een gat.
 *  - iOS geeft het slot vrij zodra de pagina uit beeld gaat, en niets vroeg
 *    het terug. Eén keer wegklikken en het scherm viel alsnog in slaap.
 *
 * Nu staat het in de layout, kijkt het naar de héle wachtrij (dus ook naar
 * NEN- en energielabel-uploads), hangt het aan een ja/nee, en vraagt het het
 * slot opnieuw aan zodra de pagina weer in beeld is.
 */
export default function SchermWakker() {
  const taken = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const bezig = taken.some((t) => t.dropbox === "uploading");

  useEffect(() => {
    if (!bezig) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    // Niet ondersteund: dan werkt uploaden gewoon door, alleen zonder deze
    // bescherming.
    if (!wakeLock) return;

    let slot: Slot | null = null;
    let gestopt = false;
    let bezigMetAanvragen = false;

    const vraagAan = async () => {
      if (gestopt || bezigMetAanvragen || document.visibilityState !== "visible") return;
      if (slot && !slot.released) return;
      bezigMetAanvragen = true;
      try {
        const nieuw = await wakeLock.request("screen");
        if (gestopt) void nieuw.release().catch(() => {});
        else slot = nieuw;
      } catch {
        // Geweigerd (bv. energiebesparingsmodus): niets aan te doen.
      } finally {
        bezigMetAanvragen = false;
      }
    };

    const weerInBeeld = () => {
      if (document.visibilityState === "visible") void vraagAan();
    };

    void vraagAan();
    document.addEventListener("visibilitychange", weerInBeeld);
    return () => {
      gestopt = true;
      document.removeEventListener("visibilitychange", weerInBeeld);
      void slot?.release().catch(() => {});
    };
  }, [bezig]);

  return null;
}
