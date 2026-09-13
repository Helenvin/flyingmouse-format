const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const { test } = require("node:test");

const {
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_TIMEOUT_MS,
  REQUIRED_MODELS,
  getStructuredPdfAvailability,
  preflightStructuredPdf,
  createStructuredPdfBoundary,
  withStructuredPdf
} = require("../pdf-structure-engine");
const realExecFile = promisify(execFileCallback);

test("registers the runner test and development engine/model candidates", () => {
  const packageJson = require("../package.json");
  assert.match(`${packageJson.scripts.pretest || ""} ${packageJson.scripts.test}`, /tests\/pdf-structure-engine\.test\.js/);
  assert.match(`${packageJson.scripts["pretest:ci"] || ""} ${packageJson.scripts["test:ci"]}`, /tests\/pdf-structure-engine\.test\.js/);
  const configSource = require("node:fs").readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  assert.match(configSource, /bin["'],\s*["']docstructure["'],\s*["']docstructure-engine\.exe/);
  assert.match(configSource, /bin["'],\s*["']docstructure["'],\s*["']models/);
});

async function createHarness(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fm-engine-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const enginePath = path.join(root, "docstructure-engine.exe");
  const modelDirectory = path.join(root, "models");
  const inputPath = path.join(root, "input.pdf");
  const runtimeDir = path.join(root, "runtime");
  await fsp.writeFile(enginePath, "engine");
  // macOS/Linux 上可执行性检查（access X_OK）要求文件有 exec bit——fake 引擎需要 chmod，
  // 否则 mac CI 会误报 ENGINE_MISSING 而非预期的 MODEL_MISSING（Windows 无此语义，无害）。
  await fsp.chmod(enginePath, 0o755);
  await fsp.mkdir(modelDirectory);
  for (const name of REQUIRED_MODELS) {
    const model = path.join(modelDirectory, name);
    await fsp.mkdir(model);
    for (const file of ["inference.json", "inference.pdiparams", "inference.yml"]) {
      await fsp.writeFile(path.join(model, file), "test model");
    }
  }
  await fsp.mkdir(runtimeDir);
  const pdf = await require("pdf-lib").PDFDocument.create();
  pdf.addPage([100, 100]);
  await fsp.writeFile(inputPath, await pdf.save());
  return { enginePath, modelDirectory, inputPath, runtimeDir };
}

function validManifest() {
  return { schemaVersion: 1, engine: { name: "test", version: "1" }, pages: [] };
}

function options(harness, execFile, validateManifest = (manifest) => Object.freeze(manifest)) {
  return { ...harness, execFile, validateManifest };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("input.pdf"));
    return true;
  });
}

test("fails before spawning when the executable is absent", async (t) => {
  const harness = await createHarness(t);
  await fsp.rm(harness.enginePath);
  let spawned = false;
  await expectCode(withStructuredPdf(harness.inputPath, options(harness, () => { spawned = true; }), async () => {}), "PDF_STRUCTURE_ENGINE_MISSING");
  assert.equal(spawned, false);
});

test("fails before spawning when the model directory is absent", async (t) => {
  const harness = await createHarness(t);
  await fsp.rm(harness.modelDirectory, { recursive: true });
  let spawned = false;
  await expectCode(withStructuredPdf(harness.inputPath, options(harness, () => { spawned = true; }), async () => {}), "PDF_STRUCTURE_MODEL_MISSING");
  assert.equal(spawned, false);
});

test("uses exact private parse arguments, no shell, and a ten-minute timeout", async (t) => {
  const harness = await createHarness(t);
  let call;
  const result = await withStructuredPdf(harness.inputPath, options(harness, async (file, args, processOptions) => {
    call = { file, args, processOptions };
    await fsp.writeFile(path.join(args[4], "manifest.json"), JSON.stringify(validManifest()));
  }), async () => "ok");
  assert.equal(result, "ok");
  assert.equal(call.file, harness.enginePath);
  assert.equal(call.processOptions.shell, false);
  assert.equal(call.processOptions.timeout, 600000);
  assert.equal(call.processOptions.maxBuffer, DEFAULT_MAX_BUFFER_BYTES);
  assert.equal(DEFAULT_TIMEOUT_MS, 10 * 60 * 1000);
  assert.deepEqual(call.args.slice(0, 4), ["parse", "--input", harness.inputPath, "--output"]);
  assert.equal(path.dirname(call.args[4]), harness.runtimeDir);
  assert.match(path.basename(call.args[4]), /^fm-pdf-structure-/);
  assert.deepEqual(call.args.slice(5), ["--models", harness.modelDirectory, "--language", "ch"]);
});

test("injects a short timeout into a real direct child and cleans scratch", async (t) => {
  const harness = await createHarness(t);
  let scratch;
  let observedTimeout;
  const runOptions = options(harness, async (_file, args, processOptions) => {
    scratch = args[4];
    observedTimeout = processOptions.timeout;
    return realExecFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...processOptions,
      timeout: Math.min(processOptions.timeout, 100)
    });
  });
  runOptions.timeoutMs = 40;

  await expectCode(
    withStructuredPdf(harness.inputPath, runOptions, async () => {}),
    "PDF_STRUCTURE_PARSE_FAILED"
  );
  assert.equal(observedTimeout, 40);
  assert.ok(scratch);
  await assert.rejects(fsp.access(scratch));
  assert.deepEqual(await fsp.readdir(harness.runtimeDir), []);
});

