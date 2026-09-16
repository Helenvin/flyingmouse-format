const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { buildDiagnosticsReport } = require("../diagnostics");
const { readLastSaveDirectory, writeLastSaveDirectory, readSettings } = require("../settings-store");
const saveDownload = require("../save-download");

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-diagnostics-export-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "existing-report.txt");
  const settingsPath = path.join(root, "settings.json");
  await fsp.writeFile(destination, "OLD USER REPORT");
  // Execute the actual registered handler at its filesystem seam, without
  // starting Electron or its conversion service just to test report publication.
  const source = await fsp.readFile(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const start = source.indexOf('ipcMain.handle("export-diagnostics",');
  const end = source.indexOf("\nipcMain.handle(", start + 1);
  assert.ok(start >= 0 && end > start, "diagnostics IPC handler must be present");
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, registered) => { handler = registered; } },
    assertTrustedIpc: () => {}, fs, os, path, process, settingsPath,
    readLastSaveDirectory, writeLastSaveDirectory, saveDownload,
    mainWindow: {}, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
    logger: { getLogFile: () => path.join(root, "debug.log") },
    serverRuntime: { getToolDiagnostics: async () => ({}) },
    app: { getPath: () => root, getVersion: () => "test", commandLine: { hasSwitch: () => true } },
    packageType: () => "test", buildDiagnosticsReport, log: () => {}
  });
  return { root, destination, settingsPath, exportReport: () => handler({}) };
}

test("diagnostics export preserves the old target when a disk-full write truncates its output", async (t) => {
  const f = await fixture(t);
  const writeFile = fsp.writeFile;
  t.mock.method(fsp, "writeFile", async (destination, _content, ...args) => {
    await writeFile(destination, "PARTIAL", ...args);
    throw Object.assign(new Error("disk full during report write"), { code: "ENOSPC" });
  });
  await assert.rejects(f.exportReport(), { code: "ENOSPC" });
  assert.equal(await fsp.readFile(f.destination, "utf8"), "OLD USER REPORT");
  assert.deepEqual(await fsp.readdir(f.root), ["existing-report.txt"]);
});

test("diagnostics export preserves the old target and settings when publishing is denied", async (t) => {
  const f = await fixture(t);
  t.mock.method(fsp, "rename", async () => {
    throw Object.assign(new Error("destination is locked"), { code: "EACCES" });
  });
  await assert.rejects(f.exportReport(), { code: "EACCES" });
  assert.equal(await fsp.readFile(f.destination, "utf8"), "OLD USER REPORT");
  assert.deepEqual(await fsp.readdir(f.root), ["existing-report.txt"]);
});

test("diagnostics export publishes the whole report before remembering the directory", async (t) => {
  const f = await fixture(t);
  const result = await f.exportReport();
  assert.equal(result.canceled, false);
  assert.equal(result.filePath, f.destination);
  const report = await fsp.readFile(f.destination, "utf8");
  assert.match(report, /^FlyingMouse Format diagnostics\n/);
  assert.match(report, /Recent log \(sanitized\):\n$/);
  assert.equal((await readSettings(f.settingsPath)).lastSaveDirectory, f.root);
  assert.deepEqual((await fsp.readdir(f.root)).sort(), ["existing-report.txt", "settings.json"]);
});
