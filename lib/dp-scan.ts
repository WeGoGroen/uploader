/**
 * Lezer voor Dot3D-scanbestanden (".dp", de RAW-puntenwolk die de opnemer met
 * de iPad maakt). Het formaat is niet gedocumenteerd; deze parser is afgeleid
 * uit een echte scan (Dot3D 6.4.6, iPadOS). Structuur:
 *
 *   [16 bytes magic "DP_BINARY_DATA__"]
 *   [record]* met per record: uint32 key, uint32 lengte, <lengte> bytes payload
 *
 * De records staan in drie blokken achter elkaar: eerst ~45 kopvelden (keys
 * 0..500), dan één record per keyframe (keys >= 1000), dan één record per foto
 * (key 500). Alles is little-endian.
 *
 * Belangrijk voor de browser: een scan is al snel 300+ MB. Deze parser leest
 * daarom NOOIT het hele bestand — hij springt van record naar record en leest
 * per record alleen de eerste 104 bytes (kop + camerapositie). De zware
 * payloads (dieptedata per keyframe, JPEG's) worden overgeslagen en pas op
 * verzoek opgehaald. Eén volledige doorloop kost daardoor ~60 KB aan leeswerk,
 * ongeacht de bestandsgrootte.
 */

const MAGIC = "DP_BINARY_DATA__";

/** Recordsleutels die we herkennen. De rest slaan we over. */
const KEY = {
  KEYFRAME_COUNT: 0,
  CAPTURED_AT: 2,
  GLOBAL_TRANSFORM: 4,
  SAVED_AT: 5,
  LOG: 9,
  SOURCE_PATH: 37,
  PREVIEW: 402,
  IMU: 413,
  AUTOSAVE_PATH: 420,
  REFERENCE_DISTANCE: 408,
  PHOTO: 500,
  /** Alles >= dit is een keyframe (1000, 1001, 1002, ...). */
  KEYFRAME_MIN: 1000,
} as const;

/** Aantal bytes dat we per record vooruit lezen: 8 kop + 96 pose. */
const PROBE = 104;

export interface DpReader {
  readonly size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
}

