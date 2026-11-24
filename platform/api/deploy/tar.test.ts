import { describe, expect, it } from "vitest";
import { ArchiveProblem, MAX_UNPACKED_BYTES, readTar, readTarGz } from "./tar.js";
import { COMMIT, TOP, githubTar, gzip, makeTar, paxRecord } from "./tar-fixtures.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const summary = (files: { path: string; kind: string; bytes: Uint8Array }[]) =>
  files.map((f) => `${f.kind} ${f.path}${f.kind === "file" ? ` ${text(f.bytes)}` : ""}`);
const problemOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof ArchiveProblem) return error.reason;
    throw error;
  }
  throw new Error("no problem raised");
};

describe("readTar (ticket 2.5)", () => {
  it("reads a GitHub tarball: skips the pax global header, strips the single top folder, keeps folders and files", () => {
    const files = readTar(githubTar({ "index.html": "<p>hi</p>", "css/style.css": "p{}" }));
    expect(summary(files)).toEqual(["dir css", "file index.html <p>hi</p>", "file css/style.css p{}"]);
  });

  it("reads pax `path` records and GNU long names for paths over 100 bytes, and the ustar prefix", () => {
    const long = `${"a".repeat(60)}/${"b".repeat(60)}/page.html`;
    for (const longName of ["pax", "gnu", "prefix"] as const) {
      const tar = makeTar([
        { path: `${TOP}/`, type: "5" },
        { path: `${TOP}/${long}`, data: "x", longName },
        { path: `${TOP}/index.html`, data: "i" },
      ]);
      expect(summary(readTar(tar)), longName).toEqual([`file ${long} x`, "file index.html i"]);
    }
  });

  it("applies a pax `size` record to the next entry", () => {
    const pax = paxRecord("size", "3");
    const tar = makeTar([
      { path: `${TOP}/`, type: "5" },
      { path: "PaxHeaders/x", type: "x", data: pax },
      { path: `${TOP}/a.txt`, data: "abc" },
    ]);
    expect(summary(readTar(tar))).toEqual(["file a.txt abc"]);
  });

  it("maps symlinks and hard links to symlink, other entries (devices, pipes) to other, and reads contiguous files as files", () => {
    const tar = githubTar({ "index.html": "i" }, [
      { path: `${TOP}/soft.html`, type: "2", linkName: "index.html" },
      { path: `${TOP}/hard.html`, type: "1", linkName: `${TOP}/index.html` },
      { path: `${TOP}/fifo`, type: "6" },
      { path: `${TOP}/dev`, type: "3" },
      { path: `${TOP}/contiguous.txt`, type: "7", data: "c" },
    ]);
    expect(summary(readTar(tar))).toEqual([
      "file index.html i",
      "symlink soft.html",
      "symlink hard.html",
      "other fifo",
      "other dev",
      "file contiguous.txt c",
    ]);
  });

  it("refuses a path that leaves the folder (`..` or absolute) before reading anything else", () => {
    const reason = "The repository holds a path that leaves its folder (an absolute path or ..), so nothing was published.";
    expect(problemOf(() => readTar(githubTar({ "index.html": "i" }, [{ path: `${TOP}/../evil.html`, data: "x" }])))).toBe(reason);
    expect(problemOf(() => readTar(githubTar({ "index.html": "i" }, [{ path: "/etc/passwd", data: "x" }])))).toBe(reason);
    // Through a pax path and a GNU long name too.
    const long = `${TOP}/${"a".repeat(100)}/../../x.html`;
    expect(problemOf(() => readTar(makeTar([{ path: long, data: "x", longName: "pax" }])))).toBe(reason);
    expect(problemOf(() => readTar(makeTar([{ path: long, data: "x", longName: "gnu" }])))).toBe(reason);
  });

  it("refuses entries outside one top folder", () => {
    const tar = makeTar([
      { path: `${TOP}/`, type: "5" },
      { path: `${TOP}/index.html`, data: "i" },
      { path: "other/index.html", data: "o" },
    ]);
    expect(problemOf(() => readTar(tar))).toMatch(/one folder at its top/);
    expect(problemOf(() => readTar(makeTar([{ path: "index.html", data: "i" }])))).toMatch(/one folder at its top/);
  });

  it("keeps the last entry when a path appears twice, as tar does when it unpacks", () => {
    const tar = githubTar({ "index.html": "old" }, [{ path: `${TOP}/index.html`, data: "new" }]);
    expect(summary(readTar(tar))).toEqual(["file index.html new"]);
  });

  it("reads an empty archive as no files", () => {
    expect(readTar(makeTar([]))).toEqual([]);
  });

  it("refuses a damaged archive: bad checksum, cut short, a base-256 size, a broken pax record", () => {
    const invalid = /not a valid tar\.gz archive/;
    expect(problemOf(() => readTar(makeTar([{ path: `${TOP}/a.txt`, data: "x", badChecksum: true }])))).toMatch(invalid);
    const tar = githubTar({ "index.html": "x".repeat(2000) });
    expect(problemOf(() => readTar(tar.slice(0, tar.length - 1024 - 1024)))).toMatch(invalid);
    expect(problemOf(() => readTar(makeTar([{ path: `${TOP}/a.txt`, data: "x", base256Size: true }])))).toMatch(invalid);
    expect(problemOf(() => readTar(makeTar([{ path: "p", type: "x", data: "99 path=x\n" }, { path: `${TOP}/a`, data: "" }])))).toMatch(invalid);
    expect(problemOf(() => readTar(new Uint8Array(100)))).toMatch(invalid);
  });
});

describe("readTarGz (ticket 2.5)", () => {
  it("unpacks a gzip'd GitHub tarball", () => {
    expect(summary(readTarGz(gzip(githubTar({ "index.html": COMMIT }))))).toEqual([`file index.html ${COMMIT}`]);
  });

  it("stops unpacking past the limit and fails with a plain reason", () => {
    expect(MAX_UNPACKED_BYTES).toBe(8 * 1024 * 1024);
    // 9 MB of zeros compresses to a few KB: the limit is on what is unpacked, not what is downloaded.
    const big = gzip(githubTar({ "index.html": "i", "big.txt": new Uint8Array(9 * 1024 * 1024) }));
    expect(big.length).toBeLessThan(100_000);
    expect(problemOf(() => readTarGz(big))).toBe("The repository is over 8 MB unpacked; an app may hold at most 5 MB, so nothing was published.");
    expect(problemOf(() => readTarGz(gzip(githubTar({ "index.html": "i" })), 1024))).toMatch(/^The repository is over/);
  });

  it("refuses data that is not gzip", () => {
    expect(problemOf(() => readTarGz(new TextEncoder().encode("<html>not found</html>")))).toMatch(/not a valid tar\.gz archive/);
  });
});
