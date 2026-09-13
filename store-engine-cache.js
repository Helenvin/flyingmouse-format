// store-engine-cache.js — 商店（MSIX/AppContainer）环境下把只读 resources 里的
// LibreOffice 引擎复制到可写位并证明其可用（0.6.10 P3）。
//
// 0.6.9 旧逻辑的教训（2026-09-10 复核 P3）：接受缓存只看 `soffice.com 存在 +
// .complete 存在`，但 .complete 只证明「复制代码走完」，不证明「引擎能转换文件」：
//   - 缓存里缺关键 DLL/注册表资源 → 代码仍直接使用半套引擎；
//   - 来源包本身残缺但含 soffice.com → 复制完成照样写 .complete，还会清掉本来
//     可用的旧版本缓存。
// 新流程（评审建议原样落地）：
//   复制到 <final>.staging → 按打包期清单校验关键文件（大小，小文件加 sha256）
//   → 用最小 CSV 做一次真实 --convert-to pdf 并验证输出 → rename 发布为可用
//   缓存 → 写 .complete → 回收其余旧缓存目录。
// 任何一步失败都不得发布半成品；清单缺失/损坏的旧包和已有缓存也必须通过
// 本次真实转换。有清单且文件快照完全未变时可复用上次真实转换的验证收据。
// 桌面入口在 worker 中执行本模块，复制、哈希与原生验证均不阻塞窗口。

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { Worker } = require("node:worker_threads");

const MANIFEST_FILE = "engine-integrity.json";
const STAGING_SUFFIX = ".staging";
const RECEIPT_FILE = ".validated.json";
const SOFFICE_RELATIVE = path.join("LibreOfficePortable", "App", "libreoffice", "program", "soffice.com");
// 冒烟转换超时：商店盘冷启 LO + 建 profile 实测可达十几秒，给足余量；超时=不可用。
const SMOKE_TIMEOUT_MS = 90000;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readManifest(bundleDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, MANIFEST_FILE), "utf8"));
    if (!isValidManifest(manifest)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function manifestKey(manifest) {
  if (!isValidManifest(manifest)) return null;
  const files = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) =>
    [name, entry.size, entry.sha256?.toLowerCase() || null]);
  return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function resolveWritableEngineBundle({ bundledBundle, enginesRoot, bundleName }) {
  const key = manifestKey(readManifest(bundledBundle));
  const name = bundleName || `libreoffice-${key || "unverified"}`;
  if (!/^libreoffice(?:-[0-9A-Za-z._-]+)?$/.test(name) || name.includes("..")) {
    throw new Error("Invalid writable engine cache name");
  }
  const destBundle = path.resolve(enginesRoot, name);
  assertCacheChild(enginesRoot, destBundle);
  return { bundleName: name, destBundle, path: path.join(destBundle, SOFFICE_RELATIVE), key };
}

// Every recursive removal/publication remains an immediate child of enginesRoot.
// Reject reparse points so a damaged cache cannot redirect validation/cleanup.
function assertCacheChild(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (path.dirname(resolvedTarget) !== resolvedRoot || resolvedTarget === resolvedRoot) {
    throw new Error("Engine cache path escapes its root");
  }
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("Engine cache root is a link");
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Engine cache path is a link");
}

function removeCacheChild(root, target) {
  assertCacheChild(root, target);
  fs.rmSync(target, { recursive: true, force: true });
}

