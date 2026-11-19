"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { TAAL_COOKIE, vertaal, type Taal, type TaalSleutel } from "@/lib/taal";

interface TaalContextWaarde {
  taal: Taal;
  t: (sleutel: TaalSleutel, waarden?: Record<string, string | number>) => string;
  zetTaal: (taal: Taal) => void;
}

const TaalContext = createContext<TaalContextWaarde>({
  taal: "nl",
  t: (s, w) => vertaal("nl", s, w),
  zetTaal: () => {},
});

export function useTaal(): TaalContextWaarde {
  return useContext(TaalContext);
}

/**
 * De taal komt server-side mee uit een cookie (zie de layout), net als de
 * rechten: zo staat de eerste weergave al in de goede taal en flitst er geen
 * Nederlands voorbij voordat het Engels verschijnt.
 */
export default function TaalProvider({ taal: begin, children }: { taal: Taal; children: React.ReactNode }) {
  const [taal, setTaal] = useState<Taal>(begin);
  const router = useRouter();

  const zetTaal = useCallback(
    (nieuw: Taal) => {
      setTaal(nieuw);
      // Een jaar onthouden, per apparaat. De iPad in het veld houdt zo zijn taal.
      document.cookie = `${TAAL_COOKIE}=${nieuw}; path=/; max-age=31536000; samesite=lax`;
      document.documentElement.lang = nieuw;
      // Server-componenten (zoals <html lang>) opnieuw laten tekenen.
      router.refresh();
    },
    [router]
  );

  const t = useCallback<TaalContextWaarde["t"]>((s, w) => vertaal(taal, s, w), [taal]);

  return <TaalContext.Provider value={{ taal, t, zetTaal }}>{children}</TaalContext.Provider>;
}
