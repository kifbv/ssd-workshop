// Ticket 3.21: the decoded length bound of a recording (decodedSecondsBound), which the AI task `transcribe` checks before
// Amazon Transcribe (billed per minute) reads a file: counted from the packets a decoder plays, not from timestamps a
// crafted file can shorten. Real MediaRecorder output is checked in browser.test.ts.
import { describe, expect, it } from "vitest";
import { webmOfSize } from "./fixtures.js";
import { decodedSecondsBound, opusPacketSeconds, OPUS_MAX_PACKET_SECONDS, recordingSeconds } from "./formats.js";

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);

/** TOC bytes: CELT fullband 20 ms (config 31) one frame (code 0); code 3 with a frame count byte. */
const TOC_20MS = 31 << 3;
const opus20ms = (length = 40): Buffer => Buffer.concat([Buffer.from([TOC_20MS]), Buffer.alloc(length - 1, 0x55)]);

// ---- Ogg ----

/** One Ogg page holding these packets (each under 255 bytes, so one lacing value each), at this granule position. */
function oggPage(packets: Buffer[], flags: number, sequence: number, granule: bigint): Buffer {
  const position = Buffer.alloc(8);
  position.writeBigInt64LE(granule);
  const le32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  return Buffer.concat([Buffer.from("OggS"), Buffer.from([0, flags]), position, le32(1), le32(sequence), Buffer.alloc(4), Buffer.from([packets.length]), Buffer.from(packets.map((p) => p.length)), ...packets]);
}
const OPUS_HEAD = Buffer.concat([Buffer.from("OpusHead"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]);

/** An Ogg/Opus file with `count` audio packets (made by `packet`), 200 per page, whose last granule says `seconds`. */
function oggWith(count: number, packet: (i: number) => Buffer, seconds: number): Buffer {
  const pages = [oggPage([OPUS_HEAD], 0x02, 0, 0n), oggPage([Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)])], 0, 1, 0n)];
  let sequence = 2;
  for (let i = 0; i < count; i += 200) {
    const packets = Array.from({ length: Math.min(200, count - i) }, (_, k) => packet(i + k));
    pages.push(oggPage(packets, 0, sequence, -1n));
    sequence += 1;
  }
  (pages[pages.length - 1] as Buffer).writeBigInt64LE(BigInt(Math.round(seconds * 48_000) + 312), 6);
  return Buffer.concat(pages);
}

// ---- WebM ----

const ebmlSize = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  b.writeUIntBE(Math.floor(n / 2 ** 32), 1, 3);
  b.writeUInt32BE(n % 2 ** 32, 4);
  return b;
};
const element = (id: number[], data: Buffer): Buffer => Buffer.concat([Buffer.from(id), ebmlSize(data.length), data]);

/** A WebM/Opus with one Cluster (Timecode 0) of SimpleBlocks, one per frame, each at relative time 20 ms x index. */
function webmWith(frames: Buffer[], lacedFrames?: number): Buffer {
  // The fixture's head (header, Segment, Info, Tracks, Cluster, Timecode), with its one padding block cut off.
  const base = webmOfSize(0, ["A_OPUS"], "webm", 0);
  const head = base.subarray(0, base.lastIndexOf(Buffer.from([0xa3])));
  const blocks = frames.map((frame, i) => element([0xa3], Buffer.concat([Buffer.from([0x81]), u16(i * 20), Buffer.from([0x80]), frame])));
  if (lacedFrames !== undefined) blocks.push(element([0xa3], Buffer.concat([Buffer.from([0x81]), u16(0), Buffer.from([0x80 | 0x02]), Buffer.from([lacedFrames - 1]), Buffer.alloc(10)])));
  return Buffer.concat([head, ...blocks]);
}

// ---- MP4 ----

