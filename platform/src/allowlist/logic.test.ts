import { describe, expect, it } from "vitest";
import { TABLE_NAME as INFRA_TABLE_NAME } from "../../../infra/lib/config.js";
import {
  TABLE_NAME,
  formatImportReport,
  formatListReport,
  isInside,
  isValidEmail,
  parseArgs,
  parseCsv,
  redactError,
} from "./logic.js";

describe("TABLE_NAME", () => {
  it("is the table the infra creates", () => {
    expect(TABLE_NAME).toBe(INFRA_TABLE_NAME);
  });
});

describe("parseArgs", () => {
  it("accepts import with one file and list without arguments", () => {
    expect(parseArgs(["import", "people.csv"])).toEqual({ command: "import", file: "people.csv" });
    expect(parseArgs(["list"])).toEqual({ command: "list" });
  });

  it("refuses unknown commands, a missing file and extra arguments", () => {
    expect(parseArgs([])).toEqual({ error: "no command given" });
    expect(parseArgs(["delete"])).toEqual({ error: "unknown command" });
    expect(parseArgs(["import"])).toEqual({ error: "import needs a CSV file" });
    expect(parseArgs(["import", "a.csv", "b.csv"])).toEqual({ error: "import takes exactly one file" });
    expect(parseArgs(["list", "x"])).toEqual({ error: "list takes no arguments" });
  });
});

describe("isValidEmail", () => {
  it("accepts something@domain.tld", () => {
    expect(isValidEmail("jane.doe+ws@example.com")).toBe(true);
    expect(isValidEmail("a@mail.example.org")).toBe(true);
  });

  it.each([
    "",
    "jane",
    "jane@",
    "@example.com",
    "jane@example",
    "jane doe@example.com",
    "jane@@example.com",
    "ja#ne@example.com",
    "jane@example.",
    "alice@mail_srv.com",
    "bob@exämple.de",
    "c(x)@a.com",
    "jösé@example.com",
    "a/b@example.com",
    "a*b@example.com",
    "a@example.c0m",
    "a@example.c",
    "a@-.",
  ])(
    "refuses %j",
    (email) => {
      expect(isValidEmail(email)).toBe(false);
    },
  );
});

const ACCEPTED = [
  "jane.doe+ws@example.com",
  "a@mail.example.org",
  "x@a.io",
  "_under_score@b-c.de",
  "per%cent@example.com",
  "-dash-@example.com",
  ".dot.@example.com",
  "9876@123.example.museum",
  "obrien@example.ie",
  "very.long.local.part+tag-1_2%3@sub-1.sub2.example.co.uk",
];

describe("isValidEmail and redactError agree", () => {
  it.each(ACCEPTED)("every accepted address %j is valid and fully masked by redactError", (email) => {
    expect(isValidEmail(email)).toBe(true);
    const at = email.lastIndexOf("@");
    const domain = email.slice(at + 1);
    const masked = `${email.charAt(0)}***@${domain.charAt(0)}***${domain.slice(domain.lastIndexOf("."))}`;
    for (const [before, after] of [
      ["", ""],
      ["Error on ", " failed"],
      ["to <", ">."],
      ['"', '"'],
      ["user: ", ", retry"],
      ["(", ")"],
    ] as const) {
      expect(redactError(`${before}${email}${after}`)).toBe(`${before}${masked}${after}`);
    }
  });
});

