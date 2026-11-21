// Tests for check-front-matter.mjs. Run with: node --test scripts/*.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkDocument, isIsoDate, parseFrontMatter } from "./check-front-matter.mjs";

const SCRIPT = fileURLToPath(new URL("./check-front-matter.mjs", import.meta.url));

const LIVING = {
  title: "Flows",
  status: "living",
  "last-verified": "2026-11-11",
  owner: "maintainers",
  "depends-on-adrs": "[0002, 0007]",
};
const SPEC = {
  title: "Design",
  status: "approved",
  date: "2026-11-11",
  authors: "[someone]",
  supersedes: "none",
  "superseded-by": "none",
  "living-docs": "[docs/architecture/overview.md]",
};

/** Builds a document from front-matter fields; a null value drops the field. */
function doc(base, changes = {}) {
  const fields = { ...base, ...changes };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n# Heading\n\nBody.\n`;
}

describe("isIsoDate", () => {
  test("accepts real dates", () => {
    assert.equal(isIsoDate("2026-11-11"), true);
    assert.equal(isIsoDate("2024-02-29"), true); // leap year
  });

  test("rejects other formats and impossible dates", () => {
    for (const value of ["2026-1-1", "11/11/2026", "2026-11-11T00:00", "yesterday", "", "2026-13-01", "2026-02-30", "2025-02-29"]) {
      assert.equal(isIsoDate(value), false, value);
    }
  });
});

describe("parseFrontMatter", () => {
  test("returns null when there is no front matter", () => {
    assert.equal(parseFrontMatter("# Title\n\nBody.\n"), null);
    assert.equal(parseFrontMatter(""), null);
    assert.equal(parseFrontMatter("\n---\ntitle: x\n---\n"), null); // must be the first line
  });

  test("returns null when the block is never closed", () => {
    assert.equal(parseFrontMatter("---\ntitle: x\n\n# Title\n"), null);
  });

  test("reads flat key: value fields", () => {
    assert.deepEqual(parseFrontMatter("---\ntitle: Flows\nlast-verified: 2026-11-11\n---\nbody\n"), {
      title: "Flows",
      "last-verified": "2026-11-11",
    });
  });

  test("keeps colons and brackets inside a value", () => {
    const fields = parseFrontMatter("---\ntitle: Caddie: a coach\ndepends-on-adrs: [0002, 0007]\n---\n");
    assert.deepEqual(fields, { title: "Caddie: a coach", "depends-on-adrs": "[0002, 0007]" });
  });

  test("handles CRLF line endings and trailing spaces", () => {
    assert.deepEqual(parseFrontMatter("---  \r\ntitle: Flows  \r\n--- \r\nbody\r\n"), { title: "Flows" });
  });

  test("reads an empty value as empty, and ignores lines that are not fields", () => {
    assert.deepEqual(parseFrontMatter("---\ntitle:\n# a comment\n  - item\n---\n"), { title: "" });
  });

  test("stops at the closing line, ignoring later rules in the body", () => {
    assert.deepEqual(parseFrontMatter("---\ntitle: a\n---\n\nowner: b\n\n---\n"), { title: "a" });
  });
});

