import { redirect } from "next/navigation";
import { huidigeRechten } from "@/lib/rechten-server";

/**
 * Houdt deze uploadstroom weg bij wie hem niet hoort te gebruiken. Server-side
 * en niet alleen door de knop te verbergen: een verborgen knop laat het adres
 * gewoon werken, en dan sta je alsnog in een formulier dat niet van jou is.
 *
 * De rechten worden ingesteld in het Business Control Center.
 */
export default async function Laag({ children }: { children: React.ReactNode }) {
  const { rechten } = await huidigeRechten();
  if (!rechten.media) redirect("/?geenrecht=media");
  return <>{children}</>;
}
