/**
 * Verkleint foto's vóór het uploaden. Een iPad-foto is al snel 3-5MB terwijl
 * voor de dossiervorming een fractie daarvan volstaat — dit scheelt dus
 * rechtstreeks uploadtijd op locatie. Bewust alleen voor foto-mappen: de
 * scan-uitvoer (Optimized/RAW) moet byte-voor-byte intact blijven.
 *
 * HEIC van de iPad wordt meteen JPEG, wat naast kleiner ook overal leesbaar is.
 */

/** Langste zijde na verkleinen. Ruim genoeg om gevel- en detailfoto's scherp te houden. */
const MAX_DIMENSION = 2560;
const JPEG_QUALITY = 0.85;
/** Onder deze grootte valt er weinig te winnen — dan laten we 'm met rust. */
const SKIP_BELOW_BYTES = 600 * 1024;

/**
 * Mappen waarin verkleinen níét mag: daar staat scan- en meetdata die
 * byte-voor-byte intact moet blijven. Overal elders is verkleinen veilig —
 * compressImage raakt sowieso alleen echte afbeeldingen aan, dus een PDF of
 * tekening in zo'n map blijft ongemoeid.
 */
const SCAN_FOLDERS = ["Optimized", "RAW", "LAZ"];

export function mayCompressFolder(folder: string): boolean {
  // De media-flow (mappen onder "in/") is een leveringsproduct: die foto's
  // gaan naar de makelaar en 360-panorama's naar een viewer — terugschalen
  // naar 2560px zou de levering zelf beschadigen. Verkleinen is er voor
  // dossierfoto's (energielabel, NEN-fotomappen), niet voor eindproducten.
  if (folder.startsWith("in/")) return false;
  return !SCAN_FOLDERS.includes(folder);
}

export function isCompressibleImage(file: File): boolean {
  if (!file.type.startsWith("image/")) return false;
  // Animaties en vectoren zou omzetten juist kapotmaken.
  return !/gif|svg/.test(file.type);
}

export async function compressImage(file: File): Promise<File> {
  if (!isCompressibleImage(file) || file.size < SKIP_BELOW_BYTES) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_DIMENSION / longest);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY)
    );
    // Geen winst (bv. een al goed geoptimaliseerde JPEG): origineel houden.
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.(heic|heif|png|webp|tiff?|bmp)$/i, ".jpg");
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    // Kan de browser dit formaat niet decoderen? Dan gewoon het origineel
    // versturen — een mislukte verkleining mag nooit de upload blokkeren.
    return file;
  }
}
