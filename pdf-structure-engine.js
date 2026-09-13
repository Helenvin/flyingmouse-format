const childProcess = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const { RUNTIME_DIR, DOCSTRUCTURE_ENGINE_PATH, DOCSTRUCTURE_MODEL_DIR } = require("./config");
const { structureError, validateStructureManifest } = require("./pdf-structure-contract");
const { loadPdfjs } = require("./pdfjs");
const logger = require("./logger");
const ENGINE_PROFILE = require("./package.json").engineProfile;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const execFileAsync = promisify(childProcess.execFile);
// The native engine rasterizes at 144 DPI. Keep these limits aligned with
// tools/docstructure-engine/flyingmouse_docstructure/normalize.py.
const STRUCTURED_PDF_LIMITS = Object.freeze({
  maxPages: 500, maxPagePixels: 50000000, maxTotalPixels: 100000000,
  maxDimension: 16384, maxOutputBytes: 512 * 1024 * 1024,
  maxManifestBytes: 512 * 1024 * 1024, renderScale: 2
});
const REQUIRED_MODELS = Object.freeze([
  "layout_detection", "doc_orientation_classification", "doc_unwarping",
  "text_detection", "text_recognition", "table_classification",
  "wired_table_structure", "wireless_table_structure", "wired_table_cells",
  "wireless_table_cells", "seal_text_detection"
]);

const ERROR_MESSAGES = Object.freeze({
  PDF_STRUCTURE_ENGINE_MISSING: { zhCN: "PDF 结构化转换引擎不可用。", enUS: "The structured PDF conversion engine is unavailable." },
  PDF_STRUCTURE_MODEL_MISSING: { zhCN: "PDF 结构识别模型缺失或不完整，请修复或重新安装软件。", enUS: "The PDF structure models are missing or incomplete. Repair or reinstall the app." },
  PDF_STRUCTURE_RESOURCE_LIMIT: { zhCN: "PDF 超出结构识别引擎的资源限制（最多 500 页、单页 5000 万像素、总计 1 亿像素，按 144 DPI 计算），请拆分文件或减小页面尺寸后重试。", enUS: "The PDF exceeds the structure engine budget (500 pages, 50 megapixels per page, 100 megapixels total at 144 DPI). Split the file or reduce page dimensions." },
  PDF_STRUCTURE_PARSE_FAILED: { zhCN: "PDF 结构识别失败。", enUS: "PDF structure recognition failed." },
  PDF_STRUCTURE_SCHEMA_INVALID: { zhCN: "PDF 结构识别结果无效。", enUS: "The PDF structure result is invalid." }
});

function stableError(code, engineProfile = ENGINE_PROFILE) {
  if (code === "PDF_STRUCTURE_ENGINE_MISSING" && engineProfile === "lite") {
    return structureError(code,
      "轻量版未包含高级扫描表格识别引擎。扫描表格转 Excel 或精细版式 Word 需要安装完整版；普通 OCR 文字转换仍可使用。",
      "The Lite edition does not include the advanced scanned-table engine. Install the Full edition for scanned tables to Excel or detailed Word layouts; basic OCR text conversion remains available.");
  }
  const messages = ERROR_MESSAGES[code];
  return structureError(code, messages.zhCN, messages.enUS);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function isTrustedEntry(fileSystem, candidate, expectedKind) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    const stats = await fileSystem.lstat(candidate);
    if (stats.isSymbolicLink()) return false;
    if (expectedKind === "file" ? !stats.isFile() : !stats.isDirectory()) return false;
    if (expectedKind === "file" && stats.size === 0) return false;
    const real = await fileSystem.realpath(candidate);
    // macOS 的 /var、/tmp 是 /private/* 系统符号链接（/var/folders → /private/var/folders），
    // realpath 后前缀会变——不能与 candidate 逐字符比较；改为校验 realpath 结果自洽
    // （二次 realpath 稳定），防止符号链接链重定向攻击。
    const stable = await fileSystem.realpath(real);
    return comparablePath(stable) === comparablePath(real);
  } catch {
    return false;
  }
}

function effectiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), DEFAULT_TIMEOUT_MS);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative);
}

