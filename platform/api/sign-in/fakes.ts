// In-memory stand-ins for the table and SES, shared by the sign-in tests (not bundled: no handler imports it).
import type { CodeEmail } from "./code-email.js";
import type { CodeMailer, CodeRequests, SignInStore, StoredCodes } from "./code-request.js";

/**
 * Waits (in real time, through setImmediate, which the tests' fake timers leave alone) until
 * `condition` holds: lets real async work such as scrypt finish before the fake clock moves.
 */
export async function settle(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > end) throw new Error("settle: condition not met");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export class FakeStore implements SignInStore {
  readonly codes = new Map<string, StoredCodes & { expiresAt: number }>();
  readonly requests = new Map<string, CodeRequests & { expiresAt: number }>();
  /** Every email any write named (proves nothing is written for strangers). */
  readonly written: string[] = [];
  failOn: "isAllowListed" | "getCodeRequests" | "putCodeRequests" | "getCode" | "putCode" | undefined;
  failure: Error = new Error("boom");

  constructor(private readonly allowed: readonly string[]) {}

  private maybeFail(method: FakeStore["failOn"]): void {
    if (this.failOn === method) throw this.failure;
  }

  async isAllowListed(email: string): Promise<boolean> {
    this.maybeFail("isAllowListed");
    return this.allowed.includes(email);
  }

  async getCodeRequests(email: string): Promise<CodeRequests | undefined> {
    this.maybeFail("getCodeRequests");
    const item = this.requests.get(email);
    return item && { sentAt: [...item.sentAt], version: item.version };
  }

  async putCodeRequests(
    email: string,
    sentAt: number[],
    expiresAt: number,
    expectedVersion: number | undefined,
  ): Promise<boolean> {
    this.maybeFail("putCodeRequests");
    this.written.push(email);
    if (this.requests.get(email)?.version !== expectedVersion) return false;
    this.requests.set(email, { sentAt: [...sentAt], expiresAt, version: (expectedVersion ?? 0) + 1 });
    return true;
  }

  async getCode(email: string): Promise<StoredCodes | undefined> {
    this.maybeFail("getCode");
    const item = this.codes.get(email);
    return item && { codes: item.codes.map((c) => ({ ...c })), attempts: item.attempts, version: item.version };
  }

  async putCode(
    email: string,
    codes: StoredCodes,
    expiresAt: number,
    expectedVersion: number | undefined,
  ): Promise<boolean> {
    this.maybeFail("putCode");
    this.written.push(email);
    if (this.codes.get(email)?.version !== expectedVersion) return false;
    this.codes.set(email, { codes: codes.codes.map((c) => ({ ...c })), attempts: codes.attempts, version: codes.version, expiresAt });
    return true;
  }
}

export class FakeMailer implements CodeMailer {
  readonly sent: { to: string; email: CodeEmail }[] = [];
  failure: Error | undefined;

  async send(to: string, email: CodeEmail): Promise<void> {
    if (this.failure) throw this.failure;
    this.sent.push({ to, email });
  }
}
