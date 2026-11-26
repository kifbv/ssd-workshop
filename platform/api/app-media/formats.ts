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
/** Restart markers (RST0 to RST7), kept; TEM (01) is dropped. */
const isRestart = (marker: number): boolean => marker >= 0xd0 && marker <= 0xd7;
/** The picture's own segments, kept as they are: DHT, DAC, DQT, DNL, DRI and SOS (frames are isFrame). */
const PICTURE_SEGMENTS = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd, SOS]);

/**
 * The segments that are kept (an allow-list, ticket 3.18 try 2): the picture's own (frames SOFn, DHT, DAC, DQT, DNL,
 * DRI, SOS; restart markers, SOI and EOI are handled apart) and three metadata segments: APP0 (JFIF), APP2 only when it
 * is an ICC colour profile (an MPF APP2 points at the extra pictures after the end, which are dropped) and APP14 (Adobe:
 * how to read the colours). Everything else goes: every other APPn (APP1 Exif and XMP with the location, APP13 IPTC,
 * makers' own), comments (COM), JPG and JPGn extensions (C8, F0 to FD), DHP and EXP (hierarchical JPEG, which browsers
 * do not decode) and reserved markers (02 to BF), any of which could carry text.
 */
function keepSegment(marker: number, data: Buffer): boolean {
  if (isFrame(marker) || PICTURE_SEGMENTS.has(marker)) return true;
  if (marker === APP0 || marker === APP14) return true;
  if (marker === APP2) return data.toString("latin1", 0, 12) === "ICC_PROFILE\0";
  return false;
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
      if (isRestart(marker)) kept.push(Buffer.from([0xff, marker]));
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
  /** Where the box's header (its size field) begins. */
  at: number;
  /** Where its data begins, after the header. */
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
    found.push({ type, at: pos, start: pos + header, end: pos + size });
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

// ---- Recording length (ticket 3.18 try 2) ----
//
// A recording is at most 5 minutes (Franck's answer); the server measures it from the container's own timing, never
// from a client's word. Each walk below is one pass over the file, every step moves forward by at least one header,
// and every count is checked against the bytes before it is used (a hostile count is multiplied, never looped over),
// so the time is linear in the file's size. A file whose length cannot be read is refused. A crafted file can still
// declare timings shorter than what it holds: the 4 MB cap is what bounds that (see docs/decisions.md).

export type RecordingKind = Exclude<MediaKind, "jpeg">;

/** The recording's length in seconds, from its container's timing, or undefined when it cannot be determined. */
export function recordingSeconds(bytes: Buffer, kind: RecordingKind): number | undefined {
  const seconds = kind === "webm" ? webmSeconds(bytes) : kind === "ogg" ? oggSeconds(bytes) : mp4Seconds(bytes);
  // NaN (a crafted float) is "cannot be determined"; Infinity is simply too long.
  return seconds === undefined || Number.isNaN(seconds) ? undefined : seconds;
}

/** Unsigned big-endian integer of `length` bytes (at most 8; beyond 2^53 precision does not matter here). */
function readUnsigned(bytes: Buffer, start: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + (bytes[start + i] as number);
  return value;
}

const larger = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

// WebM: Segment Info's TimecodeScale (nanoseconds per tick, default 1 ms) and Duration (a float, in ticks), and every
// block's time (its Cluster's Timecode plus the block's signed 16-bit relative timecode). MediaRecorder writes no
// Duration and Clusters of unknown size, so the walk is flat: it steps INTO Clusters and BlockGroups (known size or
// not) and over every other element by its size. The length is the larger of the declared Duration and the last block.
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TITLE = 0x7ba9;
const TAGS = 0x1254c367;
const CLUSTER_TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const VOID = 0xec;

function webmSeconds(bytes: Buffer): number | undefined {
  const header = readElement(bytes, 0, bytes.length);
  if (header?.id !== EBML_HEADER || header.dataEnd === undefined) return undefined;
  const segment = readElement(bytes, header.dataEnd, bytes.length);
  if (segment?.id !== SEGMENT) return undefined;
  const end = segment.dataEnd ?? bytes.length;
  let scale = 1_000_000;
  let declared: number | undefined;
  let clusterTime: number | undefined;
  let lastTick: number | undefined;
  let pos = segment.dataStart;
  while (pos < end) {
    const el = readElement(bytes, pos, end);
    if (el === undefined) return undefined;
    if (el.id === CLUSTER || el.id === BLOCK_GROUP) {
      if (el.id === CLUSTER) clusterTime = undefined;
      pos = el.dataStart;
      continue;
    }
    if (el.dataEnd === undefined) return undefined;
    const size = el.dataEnd - el.dataStart;
    if (el.id === INFO) {
      for (const field of children(bytes, el.dataStart, el.dataEnd) ?? []) {
        if (field.dataEnd === undefined) return undefined;
        const length = field.dataEnd - field.dataStart;
        if (field.id === TIMECODE_SCALE && length >= 1 && length <= 8) scale = readUnsigned(bytes, field.dataStart, length);
        if (field.id === DURATION && (length === 4 || length === 8)) declared = length === 4 ? bytes.readFloatBE(field.dataStart) : bytes.readDoubleBE(field.dataStart);
      }
    } else if (el.id === CLUSTER_TIMECODE) {
      if (size < 1 || size > 8) return undefined;
      clusterTime = readUnsigned(bytes, el.dataStart, size);
    } else if (el.id === SIMPLE_BLOCK || el.id === BLOCK) {
      // Track number (an EBML integer), then the time relative to the Cluster's (signed 16 bits).
      const track = readVint(bytes, el.dataStart, false);
      if (clusterTime === undefined || track === undefined || el.dataStart + track.length + 2 > el.dataEnd) return undefined;
      lastTick = larger(lastTick, clusterTime + bytes.readInt16BE(el.dataStart + track.length));
    }
    pos = el.dataEnd;
  }
  if (scale <= 0 || (declared !== undefined && Number.isNaN(declared))) return undefined;
  const toSeconds = (ticks: number | undefined) => (ticks === undefined ? undefined : (ticks * scale) / 1e9);
  return larger(toSeconds(declared), toSeconds(lastTick));
}

// Ogg/Opus: the last granule position of each stream (48,000 per second for Opus, whatever the input rate) less the
// stream's pre-skip (OpusHead). Every byte must belong to a page: a cut file is refused.
function oggSeconds(bytes: Buffer): number | undefined {
  const preSkip = new Map<number, number>();
  let seconds: number | undefined;
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 27 > bytes.length || bytes.toString("latin1", pos, pos + 4) !== "OggS") return undefined;
    const flags = bytes[pos + 5] as number;
    const granule = bytes.readBigInt64LE(pos + 6);
    const serial = bytes.readUInt32LE(pos + 14);
    const segments = bytes[pos + 26] as number;
    const tableEnd = pos + 27 + segments;
    if (tableEnd > bytes.length) return undefined;
    let size = 0;
    for (let i = pos + 27; i < tableEnd; i += 1) size += bytes[i] as number;
    if (tableEnd + size > bytes.length) return undefined;
    if ((flags & 0x02) !== 0) {
      if (size < 19 || bytes.toString("latin1", tableEnd, tableEnd + 8) !== "OpusHead") return undefined;
      preSkip.set(serial, bytes.readUInt16LE(tableEnd + 10));
    } else {
      const skip = preSkip.get(serial);
      if (skip === undefined) return undefined;
      // -1: no packet ends on this page; 0: the comment header's page (RFC 7845), before any audio.
      if (granule > 0n) seconds = larger(seconds, Number(granule - BigInt(skip)) / 48_000);
    }
    pos = tableEnd + size;
  }
  return seconds;
}