async function validateModelFiles(fileSystem, modelDirectory) {
  if (!await isTrustedEntry(fileSystem, modelDirectory, "directory")) return false;
  try {
    const root = await fileSystem.realpath(modelDirectory);
    let mapping = {};
    const mapPath = path.join(modelDirectory, "model-map.json");
    try {
      const mapStats = await fileSystem.lstat(mapPath);
      if (mapStats.isSymbolicLink() || !mapStats.isFile() || mapStats.size > 65536) return false;
      mapping = JSON.parse(await fileSystem.readFile(mapPath, "utf8"));
      if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) return false;
    } catch (error) { if (error.code !== "ENOENT") return false; }
    for (const name of REQUIRED_MODELS) {
      const raw = Object.hasOwn(mapping, name) ? mapping[name] : name;
      if (typeof raw !== "string" || !raw || /[:\0]/u.test(raw)
        || path.isAbsolute(raw) || raw.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..")) return false;
      const directory = path.join(modelDirectory, ...raw.replaceAll("\\", "/").split("/"));
      if (!await isTrustedEntry(fileSystem, directory, "directory")
        || !contained(root, await fileSystem.realpath(directory))) return false;
      for (const alternatives of [["inference.json", "inference.pdmodel"], ["inference.pdiparams"], ["inference.yml"]]) {
        let found = false;
        for (const filename of alternatives) {
          const candidate = path.join(directory, filename);
          if (await isTrustedEntry(fileSystem, candidate, "file")
            && contained(root, await fileSystem.realpath(candidate))
            && (await fileSystem.stat(candidate)).size > 0) { found = true; break; }
        }
        if (!found) return false;
      }
    }
    return true;
  } catch { return false; }
}

async function getStructuredPdfAvailability(options = {}) {
  const fileSystem = options.fileSystem || fsp;
  const enginePath = options.enginePath ?? DOCSTRUCTURE_ENGINE_PATH;
  const modelDirectory = options.modelDirectory ?? DOCSTRUCTURE_MODEL_DIR;
  const engineProfile = options.engineProfile ?? ENGINE_PROFILE;
  let errorCode;
  if (!await isTrustedEntry(fileSystem, enginePath, "file")) errorCode = "PDF_STRUCTURE_ENGINE_MISSING";
  else if (!await validateModelFiles(fileSystem, modelDirectory)) errorCode = "PDF_STRUCTURE_MODEL_MISSING";
  return { enabled: !errorCode, ...(errorCode ? { errorCode } : {}),
    ...(engineProfile === "lite" ? { profile: "lite" } : {}),
    modelValidation: "required-files", limits: STRUCTURED_PDF_LIMITS };
}

async function preflightStructuredPdf(inputPath, options = {}) {
  const fileSystem = options.fileSystem || fsp;
  let loading;
  try {
    const pdfjs = await (options.loadPdfjs || loadPdfjs)();
    loading = pdfjs.getDocument({ data: new Uint8Array(await fileSystem.readFile(inputPath)),
      isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const document = await loading.promise;
    if (document.numPages < 1) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    if (document.numPages > STRUCTURED_PDF_LIMITS.maxPages) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
    let totalPixels = 0;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: STRUCTURED_PDF_LIMITS.renderScale });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      page.cleanup();
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw stableError("PDF_STRUCTURE_PARSE_FAILED");
      }
      totalPixels += width * height;
      if (width > STRUCTURED_PDF_LIMITS.maxDimension || height > STRUCTURED_PDF_LIMITS.maxDimension
        || width * height > STRUCTURED_PDF_LIMITS.maxPagePixels || totalPixels > STRUCTURED_PDF_LIMITS.maxTotalPixels) {
        throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
      }
    }
    return { pageCount: document.numPages, totalPixels };
  } catch (error) {
    if (error?.code === "PDF_STRUCTURE_RESOURCE_LIMIT") throw error;
    throw stableError("PDF_STRUCTURE_PARSE_FAILED");
  } finally {
    if (loading) await loading.destroy();
  }
}

