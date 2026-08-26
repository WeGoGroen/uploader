"use client";

import { useEffect } from "react";

/**
 * Vraagt bij de éérste aanraking van de app eenmalig toestemming voor
 * locatie, zodat "Locatie ophalen" tijdens de opname niet meer op een
 * toestemmings-pop-up hoeft te wachten. Bewust bij de eerste tik en niet
 * meteen bij het laden: Safari negeert een locatievraag zonder
 * gebruikersgebaar volledig, en Chrome telt weggeklikte promptjes zonder
 * gebaar mee richting een stille blokkade ("embargo") — precies wat we
 * willen voorkomen. Is de toestemming al gegeven of geweigerd, dan doet dit
 * niets (opnieuw vragen kan dan toch niet via de browser).
 */
export default function LocationPermission() {
  useEffect(() => {
    if (!("geolocation" in navigator)) return;

    const warmUp = () =>
      navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
        // maximumAge: een recente cached positie is prima — het gaat hier om
        // de toestemming, niet om de positie zelf.
        { timeout: 10000, maximumAge: 600000 }
      );

    const onFirstInteraction = () => {
      if (typeof navigator.permissions?.query === "function") {
        navigator.permissions
          .query({ name: "geolocation" })
          .then((status) => {
            if (status.state === "prompt") warmUp();
          })
          // Safari-versies zonder geolocation-support in permissions.query:
          // dan maar direct vragen — bij al gegeven toestemming is dat
          // onzichtbaar.
          .catch(warmUp);
      } else {
        warmUp();
      }
    };

    window.addEventListener("pointerdown", onFirstInteraction, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstInteraction);
  }, []);

  return null;
}
