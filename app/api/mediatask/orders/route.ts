import { NextResponse } from "next/server";
import {
  addOrderComment,
  createOrder,
  getOrder,
  getProducts,
  listOrders,
  submitOrder,
  vindBestaandeDraft,
} from "@/lib/mediatask";
import { getFileLinksWithNames, getSharedAccessToken } from "@/lib/dropbox";
import { bewaarOrderPad, stuurScansVanuitDropbox, type ScanUitkomst } from "@/lib/mediatask-pointclouds";
import { stuurMediaVanuitDropboxMap, type MediaUitkomst } from "@/lib/mediatask-media";

// Twee doorgangen per scan over honderden MB's passen niet in een minuut.
export const maxDuration = 300;

/**
 * Geeft de (meest recente) Mediatask-orders terug — gebruikt om per adres
 * real-time te checken of er al een NEN2580-order bestaat, i.p.v. te
 * vertrouwen op onze eigen concept-administratie.
 *
 * Bewust niet gefilterd op eigenaar, en bewust wél uitgekleed. Niet gefilterd,
 * omdat de vraag "staat dit adres er al?" over het hele bureau gaat: een order
 * die een collega gisteren aanmaakte moet je vinden, anders maak je er een
 * tweede. Uitgekleed, omdat het antwoord daarvoor niet meer nodig heeft dan
 * het adres — wie wat gedaan heeft, met welk bureau en welke deadline, hoort
 * niet in de browser van iedereen terecht te komen.
 */
export async function GET() {
  try {
    const orders = (await listOrders()).map((o) => ({
      id: o.id,
      address: o.address,
      state: o.state,
    }));
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Orders ophalen mislukt" },
      { status: 502 }
    );
  }
}

