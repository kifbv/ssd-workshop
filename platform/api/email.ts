/**
 * The one rule for what counts as an email address, shared by the allow-list import
 * (ticket 1.3) and the sign-in code request (ticket 1.4), so every stored address is
 * also accepted at sign-in.
 *
 * ASCII only: local part of letters, digits and `._%+-`; domain labels of letters, digits and `-`,
 * separated by dots, ending in an alphabetic TLD of 2+ letters. Kept no wider than what
 * smoke's `redactEmails` masks, so any address that can be stored can also be redacted (tested
 * in platform/src/allowlist/logic.test.ts).
 */
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}
