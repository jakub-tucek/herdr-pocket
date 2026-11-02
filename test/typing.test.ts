import { test } from "node:test";
import assert from "node:assert/strict";
import { controlInput, pasteInput } from "../web/typing";

test("composer follows the terminal's bracketed-paste mode and normalizes newlines", () => {
  assert.equal(pasteInput("one\r\ntwo\nthree", false), "one\rtwo\rthree");
  assert.equal(pasteInput("one\ntwo", true), "\x1b[200~one\rtwo\x1b[201~");
});
test("one-shot Ctrl supports letters and standard terminal control keys", () => {
  assert.equal(controlInput("c"), "\x03");
  assert.equal(controlInput("C"), "\x03");
  assert.equal(controlInput("u"), "\x15");
  assert.equal(controlInput("["), "\x1b");
  assert.equal(controlInput(" "), "\x00");
  assert.equal(controlInput("?"), "\x7f");
  assert.equal(controlInput("é"), undefined);
  assert.equal(controlInput("ab"), undefined);
});