for (const [name, failure] of [
  ["nonzero exit", Object.assign(new Error("private source text"), { code: 139, stderr: "secret OCR" })],
  ["timeout", Object.assign(new Error("timed out at private path"), { code: "ETIMEDOUT", killed: true })]
]) {
  test(`redacts ${name} failures`, async (t) => {
    const harness = await createHarness(t);
    await expectCode(withStructuredPdf(harness.inputPath, options(harness, async () => { throw failure; }), async () => {}), "PDF_STRUCTURE_PARSE_FAILED");
  });
}

// 2026-09-07：引擎 segfault（SIGSEGV，重跑可成功）与 10 分钟超时（需拆文件）
// 的用户动作不同，文案必须区分；两者错误码保持 PDF_STRUCTURE_PARSE_FAILED 不变。
test("separates timeout and engine-crash user messages", async (t) => {
  const harness = await createHarness(t);
  const cases = [
    [Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true }), "超时"],
    [Object.assign(new Error("crashed"), { code: null, signal: "SIGSEGV", killed: false }), "意外退出"]
  ];
  for (const [failure, needle] of cases) {
    await assert.rejects(
      withStructuredPdf(harness.inputPath, options(harness, async () => { throw failure; }), async () => {}),
      (error) => {
        assert.equal(error.code, "PDF_STRUCTURE_PARSE_FAILED");
        assert.ok(String(error.messages?.zhCN || "").includes(needle), `expected "${needle}" in ${error.messages?.zhCN}`);
        return true;
      }
    );
  }
});

test("collapses engine exit status and output without retaining a cause", async (t) => {
  const harness = await createHarness(t);
  const privateFailure = Object.assign(new Error("private source path"), {
    code: 23,
    stdout: "recognized private text",
    stderr: "private model status"
  });
  await assert.rejects(
    withStructuredPdf(harness.inputPath, options(harness, async () => { throw privateFailure; }), async () => {}),
    (error) => {
      assert.equal(error.code, "PDF_STRUCTURE_RESOURCE_LIMIT");
      assert.equal(error.cause, undefined);
      assert.equal(error.status, undefined);
      assert.doesNotMatch(JSON.stringify(error), /private|recognized|23/);
      return true;
    }
  );
});

test("Lite availability and missing-engine guidance preserve the fallback error code", async (t) => {
  const harness = await createHarness(t);
  await fsp.rm(harness.enginePath);
  assert.equal((await getStructuredPdfAvailability({ ...harness, engineProfile: "lite" })).profile, "lite");
  assert.equal((await getStructuredPdfAvailability({ ...harness, engineProfile: "full" })).profile, undefined);
  await assert.rejects(withStructuredPdf(harness.inputPath, { ...harness, engineProfile: "lite" }, async () => {}), (error) => {
    assert.equal(error.code, "PDF_STRUCTURE_ENGINE_MISSING");
    assert.match(error.messages.zhCN, /轻量版.*完整版/u);
    assert.match(error.messages.enUS, /Lite.*Full/u);
    return true;
  });
});

test("reports native model, resource, output and launch failures without stderr", async (t) => {
  const harness = await createHarness(t);
  for (const [code, expected] of [[20, "PDF_STRUCTURE_MODEL_MISSING"],
    [23, "PDF_STRUCTURE_RESOURCE_LIMIT"], [22, "PDF_STRUCTURE_SCHEMA_INVALID"],
    [21, "PDF_STRUCTURE_PARSE_FAILED"], ["ENOENT", "PDF_STRUCTURE_ENGINE_MISSING"]]) {
    const failure = Object.assign(new Error("private"), { code, stderr: "private OCR\nMODEL_MISSING" });
    await expectCode(withStructuredPdf(harness.inputPath, options(harness, async () => { throw failure; }), async () => {}), expected);
  }
});

