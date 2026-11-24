// Builds tar and tar.gz archives for the deployer's tests (ticket 2.5), in the shapes GitHub's tarballs
// take: a pax global header (`pax_global_header`, the commit), one top folder `<owner>-<repo>-<sha>/`,
// pax `path` records and GNU long names for long paths. Test-only: no handler imports it.
import { gzipSync } from "node:zlib";

export interface TarEntry {
  /** The path written in the header (or in a pax / GNU long-name record, see `longName`). */
  path: string;
  /** Tar type flag: "0" file (default), "5" folder, "2" symlink, "1" hard link, "x" pax, "g" pax global, "L" GNU long name, ... */
  type?: string;
  data?: Uint8Array | string;
  linkName?: string;
  /** How a path over 100 bytes is written: a pax `path` record (default), a GNU `L` entry, or the ustar prefix. */
  longName?: "pax" | "gnu" | "prefix";
  /** Writes a wrong checksum. */
  badChecksum?: boolean;
  /** Writes the size in GNU base-256 form (high bit set). */
  base256Size?: boolean;
}

const encoder = new TextEncoder();
const bytesOf = (data: Uint8Array | string | undefined): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : (data ?? new Uint8Array());

function writeField(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`field too long: ${value}`);
  block.set(bytes, offset);
}

const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, "0");

function header(path: string, type: string, size: number, options: { linkName?: string; prefix?: string; badChecksum?: boolean; base256Size?: boolean } = {}): Uint8Array {
  const block = new Uint8Array(512);
  writeField(block, 0, 100, path);
  writeField(block, 100, 8, octal(0o644, 8));
  writeField(block, 108, 8, octal(0, 8));
  writeField(block, 116, 8, octal(0, 8));
  if (options.base256Size) {
    block[124] = 0x80;
    let rest = size;
    for (let i = 135; i > 124; i -= 1) {
      block[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
  } else {
    writeField(block, 124, 12, octal(size, 12));
  }
  writeField(block, 136, 12, octal(0, 12));
  block.fill(0x20, 148, 156);
  writeField(block, 156, 1, type);
  if (options.linkName) writeField(block, 157, 100, options.linkName);
  writeField(block, 257, 6, "ustar");
  writeField(block, 263, 2, "00");
  if (options.prefix) writeField(block, 345, 155, options.prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (options.badChecksum) sum += 1;
  writeField(block, 148, 8, `${octal(sum, 7)}\0`);
  return block;
}

const padded = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
};

/** One pax record: `<length> <key>=<value>\n`, the length counting itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).length + 1;
  while (String(length).length + encoder.encode(body).length !== length) length += 1;
  return `${length}${body}`;
}

/** A tar archive of the entries, ended by two zero blocks. */
export function makeTar(entries: readonly TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "0";
    const data = bytesOf(entry.data);
    let path = entry.path;
    let prefix: string | undefined;
    if (encoder.encode(path).length > 100) {
      const style = entry.longName ?? "pax";
      if (style === "pax") {
        const record = encoder.encode(paxRecord("path", path));
        parts.push(header("PaxHeaders/long", "x", record.length), padded(record));
        path = path.slice(0, 99);
      } else if (style === "gnu") {
        const name = encoder.encode(`${path}\0`);
        parts.push(header("././@LongLink", "L", name.length), padded(name));
        path = path.slice(0, 99);
      } else {
        const cut = path.lastIndexOf("/", 155);
        prefix = path.slice(0, cut);
        path = path.slice(cut + 1);
      }
    }
    const options = {
      ...(entry.linkName === undefined ? {} : { linkName: entry.linkName }),
      ...(prefix === undefined ? {} : { prefix }),
      ...(entry.badChecksum ? { badChecksum: true } : {}),
      ...(entry.base256Size ? { base256Size: true } : {}),
    };
    parts.push(header(path, type, data.length, options), padded(data));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The top folder of a GitHub tarball. */
export const TOP = "ssd-workshop-apps-ssd-ada-0123456";
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A GitHub-style tarball of the files (path to content): pax global header, top folder, then the files. */
export function githubTar(files: Record<string, string | Uint8Array>, extra: readonly TarEntry[] = []): Uint8Array {
  const folders = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  return makeTar([
    { path: "pax_global_header", type: "g", data: paxRecord("comment", COMMIT) },
    { path: `${TOP}/`, type: "5" },
    ...[...folders].map((folder): TarEntry => ({ path: `${TOP}/${folder}/`, type: "5" })),
    ...Object.entries(files).map(([path, data]): TarEntry => ({ path: `${TOP}/${path}`, data })),
    ...extra,
  ]);
}

export const gzip = (tar: Uint8Array): Uint8Array => new Uint8Array(gzipSync(tar));
