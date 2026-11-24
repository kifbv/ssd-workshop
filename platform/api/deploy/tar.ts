/**
 * A small reader for GitHub's tarballs (ticket 2.5): gzip'd tar archives of a repository at one commit,
 * unpacked in memory (nothing is written to disk) into the deploy check's `AppFile` list.
 *
 * Handles ustar headers (with the 155-byte prefix), GNU long names (`L`), pax extended headers (`x`:
 * `path` and `size`) and skips pax global headers (`g`: GitHub's `pax_global_header` holds the commit).
 * The single top folder (`<owner>-<repo>-<sha>/`) is stripped. Hard links and symlinks become `symlink`,
 * folders `dir`, plain and contiguous files `file`, anything else `other`, so the check refuses what is
 * not a plain file or folder (decision "(2.3) For 2.5"). A path that leaves the folder (absolute or with
 * `..`) fails the whole archive at once. No dependency: the format's parts the deployer meets are small.
 */
import { gunzipSync } from "node:zlib";
import type { AppFile, FileKind } from "../build/check.js";

const MB = 1024 * 1024;
const BLOCK = 512;

/**
 * At most this many bytes are unpacked: the 5 MB an app may hold, plus room for the tar headers of every
 * file and folder, pax records and padding. Unpacking stops past it, so a small download that unpacks to
 * gigabytes (a "zip bomb") never fills the function's memory.
 */
export const MAX_UNPACKED_BYTES = 8 * MB;

/** A problem with the archive itself: the build fails with `reason` (plain English, no retry). */
export class ArchiveProblem extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ArchiveProblem";
  }
}

const INVALID = "The repository's download is not a valid tar.gz archive, so nothing was published.";
export const UNSAFE_PATH_REASON = "The repository holds a path that leaves its folder (an absolute path or ..), so nothing was published.";
const LAYOUT = "The repository's download does not hold one folder at its top, as GitHub's do, so nothing was published.";

const formatMb = (bytes: number): string => (bytes % MB === 0 ? String(bytes / MB) : (bytes / MB).toFixed(3));
const tooBigReason = (limit: number): string =>
  `The repository is over ${formatMb(limit)} MB unpacked; an app may hold at most 5 MB, so nothing was published.`;

const decoder = new TextDecoder("utf-8");

/** A NUL-terminated text field. */
function field(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** An octal number field (spaces and NULs around it allowed). Base-256 sizes (over 8 GB) are refused. */
function octalField(block: Uint8Array, offset: number, length: number): number {
  if (((block[offset] ?? 0) & 0x80) !== 0) throw new ArchiveProblem(INVALID);
  const text = field(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveProblem(INVALID);
  return parseInt(text, 8);
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum === octalField(block, 148, 8);
}

/** Pax records: `<length> <key>=<value>\n`, the length in bytes counting the whole record. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) throw new ArchiveProblem(INVALID);
    const lengthText = decoder.decode(data.subarray(at, space));
    if (!/^[1-9][0-9]{0,8}$/.test(lengthText)) throw new ArchiveProblem(INVALID);
    const end = at + Number(lengthText);
    if (end > data.length || end <= space + 1 || data[end - 1] !== 0x0a) throw new ArchiveProblem(INVALID);
    const record = decoder.decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals < 1) throw new ArchiveProblem(INVALID);
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at = end;
  }
  return records;
}

function kindOf(type: string): FileKind {
  if (type === "0" || type === "\0" || type === "" || type === "7") return "file";
  if (type === "5") return "dir";
  if (type === "1" || type === "2") return "symlink";
  return "other";
}

/** An absolute path or one with a `..` part would leave the app's folder. */
const leavesFolder = (path: string): boolean => path.startsWith("/") || path.split("/").includes("..");

/** Reads an uncompressed tar archive into the app's files (top folder stripped; the last entry for a path wins). */
export function readTar(tar: Uint8Array): AppFile[] {
  const entries: { path: string; kind: FileKind; bytes: Uint8Array }[] = [];
  let nextPath: string | undefined;
  let nextSize: number | undefined;
  let at = 0;
  for (;;) {
    if (at + BLOCK > tar.length) throw new ArchiveProblem(INVALID);
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    if (!checksumOk(block)) throw new ArchiveProblem(INVALID);
    const type = String.fromCharCode(block[156] ?? 0);
    const size = nextSize ?? octalField(block, 124, 12);
    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ArchiveProblem(INVALID);
    const data = tar.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "g") {
      const records = paxRecords(data);
      if (type === "x") {
        const path = records.get("path");
        if (path !== undefined) nextPath = path;
        const paxSize = records.get("size");
        if (paxSize !== undefined) {
          if (!/^[0-9]{1,12}$/.test(paxSize)) throw new ArchiveProblem(INVALID);
          nextSize = Number(paxSize);
        }
      }
      continue;
    }
    if (type === "L") {
      const end = data.indexOf(0);
      nextPath = decoder.decode(end === -1 ? data : data.subarray(0, end));
      continue;
    }
    if (type === "K") continue;

    const ustar = field(block, 257, 6) === "ustar";
    const prefix = ustar ? field(block, 345, 155) : "";
    const name = field(block, 0, 100);
    const path = nextPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    nextPath = undefined;
    nextSize = undefined;
    if (leavesFolder(path)) throw new ArchiveProblem(UNSAFE_PATH_REASON);
    const kind = kindOf(type);
    entries.push({ path: path.replace(/\/+$/, ""), kind, bytes: kind === "file" ? data.slice() : new Uint8Array() });
  }

  const tops = new Set(entries.map((entry) => entry.path.split("/")[0]));
  if (tops.size > 1) throw new ArchiveProblem(LAYOUT);
  const files = new Map<string, AppFile>();
  for (const entry of entries) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      // The top folder itself; anything else at the top is not GitHub's layout.
      if (entry.kind !== "dir") throw new ArchiveProblem(LAYOUT);
      continue;
    }
    const path = entry.path.slice(slash + 1);
    files.delete(path);
    files.set(path, { path, kind: entry.kind, bytes: entry.bytes });
  }
  return [...files.values()];
}

/** Unpacks a gzip'd tar archive, stopping past `maxUnpacked` bytes. */
export function readTarGz(gz: Uint8Array, maxUnpacked: number = MAX_UNPACKED_BYTES): AppFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: maxUnpacked });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (error instanceof RangeError || code === "ERR_BUFFER_TOO_LARGE") throw new ArchiveProblem(tooBigReason(maxUnpacked));
    throw new ArchiveProblem(INVALID);
  }
  return readTar(new Uint8Array(tar.buffer, tar.byteOffset, tar.length));
}
