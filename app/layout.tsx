import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import { huidigeRechten } from "@/lib/rechten-server";
import LocationPermission from "@/components/LocationPermission";
import UploadResume from "@/components/UploadResume";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Energielabel naar ClickUp",
  description: "Adres opzoeken via BAG en automatisch een ClickUp-taak aanmaken",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  /*
    De uploadrechten hier ophalen en meegeven, niet in de zijbalk zelf.

    De zijbalk is een client-component; die zou de rechten pas ná het laden
    kennen en de knoppen dus eerst tonen en daarna weghalen. Dat is precies wat
    er misging: Jelle heeft geen energielabelrecht, maar zag de knop wél staan
    en werd na het klikken teruggestuurd. Server-side meegeven betekent dat een
    knop die je niet mag er ook nooit staat.
  */
  const { rechten } = await huidigeRechten();

  return (
    <html
      lang="nl"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <LocationPermission />
        <UploadResume />
        <div className="shell">
          <Sidebar rechten={rechten} />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