function bundleSnapshot(bundleDir) {
  const files = [];
  function visit(directory, relative = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && [RECEIPT_FILE, ".complete"].includes(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Engine cache contains a link: ${rel}`);
      if (stat.isDirectory()) visit(fullPath, rel);
      else if (stat.isFile()) {
        // LibreOffice's embedded Python recompiles these after staging is renamed
        // (the bytecode embeds absolute source paths). Normal conversions must
        // not invalidate the complete engine. Only ignore regenerable bytecode;
        // its corresponding .py source and all source-less bytecode stay checked.
        const bytecode = /^(.+)\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.exec(entry.name);
        if (bytecode && path.basename(directory) === "__pycache__") {
          const source = path.join(path.dirname(directory), `${bytecode[1]}.py`);
          if (fs.existsSync(source) && fs.lstatSync(source).isFile()) continue;
        }
        files.push([rel, stat.size, stat.mtimeMs, stat.ctimeMs]);
      }
      else throw new Error(`Unsupported engine cache entry: ${rel}`);
    }
  }
  visit(bundleDir);
  return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function hasValidationReceipt(bundleDir, manifest) {
  const key = manifestKey(manifest);
  if (!key) return false;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(bundleDir, RECEIPT_FILE), "utf8"));
    return receipt.schema === 1 && receipt.validator === "csv-pdf-text-v2" && receipt.key === key
      && receipt.snapshot === bundleSnapshot(bundleDir);
  } catch { return false; }
}

function writeValidationReceipt(bundleDir, manifest) {
  const key = manifestKey(manifest);
  // Legacy packages have no content identity; they must be smoke-tested every run.
  if (!key) return;
  fs.writeFileSync(path.join(bundleDir, RECEIPT_FILE), JSON.stringify({ schema: 1,
    validator: "csv-pdf-text-v2", key, snapshot: bundleSnapshot(bundleDir), validatedAt: new Date().toISOString() }));
}

function prepareWritableEngineBundleAsync(options) {
  const { log = () => {}, ...workerData } = options;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "store-engine-worker.js"), { workerData });
    let settled = false;
    worker.on("message", (message) => {
      if (message.type === "log") log(message.message, message.error ? new Error(message.error) : undefined);
      if (message.type === "result") { settled = true; resolve(message.result); }
      if (message.type === "failure") { settled = true; reject(new Error(message.reason)); }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (!settled) reject(new Error(`Office preparation worker exited without a result (${code})`));
    });
  });
}

function isValidManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || !manifest.files || Array.isArray(manifest.files)
    || typeof manifest.files !== "object" || !Object.keys(manifest.files).length) return false;
  return Object.entries(manifest.files).every(([rel, entry]) => {
    if (!rel || rel.includes("\\") || rel.includes(":") || path.posix.isAbsolute(rel)
      || rel.split("/").some((part) => !part || part === "." || part === "..")) return false;
    return entry && Number.isSafeInteger(entry.size) && entry.size >= 0
      && (!entry.sha256 || /^[a-f0-9]{64}$/i.test(entry.sha256));
  });
}

// 校验 manifest 收录的关键文件（相对 bundle 根）：必须存在、size 一致；
// 带 sha256 的文件再比对哈希。旧清单的大文件只有 size；新清单覆盖全部关键文件。
// 哈希均在 worker 中执行，不占用桌面主线程。
function verifyIntegrity(bundleDir, manifest) {
  if (!isValidManifest(manifest)) return { ok: false, checked: 0, reason: "清单缺失或无有效条目，必须执行实际转换验证" };
  let checked = 0;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const filePath = path.join(bundleDir, ...rel.split("/"));
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      if (typeof entry.size === "number" && stat.size !== entry.size) {
        return { ok: false, reason: `size 不符: ${rel} 实际 ${stat.size} 期望 ${entry.size}` };
      }
      if (entry.sha256 && sha256File(filePath) !== entry.sha256) {
        return { ok: false, reason: `sha256 不符: ${rel}` };
      }
      checked += 1;
    } catch {
      return { ok: false, reason: `关键文件缺失: ${rel}` };
    }
  }
  return { ok: true, checked };
}

// 真实冒烟：最小 CSV → PDF，实际解析一页 PDF 并验证 flyingmouse 和 42 两个单元格。
// 同步实现仅在准备 worker 中运行；主进程先显示窗口。
function defaultSmokeTest(sofficePath, options = {}) {
  const { exec = execFileSync, timeoutMs = SMOKE_TIMEOUT_MS, tmpRoot } = options;
  let workDir = null;
  try {
    workDir = fs.mkdtempSync(path.join(tmpRoot || os.tmpdir(), "fm-engine-smoke-"));
    const inDir = path.join(workDir, "in");
    const outDir = path.join(workDir, "out");
    const profileDir = path.join(workDir, "profile");
    fs.mkdirSync(inDir);
    fs.mkdirSync(outDir);
    fs.mkdirSync(profileDir);
    const csvPath = path.join(inDir, "smoke.csv");
    fs.writeFileSync(csvPath, "name,value\nflyingmouse,42\n", "utf8");
    exec(
      sofficePath,
      [
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--nodefault",
        "--nolockcheck",
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        csvPath
      ],
      { timeout: timeoutMs, windowsHide: true }
    );
    const pdfPath = path.join(outDir, "smoke.pdf");
    if (!fs.existsSync(pdfPath)) return { ok: false, reason: "冒烟转换无输出文件" };
    // Header checks accept truncated and blank PDFs. Parse the complete file and
    // verify the actual CSV cells in a separate bounded process.
    execFileSync(process.execPath, [path.join(__dirname, "engine-smoke-validator.js"), pdfPath], {
      timeout: Math.min(timeoutMs, 30000), windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `冒烟转换失败: ${error instanceof Error ? error.message : error}` };
  } finally {
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { /* A locked temporary profile must not override the validation result. */ }
    }
  }
}

// 已发布缓存的接受判定：入口 + .complete + （有清单时）关键文件完整性。
// 返回 false = 半套/损坏/过期，一律走重建。
function isPublishedBundleUsable({ destBundle, destSoffice, completeMarker, manifest, smokeTest = defaultSmokeTest, tmpRoot }) {
  if (!fs.existsSync(destSoffice) || !fs.existsSync(completeMarker)) return false;
  if (manifest && !verifyIntegrity(destBundle, manifest).ok) return false;
  if (hasValidationReceipt(destBundle, manifest)) return true;
  // A changed, previously validated cache is rebuilt from the bundled source;
  // CSV smoke alone cannot detect every missing Writer/Impress dependency.
  if (manifest && fs.existsSync(path.join(destBundle, RECEIPT_FILE))) return false;
  // A legacy marker, changed file (including unlisted resources) or missing
  // manifest cannot reuse validation evidence from an earlier launch.
  if (smokeTest(destSoffice, { tmpRoot }).ok !== true) return false;
  writeValidationReceipt(destBundle, manifest);
  return true;
}

// 主流程。所有路径由调用方（electron-main）注入，本模块不依赖 electron，可单测。
// 同步内核由 worker 调用；返回 { path, source, reason? }。
function prepareWritableEngineBundle(options) {
  const {
    bundledBundle,
    bundledSofficePath,
    enginesRoot,
    smokeTest = defaultSmokeTest,
    log = () => {},
    tmpRoot
  } = options;
  const { destBundle, bundleName } = resolveWritableEngineBundle(options);
  const stagingDir = `${destBundle}${STAGING_SUFFIX}`;
  const destSoffice = path.join(destBundle, SOFFICE_RELATIVE);
  const completeMarker = path.join(destBundle, ".complete");
  const stagingSoffice = path.join(stagingDir, "LibreOfficePortable", "App", "libreoffice", "program", "soffice.com");
  // 清单以来源包为准（复制后 staging 里也有同一份，等价）。
  const manifest = readManifest(bundledBundle);

  try {
    if (isPublishedBundleUsable({ destBundle, destSoffice, completeMarker, manifest, smokeTest, tmpRoot })) {
      return { path: destSoffice, source: "cache" };
    }
    // Retain the previous directory until its replacement has passed validation.
    // staging 残留（上次复制中途断电/杀进程）：一并清掉。
    removeCacheChild(enginesRoot, stagingDir);
    fs.mkdirSync(path.dirname(destBundle), { recursive: true });
    log(`Extracting LibreOffice engine to staging: ${stagingDir}`);
    fs.cpSync(bundledBundle, stagingDir, { recursive: true });

    if (!fs.existsSync(stagingSoffice)) {
      // 来源包本身残缺——旧实现在这里才检查，且检查的是最终目录。
      throw new Error("soffice.com missing after engine extraction");
    }
    const integrity = verifyIntegrity(stagingDir, manifest);
    if (manifest && !integrity.ok) {
      throw new Error(`引擎完整性校验失败: ${integrity.reason}`);
    }
    if (integrity.checked) log(`Engine integrity verified: ${integrity.checked} critical files`);
    else log("Engine manifest unavailable; real conversion validation is required");

    const smoke = smokeTest(stagingSoffice, { tmpRoot });
    if (!smoke.ok) {
      throw new Error(`引擎冒烟测试失败: ${smoke.reason || "unknown"}`);
    }
    log("Engine smoke conversion passed");

    fs.writeFileSync(path.join(stagingDir, ".complete"), `${bundleName}\n`, "utf8");
    writeValidationReceipt(stagingDir, manifest);
    // rename 发布：staging→最终目录一次到位，中途不存在「入口在但内容不全」的窗口。
    removeCacheChild(enginesRoot, destBundle);
    assertCacheChild(enginesRoot, stagingDir);
    fs.renameSync(stagingDir, destBundle);

    // 新缓存发布成功后才回收其余旧目录（含仍在用的历史版本；本次 bundle 除外）。
    try {
      for (const name of fs.readdirSync(enginesRoot)) {
        if (name !== bundleName && !name.endsWith(STAGING_SUFFIX) && /^libreoffice(-|$)/.test(name)) {
          removeCacheChild(enginesRoot, path.join(enginesRoot, name));
        }
      }
    } catch {
      // 旧缓存回收失败不影响本次启动（顶多占盘）。
    }
    return { path: destSoffice, source: "published" };
  } catch (error) {
    // staging 整段丢弃即可——最终目录从未被动过，其余版本缓存也未被动过。
    log("LibreOffice writable-engine preparation failed; using bundled path", error);
    try {
      removeCacheChild(enginesRoot, stagingDir);
    } catch {
      // 清理失败只可能来自更底层的 IO 问题，日志已留。
    }
    return { path: bundledSofficePath, source: "bundled", reason: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  MANIFEST_FILE,
  RECEIPT_FILE,
  SMOKE_TIMEOUT_MS,
  defaultSmokeTest,
  isPublishedBundleUsable,
  prepareWritableEngineBundle,
  prepareWritableEngineBundleAsync,
  resolveWritableEngineBundle,
  readManifest,
  verifyIntegrity
};