describe("parseCsv", () => {
  it("criterion 1: lower-cases and trims emails, trims group and role, keeps line numbers", () => {
    const result = parseCsv("email,group,role\n  Jane.Doe@Example.COM , Team A , Participant \nbob@example.org,b,admin\n");
    expect(result).toEqual({
      entries: [
        { line: 2, email: "jane.doe@example.com", group: "Team A", role: "participant" },
        { line: 3, email: "bob@example.org", group: "b", role: "admin" },
      ],
      rejections: [],
    });
  });

  it("strips a BOM, accepts CRLF and a header in any case, skips blank lines", () => {
    const result = parseCsv("\uFEFF Email , GROUP,Role\r\n\r\na@example.com,g,facilitator\r\n\r\n");
    expect(result).toEqual({
      entries: [{ line: 3, email: "a@example.com", group: "g", role: "facilitator" }],
      rejections: [],
    });
  });

  it("criterion 2: rejects an invalid email, an unknown role or an empty group by line number and keeps the rest", () => {
    const csv = [
      "email,group,role",
      "ok1@example.com,g1,participant",
      "not-an-email,g1,participant",
      "ok2@example.com,g1,boss",
      "ok3@example.com,  ,admin",
      "ok4@example.com,g2,admin",
    ].join("\n");
    const result = parseCsv(csv);
    expect(result).toEqual({
      entries: [
        { line: 2, email: "ok1@example.com", group: "g1", role: "participant" },
        { line: 6, email: "ok4@example.com", group: "g2", role: "admin" },
      ],
      rejections: [
        { line: 3, reason: "invalid email" },
        { line: 4, reason: "unknown role" },
        { line: 5, reason: "empty group" },
      ],
    });
  });

  it("criterion 2: lists every reason of a bad row, and the reasons never hold the address", () => {
    const result = parseCsv("email,group,role\nbad address@example.com,,root\n");
    expect(result).toEqual({ entries: [], rejections: [{ line: 2, reason: "invalid email, empty group, unknown role" }] });
  });

  it("rejects a row with the wrong number of fields", () => {
    const result = parseCsv('email,group,role\na@example.com,g\n"b@example.com","g,h",admin\n');
    expect(result).toEqual({
      entries: [],
      rejections: [
        { line: 2, reason: "expected 3 fields, found 2" },
        { line: 3, reason: "expected 3 fields, found 4" },
      ],
    });
  });

  it("criterion 1: stores each email once, rejecting a later duplicate in any letter case", () => {
    const result = parseCsv("email,group,role\na@example.com,g,participant\nA@Example.com,h,admin\n");
    expect(result).toEqual({
      entries: [{ line: 2, email: "a@example.com", group: "g", role: "participant" }],
      rejections: [{ line: 3, reason: "duplicate of line 2" }],
    });
  });

  it("criterion 2: rejects a group that holds an @, so an address in the wrong column is never stored", () => {
    const result = parseCsv("email,group,role\nalpha,jane@example.com,participant\nb@example.com,team@x,admin\nc@example.com,ok,admin\n");
    expect(result).toEqual({
      entries: [{ line: 4, email: "c@example.com", group: "ok", role: "admin" }],
      rejections: [
        { line: 2, reason: "invalid email, group looks like an email address" },
        { line: 3, reason: "group looks like an email address" },
      ],
    });
  });

  it("refuses a file without the header or an empty file", () => {
    expect(parseCsv("a@example.com,g,participant\n")).toEqual({
      error: "the first line must be the header email,group,role",
    });
    expect(parseCsv("\n \n")).toEqual({ error: "the file is empty" });
  });
});

describe("isInside", () => {
  it("criterion 4: finds paths in the directory and below it, not beside it", () => {
    expect(isInside("/repo", "/repo")).toBe(true);
    expect(isInside("/repo", "/repo/docs/people.csv")).toBe(true);
    expect(isInside("/repo", "/repo-other/people.csv")).toBe(false);
    expect(isInside("/repo", "/home/franck/people.csv")).toBe(false);
    expect(isInside("/repo", "/repo/..people.csv")).toBe(true);
  });

  it("criterion 4: ignores letter case (macOS file systems do), so a refusal is never missed", () => {
    expect(isInside("/Users/Franck/SSD-Workshop", "/users/franck/ssd-workshop/People.csv")).toBe(true);
    expect(isInside("/users/franck/ssd-workshop", "/Users/Franck/SSD-WORKSHOP/docs/people.CSV")).toBe(true);
    expect(isInside("/Users/Franck/Repo", "/USERS/FRANCK/REPO")).toBe(true);
    expect(isInside("/Users/Franck/Repo", "/Users/Franck/Repo-Other/people.csv")).toBe(false);
    expect(isInside("/Users/Franck/Repo", "/Users/Franck/Desktop/people.csv")).toBe(false);
  });
});

describe("formatImportReport", () => {
  it("criterion 1: prints counts and rejection lines only", () => {
    expect(formatImportReport({ added: 2, updated: 1, rejected: 1 }, [{ line: 7, reason: "unknown role" }])).toBe(
      "Added: 2\nUpdated: 1\nRejected: 1\nLine 7: unknown role",
    );
  });
});

describe("formatListReport", () => {
  it("criterion 3: counts per group and role with a total, groups sorted, roles in fixed order", () => {
    const report = formatListReport([
      { group: "b", role: "participant" },
      { group: "a", role: "admin" },
      { group: "a", role: "participant" },
      { group: "a", role: "participant" },
    ]);
    expect(report).toBe(
      ["Group  Role         Count", "a      participant      2", "a      admin            1", "b      participant      1", "Total                   4"].join(
        "\n",
      ),
    );
  });

  it("criterion 3: masks an address that landed in the group column", () => {
    const report = formatListReport([{ group: "jane@example.com", role: "participant" }]);
    expect(report).not.toContain("jane@example.com");
  });

  it("prints a zero total for an empty list", () => {
    expect(formatListReport([])).toBe("Group  Role  Count\nTotal            0");
  });
});