const box = (type: string, ...children: Buffer[]): Buffer => {
  const body = Buffer.concat(children);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
};
const timedBox = (type: "mvhd" | "mdhd", scale: number, duration: number, size: number): Buffer => box(type, Buffer.alloc(12), u32(scale), u32(duration), Buffer.alloc(size - 28));
const tkhd = (track: number): Buffer => box("tkhd", Buffer.alloc(12), u32(track), Buffer.alloc(64));

/** An `esds` whose AudioSpecificConfig is AAC-LC (object type 2) at this sampling frequency index. */
function esds(rateIndex: number): Buffer {
  const asc = Buffer.from([(2 << 3) | (rateIndex >> 1), ((rateIndex & 1) << 7) | (1 << 3)]);
  const specific = Buffer.concat([Buffer.from([0x05, asc.length]), asc]);
  const config = Buffer.concat([Buffer.from([0x04, 13 + specific.length, 0x40, 0x15]), Buffer.alloc(11), specific]);
  const es = Buffer.concat([Buffer.from([0x03, 3 + config.length]), u16(1), Buffer.from([0]), config]);
  return box("esds", Buffer.alloc(4), es);
}
/** An `mp4a` sample entry whose own sample rate field says `entryRate` (16.16), holding this esds. */
const mp4a = (entryRate: number, esdsBox: Buffer): Buffer => box("mp4a", Buffer.alloc(16), u16(1), u16(16), Buffer.alloc(4), u16(entryRate), u16(0), esdsBox);

/** A plain MP4 of one AAC track: `count` samples in stsz, stts saying `sttsCount` samples of 1,024 at 48 kHz. */
function plainAac(count: number, entry: Buffer, sttsCount = count): Buffer {
  const stsd = box("stsd", Buffer.alloc(4), u32(1), entry);
  const stts = box("stts", Buffer.alloc(4), u32(1), u32(sttsCount), u32(1024));
  const stsz = box("stsz", Buffer.alloc(4), u32(10), u32(count));
  const trak = box(
    "trak",
    tkhd(1),
    box("mdia", timedBox("mdhd", 48_000, 0, 32), box("hdlr", Buffer.alloc(8), Buffer.from("soun"), Buffer.alloc(13)), box("minf", box("stbl", stsd, stts, stsz))),
  );
  const head = Buffer.concat([box("ftyp", Buffer.from("M4A "), u32(0)), box("moov", timedBox("mvhd", 1000, 0, 108), trak)]);
  return Buffer.concat([head, box("mdat", Buffer.alloc(count * 10))]);
}

/** A fragmented MP4/Opus: one fragment whose trun lists sizes and a data offset, its samples in the mdat right after. */
function fragmentedOpus(samples: Buffer[], perSampleDuration = 960): Buffer {
  const stsd = box("stsd", Buffer.alloc(4), u32(1), box("Opus", Buffer.alloc(28)));
  const trak = box(
    "trak",
    tkhd(1),
    box("mdia", timedBox("mdhd", 48_000, 0, 32), box("hdlr", Buffer.alloc(8), Buffer.from("soun"), Buffer.alloc(13)), box("minf", box("stbl", stsd, box("stts", Buffer.alloc(8))))),
  );
  const moov = box("moov", timedBox("mvhd", 1000, 0, 108), trak, box("mvex", box("trex", Buffer.alloc(4), u32(1), u32(1), u32(0), u32(0), u32(0))));
  const head = Buffer.concat([box("ftyp", Buffer.from("iso6"), u32(0)), moov]);
  const build = (dataOffset: number): Buffer => {
    const tfhd = box("tfhd", u32(0x020000), u32(1));
    const tfdt = box("tfdt", Buffer.from([1, 0, 0, 0]), Buffer.alloc(8));
    const entries = samples.map((s) => Buffer.concat([u32(perSampleDuration), u32(s.length)]));
    const trun = box("trun", u32(0x000001 | 0x000100 | 0x000200), u32(samples.length), u32(dataOffset), ...entries);
    return box("moof", box("mfhd", Buffer.alloc(4), u32(1)), box("traf", tfhd, tfdt, trun));
  };
  const moofSize = build(0).length;
  // The data offset counts from the moof's start: past the moof and the mdat's 8-byte header.
  return Buffer.concat([head, build(moofSize + 8), box("mdat", ...samples)]);
}

