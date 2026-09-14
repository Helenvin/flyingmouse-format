const { execFile } = require("node:child_process");
const path = require("node:path");

// soffice.com owns a soffice.bin child. execFile's built-in timeout kills only
// the launcher on Windows, leaving native error dialogs and profiles locked.
function defaultExecutor(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let completed = false;
    let timer;
    let cleanup = Promise.resolve();
    let treeTerminated = false;
    let cleanupError;
    const timeoutFailure = (stdout = "", stderr = "", signal = null) => Object.assign(
      new Error("LibreOffice process exceeded its deadline"), {
        code: "ETIMEDOUT", timedOut: true, treeTerminated, cleanupError,
        childPid: child.pid, stdout, stderr, signal
      });
    const child = execFile(command, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      detached: process.platform !== "win32"
    }, (error, stdout, stderr) => {
      completed = true;
      clearTimeout(timer);
      void cleanup.then(() => {
        if (timedOut) {
          reject(timeoutFailure(stdout, stderr, error?.signal || null));
        } else if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else resolve({ stdout, stderr });
      });
    });
    const timeout = options.timeout;
    if (Number.isFinite(timeout) && timeout > 0) timer = setTimeout(() => {
      if (completed || !child.pid) return;
      timedOut = true;
      cleanup = new Promise((done) => {
        if (process.platform === "win32") {
          const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
          execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, (error) => {
            treeTerminated = !error;
            if (error) {
              cleanupError = error.code || error.message;
              // At least close the exact launcher we created if Windows refuses
              // tree termination. Keep that failure explicit in diagnostics.
              if (!completed) child.kill();
              // Descendants can retain stdout handles even after their parent
              // dies. Do not leave the conversion promise pending in that case.
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
              reject(timeoutFailure());
            }
            done();
          });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); treeTerminated = true; }
          catch (error) { cleanupError = error.code || error.message; if (!completed) child.kill("SIGKILL"); }
          done();
        }
      });
    }, timeout);
  });
}

module.exports = { defaultExecutor };
