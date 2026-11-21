// Tests for check-mermaid.mjs. Run with: node --test scripts/*.test.mjs
//
// Two layers:
//   - unit tests of the pure functions, with a fake renderer, which need
//     neither a browser nor the network;
//   - end-to-end tests that run the script as a child process against the
//     real Mermaid CLI. These need npx and a browser (see CHROME_PATH in
//     check-mermaid.mjs). They prove the script against the real tool, and
//     fail if a new Mermaid CLI version changes its exit codes or the
//     wording of its parse errors.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFiles, describeFailure, mermaidBlocks, summarise } from "./check-mermaid.mjs";

const SCRIPT = fileURLToPath(new URL("./check-mermaid.mjs", import.meta.url));

const VALID = ["sequenceDiagram", "    A->>B: hello", "    B-->>A: hi"].join("\n");
// A semicolon ends a statement, so line 3 of this diagram does not parse.
const BROKEN = ["sequenceDiagram", "    A->>B: hello", "    B-->>A: one; two"].join("\n");

const fence = (source, mark = "```") => `${mark}mermaid\n${source}\n${mark}`;

describe("mermaidBlocks", () => {
  test("returns nothing for text without diagrams", () => {
    assert.deepEqual(mermaidBlocks("# Title\n\nSome prose.\n"), []);
  });

  test("returns the source and the line of the opening fence", () => {
    const text = `# Title\n\n${fence(VALID)}\n`;
    assert.deepEqual(mermaidBlocks(text), [{ line: 3, source: VALID }]);
  });

  test("returns every block, in order", () => {
    const text = `${fence("graph TD\n    A-->B")}\n\ntext\n\n${fence(VALID)}\n`;
    const blocks = mermaidBlocks(text);
    assert.deepEqual(
      blocks.map((block) => block.line),
      [1, 8],
    );
    assert.equal(blocks[1].source, VALID);
  });

  test("ignores fences in other languages", () => {
    const text = "```text\nsequenceDiagram\n```\n\n```json\n{}\n```\n";
    assert.deepEqual(mermaidBlocks(text), []);
  });

  test("ignores a mermaid fence shown inside a longer fence", () => {
    const text = `\`\`\`\`markdown\n${fence(VALID)}\n\`\`\`\`\n`;
    assert.deepEqual(mermaidBlocks(text), []);
  });

  test("accepts tilde fences, indented fences and CRLF line endings", () => {
    assert.deepEqual(mermaidBlocks(fence(VALID, "~~~")), [{ line: 1, source: VALID }]);
    assert.equal(mermaidBlocks(`- item\n\n  \`\`\`mermaid\n  graph TD\n  \`\`\`\n`)[0].line, 3);
    assert.deepEqual(mermaidBlocks(fence(VALID).replaceAll("\n", "\r\n")), [{ line: 1, source: VALID }]);
  });

  test("does not close a backtick fence with tildes", () => {
    const blocks = mermaidBlocks("```mermaid\ngraph TD\n~~~\n    A-->B\n```\n");
    assert.equal(blocks[0].source, "graph TD\n~~~\n    A-->B");
  });

  test("treats an unclosed fence as running to the end of the text", () => {
    assert.deepEqual(mermaidBlocks("intro\n\n```mermaid\ngraph TD\n    A-->B"), [
      { line: 3, source: "graph TD\n    A-->B" },
    ]);
  });
});

describe("describeFailure", () => {
  const diagram = { file: "docs/a.md", line: 10, source: BROKEN };

  test("reports a parse error at its line in the Markdown file", () => {
    const output = "Error: Parse error on line 3:\n...A: one; two\n----------^\nExpecting 'SOLID_ARROW', got 'NEWLINE'";
    assert.deepEqual(describeFailure(diagram, output), [
      "docs/a.md:13: Mermaid parse error",
      "  ...A: one; two",
      "  ----------^",
    ]);
  });

  test("reports any other failure at the opening fence, with its first line", () => {
    assert.deepEqual(describeFailure(diagram, "\n\nError: Could not find Chrome\n    at launch"), [
      "docs/a.md:10: diagram failed to render: Error: Could not find Chrome",
    ]);
  });

  test("still reports a failure that produced no output", () => {
    assert.deepEqual(describeFailure(diagram, ""), ["docs/a.md:10: diagram failed to render: unknown error"]);
  });
});

describe("checkFiles and summarise", () => {
  const texts = {
    "plain.md": "# No diagrams\n",
    "good.md": `# Good\n\n${fence(VALID)}\n`,
    "mixed.md": `${fence(VALID)}\n\n${fence(BROKEN)}\n`,
  };
  const read = (file) => texts[file];
  // Fails exactly the diagrams that contain a semicolon, as Mermaid does.
  const render = (source) =>
    source.includes(";")
      ? { ok: false, output: "Error: Parse error on line 3:\n...one; two\n-------^" }
      : { ok: true, output: "" };

  test("passes when there are no diagrams, without rendering anything", () => {
    const result = checkFiles(["plain.md"], {
      read,
      render: () => assert.fail("render must not be called"),
    });
    assert.deepEqual(summarise(result), {
      exitCode: 0,
      message: "mermaid: no diagrams in 1 file(s), nothing to check",
    });
  });

  test("passes when every diagram renders", () => {
    const result = checkFiles(["plain.md", "good.md"], { read, render });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(summarise(result), {
      exitCode: 0,
      message: "mermaid: 1 diagram(s) checked in 2 file(s), all valid",
    });
  });

  test("fails when any diagram fails, and names its file and line", () => {
    const result = checkFiles(["good.md", "mixed.md"], { read, render });
    // The broken block opens on line 7 of mixed.md; the error is on its third line.
    assert.equal(result.errors[0], "mixed.md:10: Mermaid parse error");
    assert.deepEqual(summarise(result), {
      exitCode: 1,
      message: "mermaid: 1 of 3 diagram(s) failed in 2 file(s)",
    });
  });

  test("carries on after a failure and reports every broken diagram", () => {
    const result = checkFiles(["mixed.md", "mixed.md"], { read, render });
    assert.equal(result.failed, 2);
    assert.equal(result.diagramCount, 4);
  });
});

describe("end to end, against the real Mermaid CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-mermaid-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const run = (...files) => spawnSync(process.execPath, [SCRIPT, ...files], { encoding: "utf8" });

  test("exits 0 for a file without diagrams", () => {
    const result = run(write("plain.md", "# No diagrams\n"));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no diagrams in 1 file\(s\)/);
  });

  test("exits 0 when every diagram renders", { timeout: 180_000 }, () => {
    const result = run(write("good.md", `# Good\n\n${fence(VALID)}\n\n${fence("graph TD\n    A-->B")}\n`));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 diagram\(s\) checked in 1 file\(s\), all valid/);
  });

  test("exits 1 and names the file and line of a diagram that does not parse", { timeout: 180_000 }, () => {
    const file = write("broken.md", `# Broken\n\n${fence(VALID)}\n\ntext\n\n${fence(BROKEN)}\n`);
    const result = run(file);
    assert.equal(result.status, 1);
    // The broken block opens on line 11; the error is on its third line.
    assert.ok(result.stderr.includes(`${file}:14: Mermaid parse error`), result.stderr);
    assert.match(result.stderr, /1 of 2 diagram\(s\) failed in 1 file\(s\)/);
  });
});
