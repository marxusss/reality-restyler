import { test } from "node:test";
import assert from "node:assert/strict";
import { stylesToSync } from "../web/styles.js";

test("deletion wins a same-timestamp conflict with a live remote style", () => {
  const remote = [{id: "a", name: "Portrait", prompt: "portrait", updatedAt: 200}];
  const local = [{id: "a", deleted: true, updatedAt: 200}];
  assert.deepEqual(stylesToSync(local, remote), local);
});

test("old edits cannot resurrect a deleted remote style", () => {
  const remote = [{id: "a", deleted: true, updatedAt: 200}];
  const local = [{id: "a", name: "Old", prompt: "old", updatedAt: 199}];
  assert.deepEqual(stylesToSync(local, remote), []);
});

test("unchanged updates are not sent again, newer edits are", () => {
  const remote = [{id: "a", updatedAt: 200}];
  const local = [{id: "a", updatedAt: 200}, {id: "b", updatedAt: 99},
    {id: "a", updatedAt: 201}];
  assert.deepEqual(stylesToSync(local, remote), local.slice(1));
});
