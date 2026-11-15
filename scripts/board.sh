#!/usr/bin/env bash
# Puts an issue or pull request on the project board and sets its Status.
# Adding is idempotent, so this is safe to run on an item already there.
#
# Usage: scripts/board.sh <issue-or-pr-number> <Todo|"In Progress"|Done>
#
# Needs the gh CLI, signed in with the `project` scope and write access to
# the board. Contributors without that access can skip it: the maintainer's
# board picks the item up.

set -euo pipefail

REPO="wrightm/agent-caddie"
PROJECT_ID="PVT_kwHOAEunn84BrqN7" # https://github.com/users/wrightm/projects/1

if [[ $# -ne 2 || ! $1 =~ ^[0-9]+$ ]]; then
  echo "usage: scripts/board.sh <issue-or-pr-number> <Todo|\"In Progress\"|Done>" >&2
  exit 2
fi
number="$1"
status="$2"

# The issues endpoint answers for pull requests too.
content_id="$(gh api "repos/$REPO/issues/$number" --jq .node_id)"

field="$(gh api graphql -f p="$PROJECT_ID" -f query='
  query($p: ID!) {
    node(id: $p) {
      ... on ProjectV2 {
        field(name: "Status") {
          ... on ProjectV2SingleSelectField { id options { id name } }
        }
      }
    }
  }' --jq .data.node.field)"
field_id="$(jq -r .id <<<"$field")"
option_id="$(jq -r --arg s "$status" '.options[] | select(.name == $s) | .id' <<<"$field")"
if [[ -z $option_id ]]; then
  echo "unknown status \"$status\"; the board has: $(jq -r '[.options[].name] | join(", ")' <<<"$field")" >&2
  exit 2
fi

item_id="$(gh api graphql -f p="$PROJECT_ID" -f c="$content_id" -f query='
  mutation($p: ID!, $c: ID!) {
    addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } }
  }' --jq .data.addProjectV2ItemById.item.id)"

gh api graphql -f p="$PROJECT_ID" -f i="$item_id" -f f="$field_id" -f o="$option_id" -f query='
  mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $p, itemId: $i, fieldId: $f, value: {singleSelectOptionId: $o}
    }) { projectV2Item { id } }
  }' >/dev/null

echo "board: #$number is $status"