describe("opusPacketSeconds (RFC 6716 TOC byte)", () => {
  it("reads the frame size and count, and counts an empty, malformed or over-long packet at 120 ms", () => {
    expect(opusPacketSeconds(40, TOC_20MS, undefined)).toBeCloseTo(0.02);
    expect(opusPacketSeconds(40, (31 << 3) | 1, undefined)).toBeCloseTo(0.04); // code 1: two frames
    expect(opusPacketSeconds(40, (16 << 3) | 0, undefined)).toBeCloseTo(0.0025); // CELT 2.5 ms
    expect(opusPacketSeconds(40, (3 << 3) | 0, undefined)).toBeCloseTo(0.06); // SILK 60 ms
    expect(opusPacketSeconds(40, (31 << 3) | 3, 3)).toBeCloseTo(0.06); // code 3: three 20 ms frames
    expect(opusPacketSeconds(0, undefined, undefined)).toBe(OPUS_MAX_PACKET_SECONDS);
    expect(opusPacketSeconds(1, (31 << 3) | 3, undefined)).toBe(OPUS_MAX_PACKET_SECONDS);
    expect(opusPacketSeconds(40, (31 << 3) | 3, 0)).toBe(OPUS_MAX_PACKET_SECONDS);
    expect(opusPacketSeconds(40, (3 << 3) | 3, 48)).toBe(OPUS_MAX_PACKET_SECONDS); // 48 x 60 ms: malformed
  });
});

