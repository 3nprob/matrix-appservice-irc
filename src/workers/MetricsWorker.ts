import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { createServer } from "http";
import { Registry, Gauge } from "prom-client";
import getLog from "../logging";
const METRICS_DUMP_TIMEOUT_MS = 20000;

function writeLog(level: string, msg: string) {
    return parentPort?.postMessage(`log:${level}:${msg}`);
}

function workerThread() {
    let lastDumpTs = Date.now();

    const registry = new Registry();
    const intervalCounter = new Gauge({
        name: "metrics_worker_interval",
        help: "Interval time for metrics being reported to the metrics worker process",
        registers: [registry]
    });

    if (!parentPort) {
        throw Error("Missing parentPort");
    }

    createServer((req, res) => {
        res.setHeader("Content-Type", "text/plain");
        if (!req.url || req.url !== "/metrics" || req.method !== "GET") {
            res.statusCode = 404;
            res.write('Path or method not known');
            res.end();
            return;
        }
        writeLog("debug", "Request for /metrics");
        const timeout = setTimeout(() => {
            intervalCounter.inc(METRICS_DUMP_TIMEOUT_MS);
            res.statusCode = 200;
            res.write(`${registry.metrics()}`);
            res.end();
        }, METRICS_DUMP_TIMEOUT_MS)

        parentPort?.once("message", (msg) => {
            clearTimeout(timeout);
            const time = Date.now();
            intervalCounter.set(time - lastDumpTs);
            lastDumpTs = time;
            const dump = msg.substr('metricsdump:'.length);
            res.statusCode = 200;
            res.write(`${dump}\n${registry.metrics()}`);
            res.end();
        });

        parentPort?.postMessage("metricsdump");
    }).listen(workerData.port, workerData.hostname, 1);
}

export function spawnMetricsWorker(port: number, hostname = "127.0.0.1", onMetricsRequested: () => string) {
    const worker = new Worker(__filename, { workerData: { port, hostname } });
    const workerLogger = getLog("MetricsWorker");
    worker.on("message", (msg) => {
        if (msg === "metricsdump") {
            worker.postMessage("metricsdump:" + onMetricsRequested());
        }
        else if (msg.startsWith("log")) {
            const [, logLevel, logMsg] = msg.split(":");
            workerLogger.log(logLevel, logMsg, { loggerName: "MetricsWorker" });
        }
    })
    return worker;
}

if (!isMainThread) {
    workerThread();
}
