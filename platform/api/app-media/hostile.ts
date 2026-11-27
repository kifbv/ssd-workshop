// Hostile inputs for the media checks' memory and time bounds (ticket 3.18 try 3), shared by formats.test.ts and the
// child process it starts (hostile-probe.ts). Not bundled: no handler imports it.
import { jpegOfSize, mp4OfSize, webmOfSize } from "./fixtures.js";

const MB4 = 4 * 1024 * 1024;

/** `unit` repeated to fill `bytes`. */
function repeated(unit: number[], bytes: number): Buffer {
  const out = Buffer.alloc(Math.floor(bytes / unit.length) * unit.length);
  for (let i = 0; i < out.length; i += 1) out[i] = unit[i % unit.length] as number;
  return out;
}

/**
 * A JPEG that is all but 4 MB of tiny parts right after SOI: restart markers (`FF D0`, 2 million) or empty DQT
 * segments (`FF DB 00 02`, 1 million), both kept by the allow-list, followed by a small real picture's segments.
 */
export function hostileJpeg(unit: "restarts" | "segments", bytes = MB4): Buffer {
  const picture = jpegOfSize(2000);
  return Buffer.concat([picture.subarray(0, 2), repeated(unit === "restarts" ? [0xff, 0xd0] : [0xff, 0xdb, 0x00, 0x02], bytes - picture.length), picture.subarray(2)]);
}

/**
 * A WebM/Opus whose EBML header, Info and Tracks each hold a third of 4 MB of two-byte Void elements (`EC 80`, ~700,000
 * each) beside their real children: the format check and the length walk read each of these lists.
 */
export function hostileWebm(bytes = MB4): Buffer {
  const small = webmOfSize(400, ["A_OPUS"], "webm", 7);
  const voids = repeated([0xec, 0x80], Math.floor(bytes / 3));
  // Each of the three parents has an 8-byte size (0x01 marker) right after its id: grow it by the voids' length.
  const grow = (buf: Buffer, id: number[]): Buffer => {
    const at = buf.indexOf(Buffer.from(id));
    const sizeAt = at + id.length;
    const size = Number(buf.readBigUInt64BE(sizeAt) & 0x00ffffffffffffffn);
    const out = Buffer.concat([buf.subarray(0, sizeAt + 8 + size), voids, buf.subarray(sizeAt + 8 + size)]);
    out.writeBigUInt64BE(0x0100000000000000n + BigInt(size + voids.length), sizeAt);
    return out;
  };
  return grow(grow(grow(small, [0x1a, 0x45, 0xdf, 0xa3]), [0x15, 0x49, 0xa9, 0x66]), [0x16, 0x54, 0xae, 0x6b]);
}

/** An MP4/AAC followed by 4 MB of empty 8-byte `free` boxes at the top level (half a million). */
export function hostileMp4(bytes = MB4): Buffer {
  const free = Buffer.alloc(bytes - (bytes % 8));
  for (let i = 0; i < free.length; i += 8) {
    free.writeUInt32BE(8, i);
    free.write("free", i + 4, "latin1");
  }
  return Buffer.concat([mp4OfSize(600), free]);
}
