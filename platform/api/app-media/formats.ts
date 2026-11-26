// What the media API accepts (ticket 3.18), decided from the bytes themselves, never from the declared type: a photo
// as JPEG, or a voice recording as a phone browser's MediaRecorder writes it (WebM/Opus, Ogg/Opus, MP4 with AAC or
// Opus audio). Each check walks the format's own structure (JPEG segments, EBML elements, Ogg pages, MP4 boxes), so a
// PNG, an HTML page, a script or a video (a WebM or MP4 with a video track, an Ogg/Theora) is refused. Every read is
// bounds-checked and every loop advances, so any byte string ends the walk.
//
// Photos lose their metadata (`stripJpegMetadata`): the location a phone writes lives in APP1 (Exif's GPS IFD, and
// XMP), and other APPn segments, comments and anything after the image's end can hold more.

export type MediaKind = "jpeg" | "webm" | "ogg" | "mp4";

/** The one content type each kind is stored and served with (never the client's). */
export const MEDIA_CONTENT_TYPES: Record<MediaKind, string> = {
  jpeg: "image/jpeg",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp4: "audio/mp4",
};

/** The kind of these bytes, or undefined when they are none of the accepted formats. */
export function detectMedia(bytes: Buffer): MediaKind | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return stripJpegMetadata(bytes) === undefined ? undefined : "jpeg";
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return isWebmAudio(bytes) ? "webm" : undefined;
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "OggS") return isOggOpus(bytes) ? "ogg" : undefined;
  if (bytes.length >= 8 && bytes.toString("latin1", 4, 8) === "ftyp") return isMp4Audio(bytes) ? "mp4" : undefined;
  return undefined;
}

// ---- JPEG ----

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
/** Start-of-frame markers (C0 to CF but DHT C4, JPG C8 and DAC CC). */
const isFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
/** Markers without a length (restart markers and TEM). */
const isStandalone = (marker: number): boolean => (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;

/**
 * Metadata segments that are kept: APP0 (JFIF), APP2 only when it is an ICC colour profile (an MPF APP2 points at the
 * extra pictures after the end, which are dropped) and APP14 (Adobe: how to read the colours). Every other APPn (APP1
 * Exif and XMP with the location, APP13 IPTC, makers' own) and every comment (COM) is removed.
 */
function keepSegment(marker: number, data: Buffer): boolean {
  if (marker === APP0 || marker === APP14) return true;
  if (marker === APP2) return data.toString("latin1", 0, 12) === "ICC_PROFILE\0";
  if (marker >= 0xe0 && marker <= 0xef) return false;
  return marker !== 0xfe;
}

/**
 * The JPEG without its metadata (see keepSegment) and without anything after its end (EOI): the same picture, which
 * still decodes. Undefined when the bytes are not a whole JPEG: no SOI, a segment running past the end, no frame,
 * no scan, or no EOI.
 */
export function stripJpegMetadata(bytes: Buffer): Buffer | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return undefined;
  const kept: Buffer[] = [bytes.subarray(0, 2)];
  let pos = 2;
  let frame = false;
  let scan = false;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) return undefined;
    // Fill bytes (FF FF ...) before a marker.
    let at = pos + 1;
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) return undefined;
    const marker = bytes[at] as number;
    if (marker === EOI) {
      if (!frame || !scan) return undefined;
      kept.push(Buffer.from([0xff, EOI]));
      return Buffer.concat(kept);
    }
    if (marker === SOI || marker === 0x00) return undefined;
    if (isStandalone(marker)) {
      kept.push(Buffer.from([0xff, marker]));
      pos = at + 1;
      continue;
    }
    if (at + 2 >= bytes.length) return undefined;
    const length = bytes.readUInt16BE(at + 1);
    const end = at + 1 + length;
    if (length < 2 || end > bytes.length) return undefined;
    const data = bytes.subarray(at + 3, end);
    if (isFrame(marker)) {
      // Precision, height, width, components: a frame of at least 1 x 1 with at least one component.
      if (data.length < 6 || data.readUInt16BE(1) === 0 || data.readUInt16BE(3) === 0 || data[5] === 0) return undefined;
      frame = true;
    }
    if (keepSegment(marker, data)) kept.push(Buffer.concat([Buffer.from([0xff, marker]), bytes.subarray(at + 1, end)]));
    pos = end;
    if (marker === SOS) {
      if (!frame) return undefined;
      scan = true;
      // The entropy-coded data runs to the next marker: an FF followed by neither 00 (a stuffed FF) nor a restart marker.
      let i = pos;
      while (i < bytes.length) {
        if (bytes[i] === 0xff) {
          const next = bytes[i + 1];
          if (next === undefined) return undefined;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
          i += next === 0xff ? 1 : 2;
        } else i += 1;
      }
      kept.push(bytes.subarray(pos, i));
      pos = i;
    }
  }
  return undefined;
}

