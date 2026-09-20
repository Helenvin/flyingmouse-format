"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { test, before, after, mock } = require("node:test");
const { PDFDocument } = require("pdf-lib");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-progress-http-"));
process.env.FLYINGMOUSE_RUNTIME_DIR = root;
process.env.FLYINGMOUSE_LOG_FILE = path.join(root, "test.log");
const config = require("../config");
config.MAX_UPLOAD_BYTES = 4096;
// Capability discovery is unrelated to this lifecycle test. All conversions
// below still execute the real routes, Multer storage and JS image/PDF engines.
mock.method(require("../utils"), "commandExists", async () => false);
mock.method(require("../office-engine"), "probeLibreOffice", async () => ({ enabled: false }));
mock.method(require("../markdown-document"), "pandocPath", () => "");
mock.method(require("../pdf-structure-engine"), "getStructuredPdfAvailability", async () => ({ enabled: false }));
const { app } = require("../server");
let server, origin;
before(async () => {
  require("../utils").ensureDirs();
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true });
});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>';
function imageForm() { const form = new FormData(); form.append("file", new Blob([svg]), "private-name.svg"); form.append("targetFormat", "png"); return form; }
async function progress(id) {
  const response = await fetch(`${origin}/api/conversion-progress/${id}`, { headers: { Origin: origin } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
async function waitForSnapshot(id, predicate) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${origin}/api/conversion-progress/${id}`);
    if (response.ok) { const value = await response.json(); if (predicate(value)) return value; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("expected progress state was not observed");
}

test("real single conversion preserves downloadable content and publishes a private terminal receipt", async () => {
  const id = randomUUID();
  const response = await fetch(origin + "/api/convert", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": id }, body: imageForm() });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.ok, true);
  const bytes = Buffer.from(await (await fetch(origin + result.downloadUrl)).arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  const state = await progress(id); assert.equal(state.status, "succeeded"); assert.equal(state.stage, "completed");
  assert.deepEqual(Object.keys(state).sort(), ["id", "status", "stage", "completed", "total", "unit", "elapsedMs", "updatedAt"].sort());
  assert.ok(state.elapsedMs >= 0); assert.equal(state.total, null);
  assert.ok(!JSON.stringify(state).includes("private-name")); assert.ok(!JSON.stringify(state).includes(root));
});

test("image and PDF merge endpoints only complete after usable outputs exist", async () => {
  const imageId = randomUUID(), images = new FormData(); images.append("files", new Blob([svg]), "a.svg"); images.append("files", new Blob([svg]), "b.svg");
  const imageResponse = await fetch(origin + "/api/convert-images-to-pdf", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": imageId }, body: images });
  assert.equal(imageResponse.status, 200); const imageResult = await imageResponse.json();
  const pdfBytes = await (await fetch(origin + imageResult.downloadUrl)).arrayBuffer();
  assert.equal((await PDFDocument.load(pdfBytes)).getPageCount(), 2); assert.equal((await progress(imageId)).status, "succeeded");
  const pdfId = randomUUID(), pdfs = new FormData(); pdfs.append("files", new Blob([pdfBytes]), "a.pdf"); pdfs.append("files", new Blob([pdfBytes]), "b.pdf");
  const pdfResponse = await fetch(origin + "/api/merge-pdfs", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": pdfId }, body: pdfs });
  assert.equal(pdfResponse.status, 200); const pdfResult = await pdfResponse.json();
  assert.equal((await PDFDocument.load(await (await fetch(origin + pdfResult.downloadUrl)).arrayBuffer())).getPageCount(), 4);
  assert.equal((await progress(pdfId)).status, "succeeded");
});

test("same-origin checks, invalid headers and duplicate IDs reject before conversion", async () => {
  const id = randomUUID();
  let response = await fetch(origin + "/api/convert", { method: "POST", headers: { Origin: "https://evil.example", "X-FlyingMouse-Progress-Id": id }, body: imageForm() });
  assert.equal(response.status, 403);
  assert.equal((await fetch(origin + "/api/conversion-progress/" + id)).status, 404);
  response = await fetch(origin + "/api/convert", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": "not-a-uuid" }, body: imageForm() }); assert.equal(response.status, 400);
  response = await fetch(origin + "/api/convert", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": id }, body: imageForm() }); assert.equal(response.status, 200); await response.json();
  const beforeState = await progress(id);
  response = await fetch(origin + "/api/convert", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": id }, body: imageForm() }); assert.equal(response.status, 409);
  assert.deepEqual(await progress(id), beforeState);
  assert.equal((await fetch(origin + "/api/conversion-progress/" + id, { headers: { Origin: "null" } })).status, 403);
  assert.equal((await fetch(origin + "/api/conversion-progress/" + id, { headers: { Referer: "http://127.0.0.1:1/" } })).status, 403);
  assert.equal((await fetch(origin + "/api/conversion-progress/not-a-uuid")).status, 400);
});

test("upload rejection, route validation and thrown conversion errors terminate as failed", async () => {
  for (const kind of ["large", "missing", "invalid"]) {
    const id = randomUUID(), form = new FormData(); form.append("targetFormat", "png");
    if (kind !== "missing") form.append("file", new Blob([kind === "large" ? Buffer.alloc(4097) : "broken image"]), "bad.svg");
    const response = await fetch(origin + "/api/convert", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": id }, body: form });
    assert.ok(response.status >= 400); await response.json(); assert.equal((await progress(id)).status, "failed");
  }
});

test("output validation failure cannot publish succeeded after the engine returns", async t => {
  const stat = fsp.stat;
  t.mock.method(fsp, "stat", async (file, ...rest) => {
    if (path.resolve(String(file)).startsWith(path.resolve(config.OUTPUT_DIR) + path.sep)) throw new Error("fixture output validation failure");
    return stat(file, ...rest);
  });
  const id = randomUUID();
  const response = await fetch(origin + "/api/convert", { method: "POST", headers: { "X-FlyingMouse-Progress-Id": id }, body: imageForm() });
  assert.equal(response.status, 500); await response.json(); assert.equal((await progress(id)).status, "failed");
});

for (const abort of [false, true]) test(`actual handler remains running through output validation; abort=${abort}`, async t => {
  const stat = fsp.stat;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  t.after(release);
  t.mock.method(fsp, "stat", async (file, ...rest) => {
    if (path.resolve(String(file)).startsWith(path.resolve(config.OUTPUT_DIR) + path.sep)) {
      const value = await stat(file, ...rest);
      // A filesystem boundary callback executes inside this real handler's ALS.
      require("../conversion-progress").reportConversionProgress({ stage: "validating", completed: 1, total: 1, unit: "files" });
      await barrier;
      return value;
    }
    return stat(file, ...rest);
  });
  const id = randomUUID(), controller = new AbortController();
  const request = fetch(origin + "/api/convert", { method: "POST", signal: controller.signal,
    headers: { "X-FlyingMouse-Progress-Id": id }, body: imageForm() });
  // Observe rejection immediately if cancellation occurs before assertions end.
  request.catch(() => {});
  const state = await waitForSnapshot(id, value => value.stage === "validating" && value.completed === 1);
  assert.equal(state.status, "running", "100% of a stage is not a completed conversion");
  if (abort) {
    controller.abort(); await assert.rejects(request, { name: "AbortError" });
    await waitForSnapshot(id, value => value.status === "failed");
  }
  release();
  if (abort) {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await progress(id)).status, "failed", "late engine/outputReady events must not revive cancellation");
  } else {
    const response = await request; assert.equal(response.status, 200); await response.json();
    assert.equal((await progress(id)).status, "succeeded");
  }
});

test("partial HTTP upload reports real bytes before parsing and abort becomes failed", async () => {
  const id = randomUUID();
  const request = http.request(origin + "/api/convert", { method: "POST", headers: {
    "Content-Type": "multipart/form-data; boundary=progress-test", "Content-Length": "1000", "X-FlyingMouse-Progress-Id": id
  } });
  request.on("error", () => {});
  const chunk = Buffer.from("--progress-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.svg\"\r\nContent-Type: image/svg+xml\r\n\r\npartial");
  request.write(chunk);
  const state = await waitForSnapshot(id, value => value.completed === chunk.length);
  assert.equal(state.stage, "uploading"); assert.equal(state.total, 1000); assert.equal(state.unit, "bytes");
  request.destroy();
  const failed = await waitForSnapshot(id, value => value.status === "failed");
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(await progress(id), failed);
});

test("legacy requests without the optional progress header keep their response contract", async () => {
  const response = await fetch(origin + "/api/convert", { method: "POST", body: imageForm() });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.ok, true); assert.ok(body.downloadUrl); assert.equal(body.progress, undefined);
});
