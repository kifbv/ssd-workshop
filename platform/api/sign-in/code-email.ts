// The sign-in code email (ticket 1.4): a pure function, so its content is unit tested.
// Built to stay out of Junk: a display name on the workshop's own address, a plain subject,
// text and HTML parts with the same words, a line saying why the person gets it, no images,
// no links and no Reply-To (nobody needs to reply, and the sender receives no mail).
import { FROM_HEADER } from "../settings.js";

export const VALIDITY_LINE = "The code is valid for 10 minutes.";
export const REASON_LINE =
  "You get this email because someone asked to sign in to the SSD Workshop with this address. If it wasn't you, you can ignore this email.";
export const CLOSING_LINE = "Questions? Ask your facilitator.";

export interface CodeEmail {
  /** Display name and address: "SSD Workshop" <ssd-workshop@rankly.games>. */
  from: string;
  subject: string;
  text: string;
  html: string;
}

export function buildCodeEmail(code: string): CodeEmail {
  // The code is the only variable part; six digits need no HTML escaping.
  if (!/^\d{6}$/.test(code)) throw new Error("the code must be six digits");
  const intro = "Your SSD Workshop sign-in code is:";
  const enter = `Enter it on the sign-in page. ${VALIDITY_LINE}`;
  const text = [intro, "", code, "", enter, "", REASON_LINE, "", CLOSING_LINE, ""].join("\n");
  const p = 'style="margin:0 0 16px 0;"';
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Your SSD Workshop sign-in code</title></head>',
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;background:#ffffff;">',
    `<p ${p}>${intro}</p>`,
    `<p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:bold;letter-spacing:6px;">${code}</p>`,
    `<p ${p}>${enter}</p>`,
    `<p style="margin:0 0 16px 0;font-size:14px;color:#555555;">${REASON_LINE}</p>`,
    `<p style="margin:0;font-size:14px;color:#555555;">${CLOSING_LINE}</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
  return { from: FROM_HEADER, subject: `Your SSD Workshop sign-in code: ${code}`, text, html };
}
