import { redirect } from "next/navigation";

// Het dashboard is verhuisd naar de hoofdpagina — deze route blijft bestaan
// voor oude bladwijzers/links.
export default function DashboardRedirect() {
  redirect("/");
}