// MP4: the largest of the declared lengths (mvhd and each track's mdhd, mvex's mehd; "unknown" all-ones values and
// zeros are ignored) and the lengths the samples add up to: a plain file's sample tables (stts) and a fragmented
// file's fragments (MediaRecorder in Chromium and Safari writes `moof` + `mdat` pairs whose `trun` boxes list each
// sample's duration, or leave it to `tfhd`'s or `trex`'s default), each from its `tfdt` start or the previous
// fragment's end, in the track's own timescale (mdhd).
function fullBoxVersion(bytes: Buffer, box: Box): number {
  return bytes[box.start] as number;
}

/** A version 0/1 full box's (timescale, duration) as mvhd and mdhd lay them out, or undefined when cut. */
function scaleAndDuration(bytes: Buffer, box: Box): { scale: number; duration: number | undefined } | undefined {
  const v1 = fullBoxVersion(bytes, box) === 1;
  const scaleAt = box.start + (v1 ? 20 : 12);
  const durationLength = v1 ? 8 : 4;
  if (scaleAt + 4 + durationLength > box.end) return undefined;
  const scale = bytes.readUInt32BE(scaleAt);
  const raw = bytes.subarray(scaleAt + 4, scaleAt + 4 + durationLength);
  const unknown = raw.every((b) => b === 0xff);
  const duration = readUnsigned(bytes, scaleAt + 4, durationLength);
  return { scale, duration: unknown || duration === 0 ? undefined : duration };
}

