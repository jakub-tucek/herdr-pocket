import { test } from "node:test";
import assert from "node:assert/strict";
import { readRoute, routeUrl } from "../web/navigation";

test("URL routes preserve machine-qualified terminals and search", () => {
  const href = routeUrl("https://pocket.test/", { terminal: "remote/t2q", query: "security & db" });
  assert.deepEqual(readRoute(href), { terminal: "remote/t2q", query: "security & db" });
  assert.equal(new URL(href).pathname, "/");
});
test("overview clears only navigation fields, not unrelated URL state", () => {
  const href = routeUrl("https://pocket.test/?terminal=remote%2Ft1&q=test&other=1", { query: "" });
  assert.equal(href, "https://pocket.test/?other=1");
  assert.deepEqual(readRoute(href), { terminal: undefined, query: "" });
});
test("URL state never enables terminal input", () => {
  assert.deepEqual(readRoute("https://pocket.test/?terminal=t1&control=1"), { terminal: "t1", query: "" });
});
