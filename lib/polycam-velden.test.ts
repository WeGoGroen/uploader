import { describe, expect, it } from "vitest";
import { haalPolycamLink, isPuntenwolk, lasBestandsnaam, verdiepingUitVeldnaam } from "@/lib/polycam-velden";

describe("verdiepingUitVeldnaam", () => {
  it("haalt code en 'Polycam link' weg", () => {
    expect(verdiepingUitVeldnaam("D8.1 Polycam link - Begane grond")).toBe("Begane grond");
    expect(verdiepingUitVeldnaam("D8.2 Polycam link - 1e verdieping (indien aanwezig)")).toBe("1e verdieping");
    expect(verdiepingUitVeldnaam("D8.3 - Polycam link - 2e verdieping (indien aanwezig)")).toBe("2e verdieping");
    expect(verdiepingUitVeldnaam("D8.6Polycam link - Extra 2")).toBe("Extra 2");
  });
});

describe("haalPolycamLink", () => {
  it("accepteert een kale deellink", () => {
    expect(haalPolycamLink("https://poly.cam/capture/8F3A2C91")).toBe("https://poly.cam/capture/8F3A2C91");
  });

  it("vist de link uit een deelzinnetje", () => {
    expect(haalPolycamLink("Check out my 3D capture! https://poly.cam/capture/abc123.")).toBe(
      "https://poly.cam/capture/abc123"
    );
  });

  it("accepteert subdomeinen van poly.cam", () => {
    expect(haalPolycamLink("  https://share.poly.cam/v/xyz  ")).toBe("https://share.poly.cam/v/xyz");
  });

  it("weigert andere sites, http en de kale homepage", () => {
    expect(haalPolycamLink("https://dropbox.com/s/abc")).toBeNull();
    expect(haalPolycamLink("https://poly.cam.evil.nl/capture/abc")).toBeNull();
    expect(haalPolycamLink("http://poly.cam/capture/abc")).toBeNull();
    expect(haalPolycamLink("https://poly.cam/")).toBeNull();
    expect(haalPolycamLink("geen link")).toBeNull();
  });
});

describe("lasBestandsnaam", () => {
  it("zet de verdieping ervoor", () => {
    expect(lasBestandsnaam("Begane grond", "10_11_2026.las")).toBe("Begane grond - 10_11_2026.las");
  });

  it("maakt tekens veilig en zet de verdieping er niet dubbel voor", () => {
    expect(lasBestandsnaam("1e verdieping", "scan:1/2.laz")).toBe("1e verdieping - scan-1-2.laz");
    expect(lasBestandsnaam("Begane grond", "Begane grond - x.las")).toBe("Begane grond - x.las");
  });
});

describe("isPuntenwolk", () => {
  it("herkent LAS en LAZ", () => {
    expect(isPuntenwolk("a.LAS")).toBe(true);
    expect(isPuntenwolk("a.laz")).toBe(true);
    expect(isPuntenwolk("a.glb")).toBe(false);
  });
});
