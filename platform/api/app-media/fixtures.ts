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

/** A WebM as MediaRecorder writes it (Segment and Cluster of unknown size), with one track per codec, padded to `totalBytes`. */
export function webmOfSize(totalBytes: number, codecs: string[] = ["A_OPUS"], docType = "webm"): Buffer {
  const header = element([0x1a, 0x45, 0xdf, 0xa3], Buffer.concat([element([0x42, 0x86], Buffer.from([1])), element([0x42, 0x82], Buffer.from(docType))]));
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    Buffer.concat(
      codecs.map((codec, i) =>
        element([0xae], Buffer.concat([element([0xd7], Buffer.from([i + 1])), element([0x83], Buffer.from([codec.startsWith("V_") ? 1 : 2])), element([0x86], Buffer.from(codec))])),
      ),
    ),
  );
  const info = element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])));
  const start = Buffer.concat([header, Buffer.from([0x18, 0x53, 0x80, 0x67]), UNKNOWN_SIZE, info, tracks, Buffer.from([0x1f, 0x43, 0xb6, 0x75]), UNKNOWN_SIZE]);
  const blockHead = Buffer.concat([Buffer.from([0xa3]), ebmlSize(0)]);
  const room = Math.max(0, totalBytes - start.length - blockHead.length);
  return Buffer.concat([start, Buffer.from([0xa3]), ebmlSize(room), filler(room)]);
}

// ---- Ogg ----

/** One Ogg page holding one packet (at most 255 x 255 bytes). */
function oggPage(packet: Buffer, flags: number, sequence: number, serial = 1): Buffer {
  const lacing: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  return Buffer.concat([Buffer.from("OggS"), Buffer.from([0, flags]), Buffer.alloc(8), u32(serial), u32(sequence), Buffer.alloc(4), Buffer.from([lacing.length]), Buffer.from(lacing), packet]);
}

/** An Ogg file whose first (BOS) page starts the given stream ("OpusHead" or a Theora header). */
export function oggOfSize(totalBytes: number, head: Buffer = Buffer.concat([Buffer.from("OpusHead"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])])): Buffer {
  const pages = [oggPage(head, 0x02, 0), oggPage(Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)]), 0, 1)];
  let size = pages.reduce((n, p) => n + p.length, 0);
  let sequence = 2;
  while (size < totalBytes) {
    const page = oggPage(filler(Math.min(60_000, Math.max(1, totalBytes - size - 300))), 0, sequence);
    pages.push(page);
    size += page.length;
    sequence += 1;
  }
  return Buffer.concat(pages);
}

// ---- MP4 ----

const box = (type: string, ...children: Buffer[]): Buffer => {
  const body = Buffer.concat(children);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
};

/** An MP4 with one track per [handler, sample entry] (`soun`/`mp4a` is AAC audio, `vide`/`avc1` is video), padded with `mdat`. */
export function mp4OfSize(totalBytes: number, tracks: [string, string][] = [["soun", "mp4a"]]): Buffer {
  const trak = ([handler, entry]: [string, string]) =>
    box(
      "trak",
      box(
        "mdia",
        box("hdlr", Buffer.alloc(8), Buffer.from(handler, "latin1"), Buffer.alloc(13)),
        box("minf", box("stbl", box("stsd", Buffer.alloc(4), u32(1), box(entry, Buffer.alloc(28))))),
      ),
    );
  const head = Buffer.concat([box("ftyp", Buffer.from("M4A ", "latin1"), u32(0), Buffer.from("isomM4A ", "latin1")), box("moov", box("mvhd", Buffer.alloc(100)), ...tracks.map(trak))]);
  return Buffer.concat([head, box("mdat", filler(Math.max(0, totalBytes - head.length - 8)))]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
