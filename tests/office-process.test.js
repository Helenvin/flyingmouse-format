const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { defaultExecutor } = require("../office-process");

test("timeout terminates this invocation's descendants and preserves an unrelated process", { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fm-proc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "child.pid");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => unrelated.kill());
  const script = `const child = require('node:child_process').spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
    require('node:fs').writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`;
  await assert.rejects(defaultExecutor(process.execPath, ["-e", script, pidFile], { timeout: 1500 }),
    (error) => error.code === "ETIMEDOUT" && error.timedOut === true && error.treeTerminated === true);
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("successful execution returns captured diagnostics and leaves no timeout", async () => {
  const result = await defaultExecutor(process.execPath, ["-e", "process.stdout.write('ok');process.stderr.write('warning')"], { timeout: 5000 });
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warning");
});