describe("decodedSecondsBound (ticket 3.21)", () => {
  it("WHEN an Ogg/Opus file's packets add up to its granule THEN the bound is its length", () => {
    const ogg = oggWith(500, () => opus20ms(), 10);
    expect(recordingSeconds(ogg, "ogg")).toBeCloseTo(10);
    expect(decodedSecondsBound(ogg, "ogg")).toBeCloseTo(10);
  });

  it("WHEN an Ogg/Opus file declares 10 s but holds 120 ms packets or empty ones THEN the bound counts every packet", () => {
    // 500 code-3 packets of six 20 ms frames: 60 s of audio behind a 10 s granule.
    expect(decodedSecondsBound(oggWith(500, () => Buffer.from([(31 << 3) | 3, 6, 0, 0]), 10), "ogg")).toBeCloseTo(60);
    // 5,000 empty packets (a decoder may conceal each as lost audio): 600 s.
    expect(decodedSecondsBound(oggWith(5000, () => Buffer.alloc(0), 10), "ogg")).toBeCloseTo(600);
  });

  it("WHEN a packet spans pages THEN it counts once, with the TOC byte from its first segment", () => {
    const long = opus20ms(600); // 600 bytes: lacing 255, 255, 90 over two pages
    const head = [oggPage([OPUS_HEAD], 0x02, 0, 0n), oggPage([Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)])], 0, 1, 0n)];
    const position = Buffer.alloc(8);
    const le32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    position.writeBigInt64LE(-1n);
    const first = Buffer.concat([Buffer.from("OggS"), Buffer.from([0, 0]), position, le32(1), le32(2), Buffer.alloc(4), Buffer.from([2, 255, 255]), long.subarray(0, 510)]);
    const end = Buffer.alloc(8);
    end.writeBigInt64LE(BigInt(960 + 312));
    const second = Buffer.concat([Buffer.from("OggS"), Buffer.from([0, 1]), end, le32(1), le32(3), Buffer.alloc(4), Buffer.from([1, 90]), long.subarray(510)]);
    expect(decodedSecondsBound(Buffer.concat([...head, first, second]), "ogg")).toBeCloseTo(0.02);
  });

  it("WHEN a WebM's blocks hold 20 ms packets THEN the bound is their sum; laced or empty blocks count 120 ms a frame", () => {
    const frames = Array.from({ length: 100 }, () => opus20ms());
    expect(decodedSecondsBound(webmWith(frames), "webm")).toBeCloseTo(2);
    // The last block's timecode (1.98 s) is under the sum of the packets: the bound is the sum.
    expect(recordingSeconds(webmWith(frames), "webm")).toBeCloseTo(1.98);
    expect(decodedSecondsBound(webmWith(frames, 50), "webm")).toBeCloseTo(2 + 50 * 0.12);
    expect(decodedSecondsBound(webmWith([Buffer.alloc(0), Buffer.alloc(0)]), "webm")).toBeCloseTo(0.24);
  });

  it("WHEN an AAC MP4 lists its samples THEN the bound is samples x 1,024 at the lowest rate it names, stsz or stts", () => {
    // 48 kHz (index 3) in both places: 4,688 frames = 100 s.
    expect(decodedSecondsBound(plainAac(4688, mp4a(48_000, esds(3))), "mp4")).toBeCloseTo(100, 0);
    // The AudioSpecificConfig says 8 kHz (index 11) while the sample entry says 48 kHz: the decoder's 8 kHz counts.
    expect(decodedSecondsBound(plainAac(4688, mp4a(48_000, esds(11))), "mp4")).toBeCloseTo(600, 0);
    // stts claims fewer samples than stsz lists: the stsz count is what a decoder reads.
    expect(decodedSecondsBound(plainAac(4688, mp4a(48_000, esds(3)), 10), "mp4")).toBeCloseTo(100, 0);
    // No esds: the rate cannot be read, the file is refused.
    expect(decodedSecondsBound(plainAac(10, box("mp4a", Buffer.alloc(28))), "mp4")).toBeUndefined();
  });

  it("WHEN a fragmented MP4/Opus lists sample sizes THEN each sample's own TOC byte counts", () => {
    const samples = Array.from({ length: 50 }, () => opus20ms(30));
    expect(decodedSecondsBound(fragmentedOpus(samples), "mp4")).toBeCloseTo(1);
    // The same samples declared as 20 ms but each holding six 20 ms frames: 6 s, whatever trun's durations say.
    const packed = Array.from({ length: 50 }, () => Buffer.from([(31 << 3) | 3, 6, 1, 2]));
    expect(recordingSeconds(fragmentedOpus(packed), "mp4")).toBeCloseTo(1);
    expect(decodedSecondsBound(fragmentedOpus(packed), "mp4")).toBeCloseTo(6);
  });

  it("WHEN 4 MB of empty Ogg packets claim 1 s THEN the bound is hours, found within a second", () => {
    const pages: Buffer[] = [oggPage([OPUS_HEAD], 0x02, 0, 0n), oggPage([Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)])], 0, 1, 0n)];
    let size = 0;
    let sequence = 2;
    while (size < 4 * 1024 * 1024 - 300) {
      const page = oggPage(Array.from({ length: 255 }, () => Buffer.alloc(0)), 0, sequence, -1n);
      pages.push(page);
      size += page.length;
      sequence += 1;
    }
    (pages[pages.length - 1] as Buffer).writeBigInt64LE(48_000n + 312n, 6);
    const ogg = Buffer.concat(pages);
    expect(recordingSeconds(ogg, "ogg")).toBeCloseTo(1);
    const started = performance.now();
    const bound = decodedSecondsBound(ogg, "ogg") as number;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(bound).toBeGreaterThan(5 * 3600);
  });

  it("WHEN a file cannot be walked THEN the bound is undefined", () => {
    const ogg = oggWith(10, () => opus20ms(), 0.2);
    expect(decodedSecondsBound(ogg.subarray(0, ogg.length - 5), "ogg")).toBeUndefined();
    expect(decodedSecondsBound(Buffer.from("not a recording"), "webm")).toBeUndefined();
  });
});
