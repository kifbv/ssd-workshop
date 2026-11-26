// Ticket 3.16 try 2: untrusted text placed between block tags (`<spec>`, `<participant>`, `<message>`) must not close
// its block early. One pass of removal is not enough: `</parti</participant>cipant>` rebuilds `</participant>` once
// the inner tag goes. The removal repeats until nothing changes; each pass is linear (`[^<>]*` stops at the next `<`)
// and removes at least one tag, so the text's length bounds the passes.

/**
 * The text without any opening or closing tag of the given names, in any letter case and with attributes or spaces
 * (`</SPEC >`), removed until none is left. Everything else (other tags, a lone `<` or `>`) stays.
 */
export function withoutTags(text: string, names: readonly string[]): string {
  const tag = new RegExp(`<\\/?(?:${names.join("|")})\\b[^<>]*>`, "gi");
  let current = text;
  for (;;) {
    const next = current.replace(tag, "");
    if (next === current) return current;
    current = next;
  }
}