function mp4Seconds(bytes: Buffer): number | undefined {
  const top = boxes(bytes, 0, bytes.length);
  const moov = top?.find((b) => b.type === "moov");
  if (top === undefined || moov === undefined) return undefined;
  const moovChildren = boxes(bytes, moov.start, moov.end);
  if (moovChildren === undefined) return undefined;
  let seconds: number | undefined;
  const consider = (units: number | undefined, scale: number): void => {
    if (units !== undefined && scale > 0) seconds = larger(seconds, units / scale);
  };
  const mvhd = moovChildren.find((b) => b.type === "mvhd");
  const movie = mvhd === undefined ? undefined : scaleAndDuration(bytes, mvhd);
  if (movie !== undefined) consider(movie.duration, movie.scale);
  const trackScale = new Map<number, number>();
  const trackDefault = new Map<number, number>();
  for (const trak of moovChildren.filter((b) => b.type === "trak")) {
    const tkhd = child(bytes, trak, "tkhd");
    const mdia = child(bytes, trak, "mdia");
    const mdhd = child(bytes, mdia, "mdhd");
    if (tkhd === undefined || mdhd === undefined) return undefined;
    const idAt = tkhd.start + (fullBoxVersion(bytes, tkhd) === 1 ? 20 : 12);
    const media = scaleAndDuration(bytes, mdhd);
    if (idAt + 4 > tkhd.end || media === undefined) return undefined;
    trackScale.set(bytes.readUInt32BE(idAt), media.scale);
    consider(media.duration, media.scale);
    // A plain file's sample table: entry count, then (sample count, sample duration) pairs.
    const stts = child(bytes, child(bytes, child(bytes, mdia, "minf"), "stbl"), "stts");
    if (stts !== undefined && stts.start + 8 <= stts.end) {
      const entries = bytes.readUInt32BE(stts.start + 4);
      if (stts.start + 8 + entries * 8 > stts.end) return undefined;
      let units = 0;
      for (let i = 0; i < entries; i += 1) units += bytes.readUInt32BE(stts.start + 8 + i * 8) * bytes.readUInt32BE(stts.start + 12 + i * 8);
      if (entries > 0) consider(units, media.scale);
    }
  }
  const mvex = moovChildren.find((b) => b.type === "mvex");
  for (const box of (mvex === undefined ? [] : boxes(bytes, mvex.start, mvex.end)) ?? []) {
    if (box.type === "mehd" && movie !== undefined) {
      const length = fullBoxVersion(bytes, box) === 1 ? 8 : 4;
      if (box.start + 4 + length > box.end) return undefined;
      const units = readUnsigned(bytes, box.start + 4, length);
      if (units > 0) consider(units, movie.scale);
    }
    // trex: version and flags, track_ID, default_sample_description_index, default_sample_duration.
    if (box.type === "trex") {
      if (box.start + 16 > box.end) return undefined;
      trackDefault.set(bytes.readUInt32BE(box.start + 4), bytes.readUInt32BE(box.start + 12));
    }
  }
  const trackEnd = new Map<number, number>();
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of boxes(bytes, moof.start, moof.end)?.filter((b) => b.type === "traf") ?? []) {
      const parts = boxes(bytes, traf.start, traf.end);
      const tfhd = parts?.find((b) => b.type === "tfhd");
      if (parts === undefined || tfhd === undefined || tfhd.start + 8 > tfhd.end) return undefined;
      const tfhdFlags = bytes.readUInt32BE(tfhd.start) & 0xffffff;
      const track = bytes.readUInt32BE(tfhd.start + 4);
      const scale = trackScale.get(track);
      if (scale === undefined) return undefined;
      // tfhd's optional fields: base data offset (8), sample description index (4), then the default duration (4).
      const defaultAt = tfhd.start + 8 + ((tfhdFlags & 0x01) !== 0 ? 8 : 0) + ((tfhdFlags & 0x02) !== 0 ? 4 : 0);
      if ((tfhdFlags & 0x08) !== 0 && defaultAt + 4 > tfhd.end) return undefined;
      const defaultDuration = (tfhdFlags & 0x08) !== 0 ? bytes.readUInt32BE(defaultAt) : trackDefault.get(track);
      const tfdt = parts.find((b) => b.type === "tfdt");
      let start = trackEnd.get(track) ?? 0;
      if (tfdt !== undefined) {
        const length = fullBoxVersion(bytes, tfdt) === 1 ? 8 : 4;
        if (tfdt.start + 4 + length > tfdt.end) return undefined;
        start = readUnsigned(bytes, tfdt.start + 4, length);
      }
      let units = 0;
      for (const trun of parts.filter((b) => b.type === "trun")) {
        if (trun.start + 8 > trun.end) return undefined;
        const flags = bytes.readUInt32BE(trun.start) & 0xffffff;
        const count = bytes.readUInt32BE(trun.start + 4);
        // Optional data offset (4) and first sample flags (4), then per sample: duration, size, flags, composition offset.
        const first = trun.start + 8 + ((flags & 0x01) !== 0 ? 4 : 0) + ((flags & 0x04) !== 0 ? 4 : 0);
        const perSample = 4 * [0x100, 0x200, 0x400, 0x800].filter((bit) => (flags & bit) !== 0).length;
        if (first + count * perSample > trun.end) return undefined;
        if ((flags & 0x100) !== 0) {
          for (let i = 0; i < count; i += 1) units += bytes.readUInt32BE(first + i * perSample);
        } else if (count > 0) {
          if (defaultDuration === undefined) return undefined;
          units += count * defaultDuration;
        }
      }
      trackEnd.set(track, start + units);
      if (units > 0) consider(start + units, scale);
    }
  }
  return seconds;
}

