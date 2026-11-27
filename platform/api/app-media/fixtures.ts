// Test files for the media API (ticket 3.18), built byte by byte at run time: no binary blobs in the repository. Not
// bundled (no handler imports it). They have the structure the media checks read (JPEG segments, WebM/EBML elements,
// Ogg pages, MP4 boxes), padded to any size; real encoder output (Chromium's canvas JPEG, MediaRecorder's WebM) is
// checked in browser.test.ts.

const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Bytes without 0xFF (so a JPEG's entropy-coded data holds no marker), of the given length. */
export function filler(length: number, seed = 7): Buffer {
  const b = Buffer.alloc(length);
  let x = seed;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = (x >>> 16) % 255;
  }
  return b;
}

/** A JPEG segment: FF <marker> <length including itself> <data>. */
export const segment = (marker: number, data: Buffer): Buffer => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);

/** An APP1 Exif segment whose IFD0 points to a GPS IFD holding a latitude and longitude (Paris), big-endian TIFF. */
export function exifWithGps(): Buffer {
  // TIFF header, IFD0 with one entry: GPSInfo (0x8825) -> offset of the GPS IFD.
  const rational = (n: number, d: number) => Buffer.concat([u32(n), u32(d)]);
  const gpsIfdOffset = 8 + 2 + 12 + 4;
  const gpsEntries = 4;
  const gpsDataOffset = gpsIfdOffset + 2 + gpsEntries * 12 + 4;
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const tiff = Buffer.concat([
    Buffer.from("MM"),
    u16(42),
    u32(8),
    u16(1),
    entry(0x8825, 4, 1, u32(gpsIfdOffset)),
    u32(0),
    u16(gpsEntries),
    entry(0x0001, 2, 2, Buffer.from("N\0\0\0")),
    entry(0x0002, 5, 3, u32(gpsDataOffset)),
    entry(0x0003, 2, 2, Buffer.from("E\0\0\0")),
    entry(0x0004, 5, 3, u32(gpsDataOffset + 24)),
    u32(0),
    rational(48, 1),
    rational(51, 1),
    rational(2952, 100),
    rational(2, 1),
    rational(21, 1),
    rational(799, 100),
  ]);
  return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), tiff]));
}

/** An XMP packet in APP1 (another place a phone writes the location). */
export const xmpWithGps = (): Buffer =>
  segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="48,51.29N"/></x:xmpmeta>'));

/**
 * A baseline JPEG's structure: SOI, APP0 (JFIF), DQT, SOF0 (16 x 16, 1 component), DHT, SOS, `scan` bytes of
 * entropy-coded data, EOI. `extra` segments go right after APP0 (where cameras put Exif). Not a decodable picture.
 */
export function jpegOfSize(totalBytes: number, extra: Buffer[] = []): Buffer {
  const head = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...extra,
    segment(0xdb, Buffer.concat([Buffer.from([0]), filler(64, 3)])),
    segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])),
    segment(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.alloc(0)])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  ]);
  const scan = filler(Math.max(1, totalBytes - head.length - 2));
  return Buffer.concat([head, scan, Buffer.from([0xff, 0xd9])]);
}

// ---- WebM (EBML) ----

/** An EBML size: 8 bytes, marker 0x01 (any size up to 2^56). */
const ebmlSize = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  b.writeUIntBE(Math.floor(n / 2 ** 32), 1, 3);
  b.writeUInt32BE(n % 2 ** 32, 4);
  return b;
};
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const element = (id: number[], data: Buffer): Buffer => Buffer.concat([Buffer.from(id), ebmlSize(data.length), data]);

/**
 * A WebM as MediaRecorder writes it (Segment and Cluster of unknown size, no Duration), with one track per codec, padded
 * to `totalBytes`: one Cluster whose Timecode is `seconds` (TimecodeScale 1 ms) holding one SimpleBlock at relative time
 * 0, so the recording measures `seconds` long. `declaredSeconds` adds Info's Duration (an 8-byte float, in ms).
 */