describe("checkDocument", () => {
  test("accepts a valid living document", () => {
    assert.deepEqual(checkDocument("architecture/flows.md", doc(LIVING)), []);
  });

  test("accepts a valid spec, in every allowed status", () => {
    for (const status of ["draft", "approved", "implemented", "superseded"]) {
      assert.deepEqual(checkDocument("specs/2026-11-11-agent-caddie-design.md", doc(SPEC, { status })), []);
    }
  });

  test("exempts README files and skips docs/adr/", () => {
    assert.deepEqual(checkDocument("README.md", "# Map\n"), []);
    assert.deepEqual(checkDocument("specs/README.md", "# Map\n"), []);
    assert.deepEqual(checkDocument("adr/0001-example.md", "# No front matter\n"), []);
  });

  test("reports a document with no front matter", () => {
    assert.deepEqual(checkDocument("architecture/flows.md", "# Flows\n"), [
      "missing front matter (file must start with a --- block)",
    ]);
  });

  test("reports each missing or empty required field", () => {
    assert.deepEqual(checkDocument("architecture/flows.md", doc(LIVING, { owner: null, title: "" })), [
      'missing or empty field "title"',
      'missing or empty field "owner"',
    ]);
    for (const key of Object.keys(SPEC)) {
      const errors = checkDocument("specs/2026-11-11-x.md", doc(SPEC, { [key]: null }));
      assert.ok(errors.includes(`missing or empty field "${key}"`), key);
    }
    for (const key of Object.keys(LIVING)) {
      const errors = checkDocument("dev/guide.md", doc(LIVING, { [key]: null }));
      assert.ok(errors.includes(`missing or empty field "${key}"`), key);
    }
  });

  test("keeps the two kinds apart by status", () => {
    assert.deepEqual(checkDocument("architecture/flows.md", doc(LIVING, { status: "approved" })), [
      'status "approved" must be one of: living',
    ]);
    assert.deepEqual(checkDocument("specs/2026-11-11-x.md", doc(SPEC, { status: "living" })), [
      'status "living" must be one of: draft, approved, implemented, superseded',
    ]);
  });

  test("reports a date that is not a real ISO date", () => {
    assert.deepEqual(checkDocument("architecture/flows.md", doc(LIVING, { "last-verified": "11 Nov 2026" })), [
      '"last-verified" must be an ISO date (YYYY-MM-DD), got "11 Nov 2026"',
    ]);
    assert.deepEqual(checkDocument("architecture/flows.md", doc(LIVING, { "last-verified": "2026-02-30" })), [
      '"last-verified" must be an ISO date (YYYY-MM-DD), got "2026-02-30"',
    ]);
  });

  test("reports a spec whose filename is not dated", () => {
    assert.deepEqual(checkDocument("specs/agent-caddie-design.md", doc(SPEC)), [
      "spec filename must be YYYY-MM-DD-<topic>.md",
      '"date" (2026-11-11) must match the date in the filename',
    ]);
    assert.deepEqual(checkDocument("specs/2026-11-11-Design_Notes.md", doc(SPEC)), [
      "spec filename must be YYYY-MM-DD-<topic>.md",
    ]);
  });

  test("reports a spec whose date differs from its filename", () => {
    assert.deepEqual(checkDocument("specs/2026-11-12-x.md", doc(SPEC)), [
      '"date" (2026-11-11) must match the date in the filename',
    ]);
  });

  test("treats only docs/specs/ as specs", () => {
    // A dated file elsewhere is a living document and needs living fields.
    const errors = checkDocument("architecture/2026-11-11-x.md", doc(SPEC));
    assert.ok(errors.includes('missing or empty field "owner"'));
  });
});

describe("the script", () => {
  const root = mkdtempSync(join(tmpdir(), "check-front-matter-test-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  /** Creates a docs directory holding the given files and returns its path. */
  const docsDir = (name, files) => {
    const dir = join(root, name);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const run = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });

  test("exits 0 when every document is valid, counting nested files", () => {
    const dir = docsDir("valid", {
      "README.md": "# Map\n",
      "architecture/flows.md": doc(LIVING),
      "architecture/deep/er.md": doc(LIVING),
      "specs/2026-11-11-design.md": doc(SPEC),
      "adr/0001-x.md": "# Skipped\n",
      "notes.txt": "not markdown",
    });
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /front matter: 5 file\(s\) checked, all valid/);
  });

  test("exits 1 and names each file and problem", () => {
    const dir = docsDir("invalid", {
      "architecture/flows.md": doc(LIVING, { owner: null }),
      "specs/2026-11-11-design.md": "# No front matter\n",
      "architecture/ok.md": doc(LIVING),
    });
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${join(dir, "architecture", "flows.md")}: missing or empty field "owner"`));
    assert.ok(result.stderr.includes(`${join(dir, "specs", "2026-11-11-design.md")}: missing front matter`));
    assert.match(result.stderr, /front matter: 2 problem\(s\) in 3 file\(s\)/);
  });

  test("exits 0 when the docs directory does not exist", () => {
    const result = run(join(root, "absent"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to check/);
  });
});
