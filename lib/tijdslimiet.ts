/**
 * Een tijdslimiet voor fetch, of niets als de browser die niet kent.
 *
 * `AbortSignal.timeout` bestaat pas vanaf Safari 16. Op een oudere iPad zou de
 * kale aanroep een TypeError geven vóórdat fetch überhaupt begint — en dan
 * mislukt de upload om de bewaking die hem juist moest redden. Zonder limiet
 * werken is daar het mindere kwaad: dat is precies hoe het hiervoor deed.
 */
export function tijdslimiet(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}
