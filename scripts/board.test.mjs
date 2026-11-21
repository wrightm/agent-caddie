// Tests for board.sh. Run with: node --test scripts/*.test.mjs
//
// board.sh talks to GitHub through the gh CLI. These tests put a stand-in
// `gh` first on PATH that records each call and returns canned answers, so
// nothing reaches GitHub. They need bash and jq, as the script does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./board.sh", import.meta.url));

// Answers as `gh ... --jq` would print them. FAIL_ON makes one call fail.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ -n "\${FAIL_ON:-}" && "$*" == *"$FAIL_ON"* ]]; then
  echo "gh: simulated failure" >&2
  exit 1
fi
case "$*" in
  *updateProjectV2ItemFieldValue*) echo '{}' ;;
  *addProjectV2ItemById*) echo 'ITEM_7' ;;
  *'field(name: "Status")'*)
    echo '{"id":"FIELD_1","options":[{"id":"OPT_TODO","name":"Todo"},{"id":"OPT_PROGRESS","name":"In Progress"},{"id":"OPT_DONE","name":"Done"}]}' ;;
  *"/issues/"*) echo 'NODE_42' ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 9 ;;
esac
`;

describe("board.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const log = join(dir, "gh.log");
  beforeEach(() => rmSync(log, { force: true }));

  const run = (args, env = {}) =>
    spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GH_LOG: log, ...env },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

  test("sets the status of an item, using the ids GitHub returned", () => {
    const result = run(["42", "In Progress"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "board: #42 is In Progress\n");

    const made = calls();
    assert.match(made, /repos\/wrightm\/agent-caddie\/issues\/42 /);
    // The item is added with the node id of issue 42 ...
    assert.match(made, /c=NODE_42[\s\S]*addProjectV2ItemById/);
    // ... and the update names that item, the Status field and the chosen option.
    const update = made.split("\n").find((line) => line.includes("i=ITEM_7"));
    assert.ok(update, made);
    assert.match(update, /f=FIELD_1/);
    assert.match(update, /o=OPT_PROGRESS/);
  });

  test("maps each status name to its own option", () => {
    for (const [status, option] of [["Todo", "OPT_TODO"], ["Done", "OPT_DONE"]]) {
      rmSync(log, { force: true });
      assert.equal(run(["7", status]).status, 0);
      assert.match(calls(), new RegExp(`o=${option}\\b`));
    }
  });

  test("always targets the project board", () => {
    run(["42", "Done"]);
    const withProject = calls().split("\n").filter((line) => line.includes("p=PVT_"));
    assert.equal(withProject.length, 3); // field lookup, add, update
  });

  test("rejects a wrong number of arguments without calling GitHub", () => {
    for (const args of [[], ["42"], ["42", "Done", "extra"]]) {
      const result = run(args);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, /^usage: scripts\/board\.sh/);
    }
    assert.equal(calls(), "");
  });

  test("rejects an item number that is not a number", () => {
    for (const number of ["abc", "#42", "42a", "-1", "4 2", ""]) {
      const result = run([number, "Done"]);
      assert.equal(result.status, 2, number);
    }
    assert.equal(calls(), "");
  });

  test("rejects an unknown status, lists the valid ones, and changes nothing", () => {
    for (const status of ["Doing", "done", "In progress", ""]) {
      rmSync(log, { force: true });
      const result = run(["42", status]);
      assert.equal(result.status, 2, status);
      assert.match(result.stderr, /the board has: Todo, In Progress, Done/);
      assert.doesNotMatch(calls(), /mutation/);
    }
  });

  test("stops with a failure when the item cannot be found", () => {
    const result = run(["999", "Done"], { FAIL_ON: "/issues/999" });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /board: #999/);
    assert.doesNotMatch(calls(), /mutation/);
  });

  test("stops with a failure when the board refuses the item", () => {
    const result = run(["42", "Done"], { FAIL_ON: "addProjectV2ItemById" });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /board: #42/);
    assert.doesNotMatch(calls(), /updateProjectV2ItemFieldValue/);
  });

  test("does not report success when the status update fails", () => {
    const result = run(["42", "Done"], { FAIL_ON: "updateProjectV2ItemFieldValue" });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /board: #42/);
  });
});
