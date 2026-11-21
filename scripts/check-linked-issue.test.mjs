// Tests for check-linked-issue.mjs. Run with: node --test scripts/*.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { namesIssue } from "./check-linked-issue.mjs";

const SCRIPT = fileURLToPath(new URL("./check-linked-issue.mjs", import.meta.url));

describe("namesIssue", () => {
  const accepted = [
    "Part of #5",
    "part of #5.",
    "Summary of the change. Part of #12, as agreed.",
    "- [x] Linked issue: closes #24",
    "Closes #7",
    "Closes: #7",
    "close #7",
    "closed #7",
    "Fixes #7",
    "fix #7",
    "fixed #7",
    "Resolves #7",
    "resolve #7",
    "resolved #7",
    "## Summary\r\n\r\nPart of #8.\r\n",
    "<!-- Describe the change -->\n\nCloses #3",
  ];
  for (const body of accepted) {
    test(`accepts ${JSON.stringify(body)}`, () => assert.equal(namesIssue(body), true));
  }

  const rejected = [
    ["an empty description", ""],
    ["a missing description", null],
    ["a missing description (undefined)", undefined],
    ["prose with no reference", "Tidies the README."],
    ["an issue number with no keyword", "See #5 for background."],
    ["a keyword with no number", "Closes #"],
    ["a placeholder instead of a number", "Part of #N"],
    ["a number with no hash", "Closes 5"],
    ["a keyword inside another word", "This encloses #5 in a box."],
    ["a prefix of another word", "prefix #5"],
    ["a number that runs into letters", "Closes #5abc"],
    ["a reference inside an HTML comment", "Change.\n\n<!-- Closes #N, for example Closes #12 -->"],
    ["a reference after an unclosed HTML comment", "Change.\n<!-- todo\nCloses #12"],
  ];
  for (const [name, body] of rejected) {
    test(`rejects ${name}`, () => assert.equal(namesIssue(body), false));
  }
});

describe("the script", () => {
  // Start from an environment without the variables under test.
  const { PR_BODY: _body, GITHUB_ACTIONS: _actions, ...baseEnv } = process.env;
  const run = (env) => spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { ...baseEnv, ...env } });

  test("exits 0 when the description names an issue", () => {
    const result = run({ PR_BODY: "Part of #5" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /names an issue/);
  });

  test("exits 1 and says what to add when it does not", () => {
    const result = run({ PR_BODY: "No reference here." });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^linked issue: The description names no issue\. Add "Part of #N"/);
  });

  test("exits 1 when there is no description at all", () => {
    assert.equal(run({}).status, 1);
  });

  test("writes a GitHub Actions error annotation when run in Actions", () => {
    const result = run({ PR_BODY: "", GITHUB_ACTIONS: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^::error::The description names no issue/);
  });

  test("does not treat the description as shell input", () => {
    const result = run({ PR_BODY: '"; exit 0; echo "$(Closes #1)`' });
    assert.equal(result.status, 0); // it names an issue, and nothing was executed
    assert.equal(run({ PR_BODY: "$(echo Closes) `#1`" }).status, 1);
  });
});
