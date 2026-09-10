"use client";

import { createContext, useContext } from "react";

export interface UploadRechten {
  energielabel: boolean;
  nen: boolean;
  media: boolean;
}

/**
 * Wat de ingelogde persoon mag uploaden, beschikbaar voor het hele scherm.
 *
 * Het dashboard haalde dit zelf op met een fetch en ging er tot dat antwoord
 * binnen was van uit dat alles mocht — "anders knipperen de knoppen", stond
 * erbij. Het gevolg was erger dan geknipper: Jelle doet geen energielabels,
 * maar zag bij een adres wél "Energielabel" staan totdat het antwoord binnen
 * was, en bij een mislukte aanroep bleef het staan. Dan lees je op je eigen
 * dashboard dat er werk voor je is dat je niet eens kunt openen.
 *
 * De server weet dit al voordat er iets getekend wordt (zie de layout), dus
 * gaat het als waarde mee naar beneden in plaats van dat elk scherm het zelf
 * gaat vragen. Geen tussenstand waarin te veel getoond wordt.
 */
const RechtenContext = createContext<UploadRechten>({
  energielabel: false,
  nen: false,
  media: false,
});

/**
 * Onder welke naam je werkt.
 *
 * Dit werd op vier schermen uit ClickUp gehaald (/api/clickup/list-meta), en
 * die kent alleen mensen met een persoonlijk token. Jelle doet geen
 * energielabels en heeft er dus geen — zijn opnames werden daardoor zonder
 * naam opgeslagen. Gevolg: werk van niemand, dat op ieders dashboard verschijnt
 * omdat het aan geen enkel account te koppelen was. Wie je bent staat in de
 * sessie, en die is er altijd.
 */
const NaamContext = createContext<string | null>(null);

export function useRechten(): UploadRechten {
  return useContext(RechtenContext);
}

export function useIkBen(): string | null {
  return useContext(NaamContext);
}

export default function RechtenProvider({
  rechten,
  naam,
  children,
}: {
  rechten: UploadRechten;
  naam: string | null;
  children: React.ReactNode;
}) {
  return (
    <NaamContext.Provider value={naam}>
      <RechtenContext.Provider value={rechten}>{children}</RechtenContext.Provider>
    </NaamContext.Provider>
  );
}
