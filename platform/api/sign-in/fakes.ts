// In-memory stand-ins for the table and SES, shared by the sign-in tests (not bundled: no handler imports it).
import type { CodeItem } from "../types.js";
import type { CodeEmail } from "./code-email.js";
import type { CodeMailer, CodeRequests, SignInStore } from "./code-request.js";

export type StoredCode = Omit<CodeItem, "pk" | "sk" | "type">;

export class FakeStore implements SignInStore {
  readonly codes = new Map<string, StoredCode>();
  readonly requests = new Map<string, CodeRequests & { expiresAt: number }>();
  /** Every email any write named (proves nothing is written for strangers). */
  readonly written: string[] = [];
  failOn: "isAllowListed" | "getCodeRequests" | "putCodeRequests" | "putCode" | undefined;
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

  async putCode(email: string, code: StoredCode): Promise<void> {
    this.maybeFail("putCode");
    this.written.push(email);
    this.codes.set(email, { ...code });
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