// ---- Recording metadata (ticket 3.18 try 2) ----
//
// MediaRecorder writes no location, but a file a phone's own recorder made (3.19's fallback) can carry a title or tags
// (iPhone's Voice Memos names a recording after the place). Where it is cheap and safe, such metadata is blanked IN
// PLACE, keeping every size and offset (a plain MP4's sample offsets point into the file): MP4 `udta` and `meta` boxes
// (top level, in `moov` and in each `trak`) become `free` boxes of the same size filled with zeros, and WebM's Tags and
// Info's Title become Void elements of the same size. Ogg's comments (OpusTags) are kept as received: changing them
// means recomputing page checksums, and the recorders that write Ogg (Firefox) put only an encoder name there.

/** A copy of the recording with its metadata blanked (see above); the same length, the same audio. */
export function stripRecordingMetadata(bytes: Buffer, kind: RecordingKind): Buffer {
  const copy = Buffer.from(bytes);
  if (kind === "mp4") blankMp4Metadata(copy);
  if (kind === "webm") blankWebmMetadata(copy);
  return copy;
}

const MP4_METADATA = ["udta", "meta"];

function blankMp4Metadata(bytes: Buffer): void {
  const blank = (list: Box[] | undefined): void => {
    for (const box of list ?? []) {
      if (!MP4_METADATA.includes(box.type)) continue;
      bytes.write("free", box.at + 4, "latin1");
      bytes.fill(0, box.start, box.end);
    }
  };
  const top = boxes(bytes, 0, bytes.length);
  blank(top);
  const moov = top?.find((b) => b.type === "moov");
  const moovChildren = moov === undefined ? undefined : boxes(bytes, moov.start, moov.end);
  blank(moovChildren);
  for (const trak of moovChildren?.filter((b) => b.type === "trak") ?? []) blank(boxes(bytes, trak.start, trak.end));
}

/** Turns the element [start, end) into a Void element of the same total size, its content zeros. */
function voidElement(bytes: Buffer, start: number, end: number): void {
  const total = end - start;
  bytes.fill(0, start, end);
  bytes[start] = VOID;
  // The size field takes the rest of the header: 8 bytes when there is room, else every byte left (value 0).
  const sizeLength = Math.min(8, total - 1);
  const value = total - 1 - sizeLength;
  bytes[start + 1] = 0x80 >> (sizeLength - 1);
  for (let i = 0; i < sizeLength - 1; i += 1) bytes[start + 1 + sizeLength - 1 - i] = Math.floor(value / 256 ** i) % 256;
}

function blankWebmMetadata(bytes: Buffer): void {
  const header = readElement(bytes, 0, bytes.length);
  if (header?.dataEnd === undefined) return;
  const segment = readElement(bytes, header.dataEnd, bytes.length);
  if (segment === undefined) return;
  const end = segment.dataEnd ?? bytes.length;
  // The same flat walk as webmSeconds: into Clusters and BlockGroups, over everything else, so Tags written after the
  // Clusters are found too.
  let pos = segment.dataStart;
  while (pos < end) {
    const el = readElement(bytes, pos, end);
    if (el === undefined) return;
    if (el.id === CLUSTER || el.id === BLOCK_GROUP) {
      pos = el.dataStart;
      continue;
    }
    if (el.dataEnd === undefined) return;
    if (el.id === TAGS) voidElement(bytes, pos, el.dataEnd);
    if (el.id === INFO) {
      let at = el.dataStart;
      while (at < el.dataEnd) {
        const field = readElement(bytes, at, el.dataEnd);
        if (field?.dataEnd === undefined) break;
        if (field.id === TITLE) voidElement(bytes, at, field.dataEnd);
        at = field.dataEnd;
      }
    }
    pos = el.dataEnd;
  }
}