test("empty and truncated models are unavailable before any expensive process starts", async (t) => {
  const harness = await createHarness(t);
  assert.equal((await getStructuredPdfAvailability(harness)).enabled, true);
  await fsp.writeFile(path.join(harness.modelDirectory, "text_detection", "inference.pdiparams"), "");
  const availability = await getStructuredPdfAvailability(harness);
  assert.equal(availability.enabled, false);
  assert.equal(availability.errorCode, "PDF_STRUCTURE_MODEL_MISSING");
  assert.equal(availability.limits.maxTotalPixels, 100000000);
  assert.doesNotMatch(JSON.stringify(availability), /fm-engine-test-/);
  let called = false;
  await expectCode(withStructuredPdf(harness.inputPath, options(harness, async () => { called = true; }), async () => {}), "PDF_STRUCTURE_MODEL_MISSING");
  assert.equal(called, false);
});

test("an empty engine executable is unavailable", async (t) => {
  const harness = await createHarness(t);
  await fsp.writeFile(harness.enginePath, "");
  assert.equal((await getStructuredPdfAvailability(harness)).errorCode, "PDF_STRUCTURE_ENGINE_MISSING");
});

test("an oversized manifest is rejected before reading it into memory", async (t) => {
  const harness = await createHarness(t);
  let manifestRead = false;
  const boundary = createStructuredPdfBoundary({ fileSystem: {
    ...fsp,
    async lstat(file) {
      const stats = await fsp.lstat(file);
      if (path.basename(file) === "manifest.json") stats.size = 512 * 1024 * 1024 + 1;
      return stats;
    },
    async readFile(file, ...args) {
      if (path.basename(file) === "manifest.json") manifestRead = true;
      return fsp.readFile(file, ...args);
    }
  } });
  await expectCode(boundary(harness.inputPath, options(harness, async (_file, args) => {
    await fsp.writeFile(path.join(args[4], "manifest.json"), "{}");
  }), async () => {}), "PDF_STRUCTURE_RESOURCE_LIMIT");
  assert.equal(manifestRead, false);
});

test("model-map escapes and missing inference graphs are rejected", async (t) => {
  const harness = await createHarness(t);
  await fsp.writeFile(path.join(harness.modelDirectory, "model-map.json"), JSON.stringify({ text_detection: "../private" }));
  assert.equal((await getStructuredPdfAvailability(harness)).errorCode, "PDF_STRUCTURE_MODEL_MISSING");
  await fsp.rm(path.join(harness.modelDirectory, "model-map.json"));
  await fsp.rename(path.join(harness.modelDirectory, "text_detection", "inference.json"), path.join(harness.modelDirectory, "text_detection", "inference.pdmodel"));
  assert.equal((await getStructuredPdfAvailability(harness)).enabled, true);
  await fsp.rm(path.join(harness.modelDirectory, "text_detection", "inference.pdmodel"));
  assert.equal((await getStructuredPdfAvailability(harness)).enabled, false);
});

test("501 pages and cumulative raster budget fail before native launch", async (t) => {
  const harness = await createHarness(t);
  for (const [pages, size] of [[501, [10, 10]], [51, [595, 842]]]) {
    const pdf = await require("pdf-lib").PDFDocument.create();
    for (let number = 0; number < pages; number += 1) pdf.addPage(size);
    await fsp.writeFile(harness.inputPath, await pdf.save());
    let called = false;
    await expectCode(withStructuredPdf(harness.inputPath, options(harness, async () => { called = true; }), async () => {}), "PDF_STRUCTURE_RESOURCE_LIMIT");
    assert.equal(called, false);
  }
});

test("production defaults fail closed when no engine is configured", async () => {
  const boundary = createStructuredPdfBoundary({
    defaultEnginePath: "",
    defaultModelDirectory: ""
  });
  await expectCode(boundary("ignored.pdf", {}, async () => {}), "PDF_STRUCTURE_ENGINE_MISSING");
});

for (const method of ["mkdir", "mkdtemp"]) {
  test(`redacts ${method} workspace setup failures`, async (t) => {
    const harness = await createHarness(t);
    const fileSystem = Object.create(fsp);
    fileSystem[method] = async () => { throw new Error("private scratch path"); };
    const boundary = createStructuredPdfBoundary({ fileSystem });
    await expectCode(
      boundary(harness.inputPath, options(harness, async () => {}), async () => {}),
      "PDF_STRUCTURE_PARSE_FAILED"
    );
  });
}