// ---- WebM (EBML) ----

/** An EBML variable-length integer at `pos`: its length and value (`undefined` value for "unknown size"). */
function readVint(bytes: Buffer, pos: number, keepMarker: boolean): { length: number; value: number | undefined } | undefined {
  const first = bytes[pos];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8 || pos + length > bytes.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    const b = bytes[pos + i] as number;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { length, value: !keepMarker && allOnes ? undefined : value };
}

interface Element {
  id: number;
  dataStart: number;
  /** Undefined for an element of unknown size (runs to the end of its parent). */
  dataEnd: number | undefined;
}

function readElement(bytes: Buffer, pos: number, limit: number): Element | undefined {
  const id = readVint(bytes, pos, true);
  if (id === undefined || id.length > 4) return undefined;
  const size = readVint(bytes, pos + id.length, false);
  if (size === undefined) return undefined;
  const dataStart = pos + id.length + size.length;
  if (dataStart > limit) return undefined;
  if (size.value === undefined) return { id: id.value as number, dataStart, dataEnd: undefined };
  const dataEnd = dataStart + size.value;
  if (dataEnd > limit) return undefined;
  return { id: id.value as number, dataStart, dataEnd };
}

/** The child elements of [start, end); an element of unknown size ends the list (it runs to the end). */
function children(bytes: Buffer, start: number, end: number): Element[] | undefined {
  const found: Element[] = [];
  let pos = start;
  while (pos < end) {
    const el = readElement(bytes, pos, end);
    if (el === undefined) return undefined;
    found.push(el);
    if (el.dataEnd === undefined) return found;
    pos = el.dataEnd;
  }
  return found;
}

const EBML_HEADER = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CLUSTER = 0x1f43b675;
const AUDIO_TRACK = 2;

/** A WebM (DocType `webm`) whose tracks, listed before the first Cluster, are all Opus audio. */
function isWebmAudio(bytes: Buffer): boolean {
  const header = readElement(bytes, 0, bytes.length);
  if (header?.id !== EBML_HEADER || header.dataEnd === undefined) return false;
  const docType = children(bytes, header.dataStart, header.dataEnd)?.find((el) => el.id === DOC_TYPE);
  if (docType?.dataEnd === undefined || bytes.toString("latin1", docType.dataStart, docType.dataEnd) !== "webm") return false;
  const segment = readElement(bytes, header.dataEnd, bytes.length);
  if (segment?.id !== SEGMENT) return false;
  const segmentEnd = segment.dataEnd ?? bytes.length;
  // Walk the Segment's top-level elements up to the Tracks (MediaRecorder writes them before any Cluster).
  let pos = segment.dataStart;
  while (pos < segmentEnd) {
    const el = readElement(bytes, pos, segmentEnd);
    if (el === undefined || el.id === CLUSTER || el.dataEnd === undefined) return false;
    if (el.id === TRACKS) return tracksAreOpusAudio(bytes, el.dataStart, el.dataEnd);
    pos = el.dataEnd;
  }
  return false;
}