/**
 * Maakt een NEN-order aan bij Mediatask. De foto's/tekeningen worden niet
 * opnieuw geüpload — we geven directe Dropbox-downloadlinks mee (D2+D5 als
 * foto's, D3 als tekeningen), Mediatask haalt ze zelf op.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    dropboxFolderPath?: string;
    productId?: number;
    priorityId?: string;
    agencyId?: string;
    productConfiguration?: Record<string, string>;
    submitNow?: boolean;
    city?: string;
    street?: string;
    number?: string;
    postcode?: string;
    extraPhotoUrls?: string[];
    extraDrawingUrls?: string[];
    /** Verdiepingen per geüpload Optimized-bestand, bv. {"scan.ply": [-1,0]}. */
    floorsByFile?: Record<string, number[]>;
    /** Alleen het concept aanmaken (en de Dropbox-map eraan koppelen), zonder
        opmerking, scans of indienen. Gebruikt bij de bevestigingspop-up aan
        het begin van de flow: de bestanden bestaan dan nog niet. */
    draftOnly?: boolean;
    /** Bestaande order afronden i.p.v. een nieuwe aanmaken — de tegenhanger
        van draftOnly, bij het afmaken op de documentenpagina. */
    orderId?: number;
  };

  if (
    !body.orderId &&
    (!body.productId || !body.priorityId || !body.agencyId || !body.city || !body.street || !body.number)
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  // Mediatask antwoordt op een onvolledige productconfiguratie met een kale
  // 500 zonder uitleg. Dat vooraf afvangen scheelt een mislukte order en een
  // onbegrijpelijke foutmelding: hier weten we tenminste wát er ontbreekt.
  const config = body.productConfiguration ?? {};
  const filled = Object.entries(config).filter(([, v]) => v !== "" && v != null);
  if (!body.orderId && filled.length === 0) {
    return NextResponse.json(
      {
        error:
          "De productconfiguratie (o.a. bruto vloeroppervlak, stijl, 2D/3D) is leeg. Ga terug naar de order en vul die eerst aan.",
      },
      { status: 400 }
    );
  }

  // Er gaan bewust géén Dropbox-links meer mee in de bestandsvelden van de
  // order. Die links kwamen niet zichtbaar op de order terecht — het vinkje
  // "naar Mediatask" beloofde dus iets wat niet gebeurde. Er zijn nu twee
  // eerlijke wegen: de scans uit Optimized gaan als échte puntenwolk
  // rechtstreeks van de iPad naar hun opslag (zie /api/mediatask/pointclouds),
  // en alles daaromheen deelt de verwerker via de Dropbox-links in de
  // opmerking hieronder. Alleen handmatig ingetikte URL's gaan nog mee als
  // veld: die typt iemand met opzet.
  const photos: string[] = [...(body.extraPhotoUrls ?? [])];
  const drawings: string[] = [...(body.extraDrawingUrls ?? [])];

  try {
    // Bestaat de order al (aangemaakt bij de bevestigingspop-up aan het
    // begin), dan alleen ophalen — een tweede createOrder zou een dubbele
    // order opleveren. Komt er géén ordernummer mee (hervat-pad, herlaadbeurt),
    // dan eerst bij Mediatask kijken of er al een concept voor dit adres
    // staat: dat is het vangnet tegen de duplicaat-drafts die daar anders
    // blijven rondslingeren.
    const bestaande = body.orderId
      ? null
      : await vindBestaandeDraft(body.street!, body.number!, body.city!).catch(() => null);
    const order = body.orderId
      ? await getOrder(body.orderId)
      : bestaande ??
        (await createOrder({
          product_id: body.productId!,
          priority_id: body.priorityId!,
          agency_id: body.agencyId!,
          state: "draft",
          city: body.city!,
          street: body.street!,
          number: body.number!,
          postcode: body.postcode,
          product_configuration: Object.fromEntries(filled),
          files: { photos, drawings, additional: [] },
        }));

    /*
      Hergebruiken mag, maar niet met een ander product.

      De order wordt aan het begin van de opname aangemaakt, zodat elke scan
      die binnenkomt er meteen aan gehangen kan worden. Het gevolg is dat een
      productwissel dáárna nergens meer aankomt: er bestaat bij Mediatask geen
      manier om het product van een bestaande order te wijzigen (zie
      lib/mediatask.ts — alleen aanmaken, ophalen, indienen en bestanden), en
      deze route schreef product en configuratie bij een bestaande order ook
      nooit weg. De opnemer koos dus "basis", en er werd een NEN2580 getekend.

      Stil doorgaan is hier de duurste uitkomst: de tekening komt terug op het
      verkeerde product en dat merk je pas bij de factuur. Daarom stopt het
      hier met een uitleg die zegt wat er moet gebeuren.
    */
    const gevraagdProduct = body.productId ? Number(body.productId) : null;
    if (gevraagdProduct && order.product_id && Number(order.product_id) !== gevraagdProduct) {
      const namen = await getProducts()
        .then((ps) => new Map(ps.map((p) => [p.id, p.full_name])))
        .catch(() => new Map<number, string>());
      const opDeOrder = namen.get(Number(order.product_id)) ?? `product ${order.product_id}`;
      const gekozen = namen.get(gevraagdProduct) ?? `product ${gevraagdProduct}`;
      return NextResponse.json(
        {
          error:
            `Voor dit adres staat al order #${order.id} bij Mediatask, met "${opDeOrder}". ` +
            `Jij koos "${gekozen}". Een order die er al staat kan hier niet van product wisselen: ` +
            `pas order #${order.id} aan in Mediatask, of annuleer hem daar en verstuur deze opname opnieuw.`,
          orderId: order.id,
          productOpOrder: Number(order.product_id),
        },
        { status: 409 }
      );
    }

    // Bij draftOnly stopt het hier: de opmerking (verdiepingen, links) en de
    // scans komen pas bij het afronden — de bestanden bestaan nu nog niet.
    // Wél alvast de Dropbox-map aan de order koppelen, zodat de achtergrond-
    // uploads van de puntenwolken de weg terug kunnen vinden.
    if (body.draftOnly) {
      if (body.dropboxFolderPath) await bewaarOrderPad(order.id, body.dropboxFolderPath);
      return NextResponse.json({ order, submitError: null, commentError: null, scans: [] });
    }

    // Verdiepingen als opmerking bij de order. Vóór het indienen, zodat de
    // verwerker het meteen ziet; een mislukte opmerking mag de order niet
    // laten sneuvelen — die is dan al aangemaakt.
    let commentError: string | null = null;
    // Opmerkingen bij Mediatask zijn altijd in het Engels: hun verwerkers
    // lezen geen Nederlands.
    const ordinal = (n: number) => {
      const rest10 = n % 10;
      const rest100 = n % 100;
      if (rest10 === 1 && rest100 !== 11) return `${n}st`;
      if (rest10 === 2 && rest100 !== 12) return `${n}nd`;
      if (rest10 === 3 && rest100 !== 13) return `${n}rd`;
      return `${n}th`;
    };
    const label = (n: number) =>
      n === 0 ? "ground floor" : n < 0 ? `basement level ${-n}` : `${ordinal(n)} floor`;
    const blokken: string[] = [];

    // Per scanbestand de bouwlagen, zodat de verwerker ziet wélke scan welke
    // verdiepingen bevat — bij meerdere scans per adres is dat het verschil
    // tussen bruikbaar en giswerk.
    const verdiepingen = Object.entries(body.floorsByFile ?? {})
      .filter(([, f]) => f.length > 0)
      .map(([name, f]) => `• ${name}: ${f.slice().sort((a, b) => a - b).map(label).join(", ")}`);
    if (verdiepingen.length > 0) {
      blokken.push(`Scanned floors per file:\n${verdiepingen.join("\n")}`);
    }

    // Downloadlinks in de opmerking. Dit is nu de enige weg waarlangs de
    // verwerker bij deze bestanden komt — de scans uit Optimized gaan wél
    // rechtstreeks mee als puntenwolk, al staan ze hier ook nog als link voor
    // het geval een puntenwolk niet doorkwam.
    if (body.dropboxFolderPath) {
      // Geen "also uploaded directly"-beloftes bij de media: Mediatask's API
      // accepteert geen foto-bijlagen (elke schrijfactie op het photos-veld
      // geeft 422 — live vastgesteld), dus deze links zíjn de aanlevering.
      const mappen: { map: string; kop: string }[] = [
        { map: "Optimized", kop: "Point clouds (Optimized) — also uploaded directly to this order" },
        { map: "RAW", kop: "RAW scans" },
        { map: "Additionals", kop: "Additional files" },
        { map: "Photo's", kop: "Photos — please download via these links" },
        { map: "Video", kop: "Video — please download via these links" },
        { map: "360", kop: "360 captures — please download via these links" },
      ];
      try {
        const at = await getSharedAccessToken();
        const perMap = await Promise.all(
          mappen.map((m) =>
            getFileLinksWithNames(at, `${body.dropboxFolderPath}/${m.map}`).catch(() => [])
          )
        );
        perMap.forEach((bestanden, i) => {
          if (bestanden.length === 0) return;
          blokken.push(`${mappen[i].kop}:\n${bestanden.map((f) => `• ${f.name}: ${f.url}`).join("\n")}`);
        });
      } catch (err) {
        console.error("Kon Dropbox-links voor de opmerking niet ophalen", err);
      }
    }

    if (blokken.length > 0) {
      try {
        await addOrderComment(order.id, blokken.join("\n\n"));
      } catch (err) {
        console.error("Mediatask comment failed", err);
        commentError = err instanceof Error ? err.message : "Opmerking plaatsen mislukt";
      }
    }

    // De scans uit Optimized gaan als echte puntenwolk mee. Dit gebeurt hier
    // en niet in de pagina, zodat het óók gebeurt als de order rechtstreeks
    // vanaf de orderpagina verstuurd wordt — daar ging het eerder mis: die
    // route maakte een order aan zonder ooit een scan mee te sturen.
    //
    // Vóór het indienen: aan een ingediende order valt bij Mediatask niets
    // meer toe te voegen, dus wat er dan niet aan hangt komt er nooit meer bij.
    let scans: ScanUitkomst[] = [];
    let media: MediaUitkomst[] = [];
    if (body.dropboxFolderPath) {
      // Onthouden bij welke map deze order hoort, zodat een scan die hun
      // verwerker later afkeurt opnieuw verstuurd kan worden.
      await bewaarOrderPad(order.id, body.dropboxFolderPath);
      scans = await stuurScansVanuitDropbox(order.id, body.dropboxFolderPath).catch((err) => {
        console.error("Puntenwolken doorsturen mislukt", err);
        return [];
      });

      // Foto's, video's en 360-opnames gaan als foto mee aan de order. Ook dit
      // vóór het indienen: aan een ingediende order valt bij Mediatask niets
      // meer toe te voegen. En net als bij de scans nooit blokkerend — de
      // order bestaat al, dus een foto die niet aankomt mag hem niet laten
      // sneuvelen; wat er misging staat per bestand in het antwoord.
      media = await stuurMediaVanuitDropboxMap(order.id, body.dropboxFolderPath).catch((err) => {
        console.error("Foto's en video's doorsturen mislukt", err);
        return [];
      });
    }

    // Indienen apart afvangen: de order bestaat op dit punt al bij Mediatask,
    // dus een mislukte submit mag niet als "hele upload mislukt" terugkomen —
    // anders maakt een tweede poging een dubbele order aan. De app toont dan
    // dat de order er staat maar handmatig ingediend moet worden.
    let submitError: string | null = null;
    if (body.submitNow) {
      try {
        await submitOrder(order.id);
        order.state = "submitted";
      } catch (err) {
        console.error("Mediatask order created but submit failed", err);
        submitError = err instanceof Error ? err.message : "Indienen mislukt";
      }
    }

    return NextResponse.json({
      order,
      submitError,
      commentError,
      scans,
      media,
      photoCount: photos.length,
      drawingCount: drawings.length,
      additionalCount: 0,
    });
  } catch (err) {
    console.error("Failed to create Mediatask order", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Order aanmaken bij Mediatask mislukt" },
      { status: 502 }
    );
  }
}