function createStructuredPdfBoundary(dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fsp;
  const defaultExecFile = dependencies.execFile || execFileAsync;
  const defaultEnginePath = dependencies.defaultEnginePath ?? DOCSTRUCTURE_ENGINE_PATH;
  const defaultModelDirectory = dependencies.defaultModelDirectory ?? DOCSTRUCTURE_MODEL_DIR;
  const defaultRuntimeDir = dependencies.defaultRuntimeDir ?? RUNTIME_DIR;

  async function runAndLoadManifest(inputPath, temporaryDirectory, options) {
    const runner = options.execFile || defaultExecFile;
    const args = ["parse", "--input", inputPath, "--output", temporaryDirectory,
      "--models", options.modelDirectory, "--language", "ch"];

    try {
      // Task 8's engine is contractually single-process and must not spawn descendants.
      // execFile owns and times out only this direct child; no shell or process-tree termination is used.
      await runner(options.enginePath, args, {
        shell: false,
        timeout: effectiveTimeout(options.timeoutMs),
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        windowsHide: true
      });
    } catch (cause) {
      // 引擎崩溃/超时以前被压成一句无信息量的失败文案（2026-09-07 实测 docstructure
      // 引擎对无文字层 PDF 偶发 segfault exit 139，重跑又能成功）。保留折叠语义
      // （不透传 stderr 给界面），但把退出码/信号写进 debug.log 供诊断，并按
      // 超时 vs 崩溃给出可区分的用户文案。超时=SIGTERM/SIGKILL 且 ETIMEDOUT；
      // 崩溃=SIGSEGV 等其他信号（killed 标志两种都可能为 true，不作判据）。
      const exitCode = cause?.code;
      const timedOut = cause?.code === "ETIMEDOUT"
        || (cause?.signal === "SIGTERM" || cause?.signal === "SIGKILL");
      logger.warn(`docstructure engine failed: exit=${String(exitCode)} signal=${String(cause?.signal)}`);
      // Numeric exit codes are the private native CLI protocol. Never infer them
      // by searching stderr, which may contain source text or arbitrary messages.
      const nativeCode = { 20: "PDF_STRUCTURE_MODEL_MISSING", 22: "PDF_STRUCTURE_SCHEMA_INVALID",
        23: "PDF_STRUCTURE_RESOURCE_LIMIT" }[exitCode];
      if (!timedOut && Number.isInteger(exitCode) && nativeCode) throw stableError(nativeCode);
      if (cause?.code === "ENOENT" || cause?.code === "EACCES" || cause?.code === "ENOEXEC") {
        throw stableError("PDF_STRUCTURE_ENGINE_MISSING");
      }
      if (!timedOut && exitCode === 21) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
      throw structureError(
        "PDF_STRUCTURE_PARSE_FAILED",
        timedOut
          ? "PDF 结构识别超时，请重试或拆分成较小的文件。"
          : "PDF 结构识别引擎意外退出，请重试转换（再次失败请重新生成该 PDF 或改用「PDF 转文本/Word（OCR）」）。",
        timedOut
          ? "PDF structure recognition timed out. Retry or split the file."
          : "The PDF structure engine exited unexpectedly. Retry the conversion."
      );
    }

    let serialized;
    try {
      const manifestPath = path.join(temporaryDirectory, "manifest.json");
      const manifestStats = await fileSystem.lstat(manifestPath);
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
      if (manifestStats.size > STRUCTURED_PDF_LIMITS.maxManifestBytes) throw stableError("PDF_STRUCTURE_RESOURCE_LIMIT");
      serialized = await fileSystem.readFile(manifestPath, "utf8");
    } catch (error) {
      if (error?.code === "PDF_STRUCTURE_RESOURCE_LIMIT" || error?.code === "PDF_STRUCTURE_SCHEMA_INVALID") throw error;
      throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    }

    try {
      const manifest = JSON.parse(serialized);
      return (options.validateManifest || validateStructureManifest)(manifest, temporaryDirectory);
    } catch (error) {
      if (error?.code === "PDF_TABLE_OCR_LOW_QUALITY") throw error;
      throw stableError("PDF_STRUCTURE_SCHEMA_INVALID");
    }
  }

  return async function structuredPdfBoundary(inputPath, options = {}, consume) {
    if (typeof consume !== "function") throw new TypeError("consume must be a function");

    const enginePath = options.enginePath || defaultEnginePath;
    const modelDirectory = options.modelDirectory || defaultModelDirectory;
    const runtimeDir = options.runtimeDir || defaultRuntimeDir;
    const availability = await getStructuredPdfAvailability({ fileSystem, enginePath, modelDirectory,
      engineProfile: options.engineProfile });
    if (!availability.enabled) throw stableError(availability.errorCode, options.engineProfile);
    await (dependencies.preflightPdf || preflightStructuredPdf)(inputPath, { fileSystem });

    let temporaryDirectory;
    try {
      await fileSystem.mkdir(runtimeDir, { recursive: true });
      temporaryDirectory = await fileSystem.mkdtemp(path.join(runtimeDir, "fm-pdf-structure-"));
    } catch {
      throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    }

    let result;
    let operationError;
    try {
      const manifest = await runAndLoadManifest(inputPath, temporaryDirectory, { ...options, enginePath, modelDirectory });
      result = await consume(manifest, temporaryDirectory);
    } catch (error) {
      operationError = error;
    }

    let cleanupFailed = false;
    try {
      await fileSystem.rm(temporaryDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }

    if (operationError) throw operationError;
    if (cleanupFailed) throw stableError("PDF_STRUCTURE_PARSE_FAILED");
    return result;
  };
}

const withStructuredPdf = createStructuredPdfBoundary();

module.exports = { DEFAULT_MAX_BUFFER_BYTES, DEFAULT_TIMEOUT_MS, REQUIRED_MODELS,
  STRUCTURED_PDF_LIMITS, getStructuredPdfAvailability, preflightStructuredPdf,
  createStructuredPdfBoundary, withStructuredPdf };
