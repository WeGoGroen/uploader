/**
 * Dienst-token waarmee het Business Control Center deze app mag bevragen.
 *
 * Waarom een apart token en niet het inlogwachtwoord: het control center is
 * een machine, geen mens. Met een eigen token kun je hem intrekken zonder dat
 * er een opnemer op een iPad opeens buiten staat, en zie je in de logs het
 * verschil tussen "iemand keek" en "de synchronisatie draaide".
 *
 * De routes onder /api/intern zijn uitsluitend lezend en geven geen bestanden
 * terug, alleen tellingen en agendaregels.
 */
export function isInternRequest(request: Request): boolean {
  const token = process.env.CONTROL_CENTER_TOKEN;
  if (!token || token.length < 24) return false; // te kort = per ongeluk gezet
  const auth = request.headers.get("authorization") ?? "";
  const aangeboden = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (aangeboden.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ aangeboden.charCodeAt(i);
  return diff === 0;
}