function tracksAreOpusAudio(bytes: Buffer, start: number, end: number): boolean {
  const entries = children(bytes, start, end)?.filter((el) => el.id === TRACK_ENTRY);
  if (entries === undefined || entries.length === 0) return false;
  return entries.every((entry) => {
    if (entry.dataEnd === undefined) return false;
    const fields = children(bytes, entry.dataStart, entry.dataEnd);
    const type = fields?.find((el) => el.id === TRACK_TYPE);
    const codec = fields?.find((el) => el.id === CODEC_ID);
    if (type?.dataEnd === undefined || codec?.dataEnd === undefined) return false;
    return bytes.readUIntBE(type.dataStart, Math.min(6, Math.max(1, type.dataEnd - type.dataStart))) === AUDIO_TRACK && bytes.toString("latin1", codec.dataStart, codec.dataEnd) === "A_OPUS";
  });
}

// ---- Ogg ----

/** An Ogg file whose beginning-of-stream pages (each stream's first) all start an Opus stream ("OpusHead"). */
function isOggOpus(bytes: Buffer): boolean {
  let pos = 0;
  let streams = 0;
  while (pos + 27 <= bytes.length && bytes.toString("latin1", pos, pos + 4) === "OggS") {
    const flags = bytes[pos + 5] as number;
    if ((flags & 0x02) === 0) break;
    const segments = bytes[pos + 26] as number;
    const tableEnd = pos + 27 + segments;
    if (tableEnd > bytes.length) return false;
    let size = 0;
    for (let i = pos + 27; i < tableEnd; i += 1) size += bytes[i] as number;
    if (tableEnd + size > bytes.length || bytes.toString("latin1", tableEnd, tableEnd + 8) !== "OpusHead") return false;
    streams += 1;
    pos = tableEnd + size;
  }
  return streams > 0;
}

// ---- MP4 ----

interface Box {
  type: string;
  start: number;
  end: number;
}

/** The boxes in [start, end); undefined when one runs past the end. */
function boxes(bytes: Buffer, start: number, end: number): Box[] | undefined {
  const found: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = bytes.readUInt32BE(pos);
    const type = bytes.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return undefined;
      size = Number(bytes.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return undefined;
    found.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
  return pos === end ? found : undefined;
}

const child = (bytes: Buffer, parent: Box | undefined, type: string): Box | undefined =>
  parent === undefined ? undefined : boxes(bytes, parent.start, parent.end)?.find((b) => b.type === type);

/** Audio sample entries in an MP4: AAC (`mp4a`) and Opus (`Opus`), as phone browsers record them. */
const MP4_AUDIO_ENTRIES = ["mp4a", "Opus"];

/** An MP4 (`ftyp` first) whose `moov` holds at least one track, every one a sound track (`soun`) of AAC or Opus. */
function isMp4Audio(bytes: Buffer): boolean {
  const top = boxes(bytes, 0, bytes.length);
  if (top === undefined || top[0]?.type !== "ftyp") return false;
  const moov = top.find((b) => b.type === "moov");
  const tracks = moov === undefined ? undefined : boxes(bytes, moov.start, moov.end)?.filter((b) => b.type === "trak");
  if (tracks === undefined || tracks.length === 0) return false;
  return tracks.every((trak) => {
    const mdia = child(bytes, trak, "mdia");
    const hdlr = child(bytes, mdia, "hdlr");
    // hdlr: version and flags (4), pre_defined (4), handler_type (4).
    if (hdlr === undefined || hdlr.end - hdlr.start < 12 || bytes.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "soun") return false;
    const stsd = child(bytes, child(bytes, child(bytes, mdia, "minf"), "stbl"), "stsd");
    // stsd: version and flags (4), entry count (4), then the sample entries (boxes).
    if (stsd === undefined || stsd.end - stsd.start < 8 || bytes.readUInt32BE(stsd.start + 4) < 1) return false;
    const entries = boxes(bytes, stsd.start + 8, stsd.end);
    return entries !== undefined && entries.length > 0 && entries.every((entry) => MP4_AUDIO_ENTRIES.includes(entry.type));
  });
}
