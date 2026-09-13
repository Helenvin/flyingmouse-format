const { parentPort, workerData } = require("node:worker_threads");
const { prepareWritableEngineBundle } = require("./store-engine-cache");

try {
  const result = prepareWritableEngineBundle({
    ...workerData,
    log: (message, error) => parentPort.postMessage({ type: "log", message,
      error: error ? String(error.message || error) : undefined })
  });
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({ type: "failure", reason: String(error.message || error) });
}