test("rejects symlinked engine and model roots before spawning", async (t) => {
  const harness = await createHarness(t);
  const fileSystem = Object.create(fsp);
  fileSystem.lstat = async (candidate) => {
    const stats = await fsp.lstat(candidate);
    return candidate === harness.enginePath || candidate === harness.modelDirectory
      ? { ...stats, isSymbolicLink: () => true }
      : stats;
  };
  const boundary = createStructuredPdfBoundary({ fileSystem });
  let spawned = false;
  await expectCode(boundary(harness.inputPath, options(harness, () => { spawned = true; }), async () => {}), "PDF_STRUCTURE_ENGINE_MISSING");
  const modelOnlyFileSystem = Object.create(fsp);
  modelOnlyFileSystem.lstat = async (candidate) => {
    const stats = await fsp.lstat(candidate);
    return candidate === harness.modelDirectory
      ? { ...stats, isSymbolicLink: () => true }
      : stats;
  };
  const modelBoundary = createStructuredPdfBoundary({ fileSystem: modelOnlyFileSystem });
  await expectCode(modelBoundary(harness.inputPath, options(harness, () => { spawned = true; }), async () => {}), "PDF_STRUCTURE_MODEL_MISSING");
  assert.equal(spawned, false);
});

test("rejects a missing manifest", async (t) => {
  const harness = await createHarness(t);
  await expectCode(withStructuredPdf(harness.inputPath, options(harness, async () => {}), async () => {}), "PDF_STRUCTURE_PARSE_FAILED");
});

test("rejects malformed manifest JSON", async (t) => {
  const harness = await createHarness(t);
  await expectCode(withStructuredPdf(harness.inputPath, options(harness, async (_file, args) => {
    await fsp.writeFile(path.join(args[4], "manifest.json"), "{private OCR");
  }), async () => {}), "PDF_STRUCTURE_SCHEMA_INVALID");
});

test("maps validator failures to a stable schema error", async (t) => {
  const harness = await createHarness(t);
  const runOptions = options(harness, async (_file, args) => {
    await fsp.writeFile(path.join(args[4], "manifest.json"), JSON.stringify(validManifest()));
  }, () => { throw new Error("private asset path"); });
  await expectCode(withStructuredPdf(harness.inputPath, runOptions, async () => {}), "PDF_STRUCTURE_SCHEMA_INVALID");
});

test("keeps assets alive through the callback then cleans the private directory", async (t) => {
  const harness = await createHarness(t);
  let scratch;
  const runOptions = options(harness, async (_file, args) => {
    scratch = args[4];
    await fsp.writeFile(path.join(scratch, "page-001.png"), "asset");
    await fsp.writeFile(path.join(scratch, "manifest.json"), JSON.stringify(validManifest()));
  });
  await assert.rejects(withStructuredPdf(harness.inputPath, runOptions, async (_manifest, assetRoot) => {
    assert.equal(assetRoot, scratch);
    assert.equal(await fsp.readFile(path.join(assetRoot, "page-001.png"), "utf8"), "asset");
    throw new Error("consumer failed");
  }), /consumer failed/);
  await assert.rejects(fsp.access(scratch));
  assert.deepEqual(await fsp.readdir(harness.runtimeDir), []);
});

test("reports a stable cleanup failure after a successful consumer", async (t) => {
  const harness = await createHarness(t);
  const fileSystem = Object.create(fsp);
  fileSystem.rm = async () => { throw new Error("private scratch path"); };
  const boundary = createStructuredPdfBoundary({ fileSystem });
  await expectCode(boundary(harness.inputPath, options(harness, async (_file, args) => {
    await fsp.writeFile(path.join(args[4], "manifest.json"), JSON.stringify(validManifest()));
  }), async () => "ok"), "PDF_STRUCTURE_PARSE_FAILED");
});

test("preserves a consumer failure when cleanup also fails", async (t) => {
  const harness = await createHarness(t);
  const fileSystem = Object.create(fsp);
  fileSystem.rm = async () => { throw new Error("private scratch path"); };
  const boundary = createStructuredPdfBoundary({ fileSystem });
  const consumerError = new Error("consumer failed");
  await assert.rejects(boundary(harness.inputPath, options(harness, async (_file, args) => {
    await fsp.writeFile(path.join(args[4], "manifest.json"), JSON.stringify(validManifest()));
  }), async () => { throw consumerError; }), (error) => error === consumerError);
});
