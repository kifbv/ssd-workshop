// A throwaway self-signed certificate for 127.0.0.1, made in memory for tests that need a local HTTPS server
// (ticket 2.14, template.test.ts). Node can sign but not build X.509, so this writes the few DER structures by
// hand: no openssl, no dependency, and no key ever written to disk or to the repository.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** One DER element: tag, length (short or long form), content. */
const der = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : lengthBytes(body.length);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};

const lengthBytes = (length: number): Buffer => {
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

const sequence = (...content: Buffer[]): Buffer => der(0x30, ...content);

const oid = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const groups: number[] = [];
    for (let value = part; ; value = Math.floor(value / 128)) {
      groups.unshift((value % 128) | (groups.length > 0 ? 0x80 : 0));
      if (value < 128) break;
    }
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};

/** UTCTime, `YYMMDDHHMMSSZ` (valid for years 1950 to 2049). */
const utcTime = (date: Date): Buffer => der(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const COMMON_NAME = "2.5.4.3";
const SUBJECT_ALT_NAME = "2.5.29.17";

/** A PEM key and certificate (EC P-256, ECDSA SHA-256) for `127.0.0.1`, valid from a day ago for a day. */
export function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = sequence(der(0x31, sequence(oid(COMMON_NAME), der(0x0c, Buffer.from("127.0.0.1")))));
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f; // a positive INTEGER
  const altNames = sequence(der(0x87, Buffer.from([127, 0, 0, 1])));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, serial),
    sequence(oid(ECDSA_WITH_SHA256)),
    name,
    sequence(utcTime(new Date(now - day)), utcTime(new Date(now + day))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(sequence(oid(SUBJECT_ALT_NAME), der(0x04, altNames)))),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, sequence(oid(ECDSA_WITH_SHA256)), der(0x03, Buffer.from([0]), signature));
  const base64 = certificate.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}
