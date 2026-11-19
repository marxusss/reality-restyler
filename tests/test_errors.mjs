import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorState } from "../web/errors.js";

test("successful polling cannot erase a camera or settings failure", () => {
  const errors = new ErrorState();
  errors.set("Connection lost", "camera");
  errors.set("Invalid prompt", "settings");
  errors.set("Poll failed", "metrics");
  assert.equal(errors.set("", "metrics"), "Connection lost · Invalid prompt");
  assert.equal(errors.set("", "camera"), "Invalid prompt");
  errors.clear();
  assert.equal(errors.text(), "");
});
