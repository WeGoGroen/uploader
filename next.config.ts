import type { NextConfig } from "next";

const nextConfig: NextConfig = {

  // Needed to open the dev server from a phone on the same network (LAN IP)
  // instead of only from localhost on this machine.
  allowedDevOrigins: ["127.0.0.1", "192.168.0.0/16", "10.0.0.0/8"],

  // Locatie expliciet toestaan voor de eigen origin. De browser-standaard is
  // hier al "self", dus dit verandert het huidige gedrag niet — het legt de
  // bedoeling vast en voorkomt dat een toekomstige (bredere) Permissions-
  // Policy geolocation per ongeluk dichtzet. Let op: een header kan locatie
  // alleen beperken, nooit afdwingen — de toestemmingsvraag zelf regelt
  // components/LocationPermission.tsx.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Permissions-Policy", value: "geolocation=(self)" }],
      },
    ];
  },
};

export default nextConfig;