export function webmOfSize(totalBytes: number, codecs: string[] = ["A_OPUS"], docType = "webm", seconds = 10, declaredSeconds?: number): Buffer {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], Buffer.concat([element([0x42, 0x86], Buffer.from([1])), element([0x42, 0x82], Buffer.from(docType))]));
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    Buffer.concat(
      codecs.map((codec, i) =>
        element([0xae], Buffer.concat([element([0xd7], Buffer.from([i + 1])), element([0x83], Buffer.from([codec.startsWith("V_") ? 1 : 2])), element([0x86], Buffer.from(codec))])),
      ),
    ),
  );
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE((declaredSeconds ?? 0) * 1000);
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), ...(declaredSeconds === undefined ? [] : [element([0x44, 0x89], duration)])]),
  );
  const timecode = element([0xe7], u32(Math.round(seconds * 1000)));
  const start = Buffer.concat([header, Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN_SIZE, info, tracks, Buffer.from([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN_SIZE, timecode]);
  // SimpleBlock: track 1 (0x81), relative time 0, flags (keyframe), then the frame.
  const blockHead = Buffer.from([0x81, 0x00, 0x00, 0x80]);
  const room = Math.max(0, totalBytes - start.length - 1 - 8 - blockHead.length);
  return Buffer.concat([start, Buffer.from([0xa3]), ebmlSize(room + blockHead.length), blockHead, filler(room)]);
}

// ---- Ogg ----

/** One Ogg page holding one packet (at most 255 x 255 bytes). */
function oggPage(packet: Buffer, flags: number, sequence: number, serial = 1, granule = 0n): Buffer {
  const lacing: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  const position = Buffer.alloc(8);
  position.writeBigInt64LE(granule);
  return Buffer.concat([Buffer.from("OggS"), Buffer.from([0, flags]), position, u32(serial), u32(sequence), Buffer.alloc(4), Buffer.from([lacing.length]), Buffer.from(lacing), packet]);
}

/** Opus's pre-skip in the fixtures' OpusHead (0x0138 = 312 samples at 48 kHz). */
export const OGG_PRE_SKIP = 312;
const OPUS_HEAD = Buffer.concat([Buffer.from("OpusHead"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]);

/**
 * An Ogg file whose first (BOS) page starts the given stream ("OpusHead" or a Theora header), padded with data pages;
 * the last page's granule position makes it `seconds` long (48 kHz, plus the pre-skip). `seconds` null leaves
 * every data page at -1 (no packet ends there), so the length cannot be read.
 */
export function oggOfSize(totalBytes: number, head: Buffer = OPUS_HEAD, seconds: number | null = 10): Buffer {
  const pages = [oggPage(head, 0x02, 0), oggPage(Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)]), 0, 1)];
  let size = pages.reduce((n, p) => n + p.length, 0);
  let sequence = 2;
  while (size < totalBytes || pages.length < 3) {
    const page = oggPage(filler(Math.min(60_000, Math.max(1, totalBytes - size - 300))), 0, sequence, 1, -1n);
    pages.push(page);
    size += page.length;
    sequence += 1;
  }
  if (seconds !== null) (pages[pages.length - 1] as Buffer).writeBigInt64LE(BigInt(Math.round(seconds * 48_000) + OGG_PRE_SKIP), 6);
  return Buffer.concat(pages);
}

// ---- MP4 ----

const box = (type: string, ...children: Buffer[]): Buffer => {
  const body = Buffer.concat(children);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
};

/** mvhd or mdhd, version 0: version and flags, creation and modification times, timescale, duration (then zeros). */
const timedBox = (type: "mvhd" | "mdhd", scale: number, duration: number, size: number): Buffer => box(type, Buffer.alloc(12), u32(scale), u32(duration), Buffer.alloc(size - 28));
/** tkhd, version 0: version and flags, creation and modification times, track_ID (then zeros). */
const tkhd = (track: number): Buffer => box("tkhd", Buffer.alloc(12), u32(track), Buffer.alloc(64));

function mp4Track([handler, entry]: [string, string], track: number, mediaScale: number, mediaDuration: number, stts: Buffer = Buffer.concat([Buffer.alloc(4), u32(0)])): Buffer {
  return box(
    "trak",
    tkhd(track),
    box(
      "mdia",
      timedBox("mdhd", mediaScale, mediaDuration, 32),
      box("hdlr", Buffer.alloc(8), Buffer.from(handler, "latin1"), Buffer.alloc(13)),
      box("minf", box("stbl", box("stsd", Buffer.alloc(4), u32(1), box(entry, Buffer.alloc(28))), box("stts", stts))),
    ),
  );
}

/**
 * A plain MP4 with one track per [handler, sample entry] (`soun`/`mp4a` is AAC audio, `vide`/`avc1` is video), padded
 * with `mdat`; mvhd declares `seconds` (timescale 1000). `extra` boxes go into `moov` (a `udta`, say).
 */