export function blobReader(blob: Blob): DpReader {
  return {
    size: blob.size,
    async slice(start, end) {
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}

export function bytesReader(bytes: Uint8Array): DpReader {
  return {
    size: bytes.byteLength,
    async slice(start, end) {
      return bytes.subarray(start, Math.min(end, bytes.byteLength));
    },
  };
}

/**
 * Eén camerapositie tijdens het scannen. `r` is een 3x3-rotatiematrix
 * (rijgewijs), `t` de positie in millimeters in het lokale assenstelsel van de
 * scan — nog niet zwaartekracht-uitgelijnd, zie applyGlobalTransform.
 */
export interface DpPose {
  r: number[];
  t: [number, number, number];
}

export interface DpBlobRef {
  offset: number;
  length: number;
}

/**
 * Een met de laser ingemeten referentiemaat tussen twee AprilTags. Mediatask
 * eist er minimaal twee per bouwlaag, in loodrechte richtingen — daarmee wordt
 * de scan bij het optimaliseren op ware maat getrokken.
 */
export interface DpReferenceDistance {
  id: string;
  /** Nummers van de twee tags waartussen gemeten is. */
  fromTag: string;
  toTag: string;
  /** Ingevoerde afstand in meters. */
  distanceM: number;
}

export interface DpScan {
  /** Dot3D-versie, sensornummer en apparaat, uit het logveld. */
  dot3dVersion: string | null;
  sensorSerial: string | null;
  platform: string | null;
  /** Moment van scannen (uit het bestand, niet uit de bestandsdatum). */
  capturedAt: Date | null;
  /** Oorspronkelijke bestandsnaam op de iPad. */
  sourcePath: string | null;
  /** Aantal keyframes zoals het bestand het zelf opgeeft. */
  declaredKeyframes: number | null;
  /** 3x3-rotatie + translatie die de scan zwaartekracht-uitgelijnd maakt. */
  globalTransform: number[] | null;
  poses: DpPose[];
  photos: DpBlobRef[];
  /** Ingevoerde referentiematen tussen AprilTags. */
  referenceDistances: DpReferenceDistance[];
  preview: { width: number; height: number; png: DpBlobRef } | null;
  imu: { samples: number; durationSeconds: number } | null;
}

function u32(v: DataView, o: number) {
  return v.getUint32(o, true);
}

/**
 * Loopt het hele bestand door en verzamelt alles wat zonder de zware payloads
 * te lezen valt. Gooit als de magic niet klopt of de recordketen breekt — dat
 * laatste betekent een afgebroken upload of een ander formaat.
 */
export async function readDpScan(reader: DpReader): Promise<DpScan> {
  const head = await reader.slice(0, 16);
  if (new TextDecoder("latin1").decode(head) !== MAGIC) {
    throw new Error("Geen Dot3D-bestand (magic ontbreekt)");
  }

  const scan: DpScan = {
    dot3dVersion: null,
    sensorSerial: null,
    platform: null,
    capturedAt: null,
    sourcePath: null,
    declaredKeyframes: null,
    globalTransform: null,
    poses: [],
    photos: [],
    referenceDistances: [],
    preview: null,
    imu: null,
  };

  let off = 16;
  let records = 0;
  while (off + 8 <= reader.size) {
    const probe = await reader.slice(off, Math.min(off + PROBE, reader.size));
    if (probe.byteLength < 8) break;
    const view = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
    const key = u32(view, 0);
    const len = u32(view, 4);
    const body = off + 8;
    if (len > reader.size - body) {
      throw new Error(`Bestand is beschadigd of onvolledig (record op ${off})`);
    }

    if (key >= KEY.KEYFRAME_MIN) {
      // Kop + 96 bytes pose zitten al in de probe: 9 doubles rotatie, 3 translatie.
      if (probe.byteLength >= 104) {
        const r: number[] = [];
        for (let i = 0; i < 9; i++) r.push(view.getFloat64(8 + i * 8, true));
        scan.poses.push({
          r,
          t: [
            view.getFloat64(80, true),
            view.getFloat64(88, true),
            view.getFloat64(96, true),
          ],
        });
      }
    } else if (key === KEY.PHOTO) {
      // Payload = uint64 JPEG-lengte, daarna de JPEG zelf.
      const jpegLen = Number(view.getBigUint64(8, true));
      scan.photos.push({ offset: body + 8, length: jpegLen });
    } else if (len <= 2_000_000) {
      // Klein genoeg om echt te lezen.
      const payload =
        len <= probe.byteLength - 8
          ? probe.subarray(8, 8 + len)
          : await reader.slice(body, body + len);
      readHeaderField(scan, key, payload);
    }

    off = body + len;
    if (++records > 1_000_000) throw new Error("Te veel records — bestand niet vertrouwd");
  }

  return scan;
}

function readHeaderField(scan: DpScan, key: number, payload: Uint8Array) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  switch (key) {
    case KEY.KEYFRAME_COUNT:
      if (payload.byteLength >= 4) scan.declaredKeyframes = u32(view, 0);
      break;
    case KEY.CAPTURED_AT:
      if (payload.byteLength >= 8) {
        const secs = Number(view.getBigUint64(0, true));
        if (secs > 0) scan.capturedAt = new Date(secs * 1000);
      }
      break;
    case KEY.GLOBAL_TRANSFORM:
      if (payload.byteLength >= 96) {
        const m: number[] = [];
        for (let i = 0; i < 12; i++) m.push(view.getFloat64(i * 8, true));
        scan.globalTransform = m;
      }
      break;
    case KEY.LOG: {
      const text = new TextDecoder().decode(payload);
      scan.dot3dVersion = match(text, /Dot3D Version ([^\s=]+)/);
      scan.sensorSerial = match(text, /Sensor Serial:\s*(\S+)/);
      scan.platform = match(text, /Platform:\s*([^\n]+)/);
      break;
    }
    case KEY.SOURCE_PATH:
      scan.sourcePath = new TextDecoder().decode(payload).replace(/\0+$/, "");
      break;
    case KEY.PREVIEW:
      if (payload.byteLength > 8) {
        scan.preview = {
          width: u32(view, 0),
          height: u32(view, 4),
          // De offset is relatief aan het bestand, niet aan de payload; de
          // aanroeper heeft alleen breedte/hoogte nodig plus de PNG-bytes,
          // die we hier direct meegeven via een kopie in het PNG-veld.
          png: { offset: -1, length: payload.byteLength - 8 },
        };
        previewCache.set(scan, payload.subarray(8));
      }
      break;
    case KEY.REFERENCE_DISTANCE: {
      // Drie lengte-geprefixte strings (id, tag A, tag B) gevolgd door de
      // ingevoerde afstand als double in millimeters.
      let pos = 0;
      const str = (): string | null => {
        if (pos + 4 > payload.byteLength) return null;
        const len = u32(view, pos);
        if (pos + 4 + len > payload.byteLength) return null;
        const s = new TextDecoder().decode(payload.subarray(pos + 4, pos + 4 + len));
        pos += 4 + len;
        return s;
      };
      const id = str();
      const fromTag = str();
      const toTag = str();
      if (id === null || fromTag === null || toTag === null) break;
      if (pos + 8 > payload.byteLength) break;
      const mm = view.getFloat64(payload.byteLength - 8, true);
      if (!Number.isFinite(mm) || mm <= 0) break;
      scan.referenceDistances.push({ id, fromTag, toTag, distanceM: mm / 1000 });
      break;
    }
    case KEY.IMU: {
      // uint32 aantal, daarna 56 bytes per sample: uint32 tijdstempel (µs),
      // uint32 type, 6 doubles. Duur = laatste tijdstempel min eerste.
      if (payload.byteLength < 4 + 56) break;
      const n = u32(view, 0);
      if (n < 2 || 4 + n * 56 > payload.byteLength) break;
      const first = u32(view, 4);
      const last = u32(view, 4 + (n - 1) * 56);
      scan.imu = { samples: n, durationSeconds: (last - first) / 1_000_000 };
      break;
    }
  }
}

const previewCache = new WeakMap<DpScan, Uint8Array>();

/** De ingebedde PNG-preview (laatste camerabeeld van de scan), of null. */
export function getPreviewPng(scan: DpScan): Uint8Array | null {
  return previewCache.get(scan) ?? null;
}

/** Haalt één foto op uit het bestand. Alleen aanroepen voor foto's die je echt nodig hebt. */
export async function readPhoto(reader: DpReader, ref: DpBlobRef): Promise<Uint8Array> {
  return reader.slice(ref.offset, ref.offset + ref.length);
}

function match(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}
