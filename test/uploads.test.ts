import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_UPLOAD, uploadName, pastedPaths } from "../upload-format";

test("upload names cannot escape core's managed folder or inject terminal controls", () => {
  assert.equal(uploadName("../../screenshot.png"), "screenshot.png");
  assert.equal(uploadName("C:\\folder\\image.png"), "image.png");
  assert.equal(uploadName("bad\r\nname.png"), "bad__name.png");
  assert.equal(uploadName("--image.png"), "image.png");
  assert.ok(uploadName("a".repeat(300) + ".png").length <= 120);
  assert.equal(MAX_UPLOAD, 8 * 1024 * 1024);
});
test("paths are pasted, shell-quoted when needed, without submitting", () => {
  assert.equal(pastedPaths(["/files/image.png"]), "/files/image.png ");
  assert.equal(pastedPaths(["/a b/file.png", "/a'b/x"]), "'/a b/file.png' '/a'\\''b/x' ");
  assert.ok(!pastedPaths(["/image.png"]).includes("\r"));
});