export function mp4OfSize(totalBytes: number, tracks: [string, string][] = [["soun", "mp4a"]], seconds = 10, extra: Buffer[] = []): Buffer {
  const head = Buffer.concat([
    box("ftyp", Buffer.from("M4A ", "latin1"), u32(0), Buffer.from("isomM4A ", "latin1")),
    box("moov", timedBox("mvhd", 1000, Math.round(seconds * 1000), 108), ...tracks.map((t, i) => mp4Track(t, i + 1, 48_000, 0)), ...extra),
  ]);
  return Buffer.concat([head, box("mdat", filler(Math.max(0, totalBytes - head.length - 8)))]);
}

/** A plain MP4 whose only length is its sample table: `count` samples of `delta` at 48 kHz (mvhd and mdhd say 0). */
export function mp4WithSampleTable(count: number, delta: number): Buffer {
  const stts = Buffer.concat([Buffer.alloc(4), u32(1), u32(count), u32(delta)]);
  const head = Buffer.concat([box("ftyp", Buffer.from("M4A ", "latin1"), u32(0)), box("moov", timedBox("mvhd", 1000, 0, 108), mp4Track(["soun", "mp4a"], 1, 48_000, 0, stts))]);
  return Buffer.concat([head, box("mdat", filler(1000))]);
}

/**
 * A fragmented MP4 as MediaRecorder writes it (Chromium: Opus with per-sample durations in `trun`; Safari: AAC): an
 * empty `moov` (mvhd and mdhd say 0) with `mvex`/`trex`, then `fragments` pairs of `moof` + `mdat` of AAC frames (1,024
 * samples at 48 kHz) adding up to `seconds`. `durations` says where each sample's duration is written: in `trun` per
 * sample, as `tfhd`'s default, or only as `trex`'s default; `tfdt: false` leaves each fragment to start where the
 * previous one ended.
 */
export function fragmentedMp4(seconds: number, options: { fragments?: number; durations?: "trun" | "tfhd" | "trex"; tfdt?: boolean; entry?: string } = {}): Buffer {
  const { fragments = 4, durations = "trun", tfdt = true, entry = "mp4a" } = options;
  const frame = 1024;
  const perFragment = Math.ceil((seconds * 48_000) / frame / fragments);
  const moov = box(
    "moov",
    timedBox("mvhd", 1000, 0, 108),
    mp4Track(["soun", entry], 1, 48_000, 0),
    box("mvex", box("trex", Buffer.alloc(4), u32(1), u32(1), u32(durations === "trex" ? frame : 0), u32(0), u32(0))),
  );
  const parts: Buffer[] = [box("ftyp", Buffer.from("iso6", "latin1"), u32(0), Buffer.from("iso6mp41", "latin1")), moov];
  for (let f = 0; f < fragments; f += 1) {
    const tfhdFlags = 0x020000 | (durations === "tfhd" ? 0x08 : 0);
    const tfhdBox = box("tfhd", u32(tfhdFlags), u32(1), ...(durations === "tfhd" ? [u32(frame)] : []));
    const tfdtBox = box("tfdt", Buffer.from([1, 0, 0, 0]), Buffer.alloc(4), u32(f * perFragment * frame));
    const trunFlags = 0x000001 | 0x000200 | (durations === "trun" ? 0x000100 : 0);
    const samples = Array.from({ length: perFragment }, () => (durations === "trun" ? Buffer.concat([u32(frame), u32(10)]) : u32(10)));
    const trun = box("trun", u32(trunFlags), u32(perFragment), u32(0), ...samples);
    parts.push(box("moof", box("mfhd", Buffer.alloc(4), u32(f + 1)), box("traf", tfhdBox, ...(tfdt ? [tfdtBox] : []), trun)), box("mdat", filler(perFragment * 10)));
  }
  return Buffer.concat(parts);
}

/** An MP4 metadata box (`udta` with a title, as a phone's recorder names a recording after the place). */
export const mp4TitleBox = (title: string): Buffer => box("udta", box("\xa9nam", Buffer.from(title)));

/** A WebM Tags element (top level, after the Clusters here) with a title. */
export const webmTags = (title: string): Buffer =>
  element([0x12, 0x54, 0xc3, 0x67], element([0x73, 0x73], element([0x67, 0xc8], Buffer.concat([element([0x45, 0xa3], Buffer.from("TITLE")), element([0x44, 0x87], Buffer.from(title))]))));

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
