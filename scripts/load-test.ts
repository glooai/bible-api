import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

loadEnvFromLocalFile();

type LoadTestOptions = {
  totalRequests: number;
  concurrency: number;
  translations: string[];
  limits: number[];
  terms: string[];
  baseUrl: string;
  apiKey: string;
};

type WorkerData = {
  workerId: number;
  iterations: number;
  baseUrl: string;
  apiKey: string;
  terms: string[];
  translations: string[];
  limits: number[];
  maxErrors: number;
};

type WorkerResult = {
  workerId: number;
  latencies: number[];
  successes: number;
  failures: number;
  errors: string[];
};

const DEFAULT_TOTAL_REQUESTS = 200;
const DEFAULT_LIMIT = 5;
const DEFAULT_TRANSLATION = "NLT";
const DEFAULT_TERMS = ["love", "hope", "faith", "grace", "peace"];
const DEFAULT_AGGRESSIVE_TRANSLATIONS = ["KJV", "ESV", "NIV", "NASB", "AMP"];
const DEFAULT_AGGRESSIVE_LIMITS = [DEFAULT_LIMIT, 10, 25, 50];
const MAX_ERRORS_REPORTED = 20;

if (!isMainThread) {
  runWorker(workerData as WorkerData)
    .then((result) => {
      parentPort?.postMessage({ type: "result", result });
    })
    .catch((error) => {
      parentPort?.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
} else {
  (async () => {
    try {
      const options = parseArguments(process.argv.slice(2));
      validateEnvironment(options);

      const report = await executeLoadTest(options);
      const reportPath = path.resolve(process.cwd(), "scripts", "load-test.md");
      await fs.promises.writeFile(reportPath, report, "utf8");

      console.log(report);
      console.log(
        `\nReport saved to ${path.relative(process.cwd(), reportPath)}`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  })();
}

async function executeLoadTest(options: LoadTestOptions): Promise<string> {
  const startTime = performance.now();

  const { results: workerResults, workersSpawned } = await runWorkers(options);

  const endTime = performance.now();
  const totalDurationMs = endTime - startTime;

  const latencies: number[] = [];
  let successes = 0;
  let failures = 0;
  const aggregatedErrors: string[] = [];

  for (const result of workerResults) {
    successes += result.successes;
    failures += result.failures;
    for (const latency of result.latencies) {
      latencies.push(latency);
    }
    for (const error of result.errors) {
      if (aggregatedErrors.length < MAX_ERRORS_REPORTED) {
        aggregatedErrors.push(`[Worker ${result.workerId}] ${error}`);
      }
    }
  }

  const observedRequests = successes + failures;
  const latenciesSummary = summarizeLatencies(latencies);
  const successRate =
    observedRequests === 0 ? 0 : (successes / observedRequests) * 100;
  const throughput =
    totalDurationMs > 0 ? observedRequests / (totalDurationMs / 1000) : 0;

  return buildReport({
    options,
    actualConcurrency: workersSpawned,
    totalDurationMs,
    observedRequests,
    successes,
    failures,
    successRate,
    throughput,
    latenciesSummary,
    errors: aggregatedErrors,
    latenciesCount: latencies.length,
  });
}

async function runWorkers(options: LoadTestOptions): Promise<{
  results: WorkerResult[];
  workersSpawned: number;
}> {
  const workerCount = Math.min(options.concurrency, options.totalRequests);
  if (workerCount <= 0) {
    throw new Error(
      "Concurrency and total requests must be greater than zero.",
    );
  }

  const iterationsPerWorker = Math.floor(options.totalRequests / workerCount);
  let remainder = options.totalRequests % workerCount;
  const maxErrorsPerWorker = Math.max(
    1,
    Math.floor(MAX_ERRORS_REPORTED / workerCount),
  );

  const workerPromises: Array<Promise<WorkerResult>> = [];

  for (let workerId = 0; workerId < workerCount; workerId += 1) {
    const iterations = iterationsPerWorker + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);

    if (iterations === 0) {
      continue;
    }

    const data: WorkerData = {
      workerId,
      iterations,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      terms: options.terms,
      translations: options.translations,
      limits: options.limits,
      maxErrors: maxErrorsPerWorker,
    };

    workerPromises.push(spawnWorker(data));
  }

  const results = await Promise.all(workerPromises);
  return { results, workersSpawned: results.length };
}

function spawnWorker(data: WorkerData): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: data,
      execArgv: process.execArgv,
    });

    const cleanup = () => {
      worker.removeAllListeners("message");
      worker.removeAllListeners("error");
      worker.removeAllListeners("exit");
    };

    worker.once("message", (message) => {
      if (message?.type === "result") {
        cleanup();
        resolve(message.result as WorkerResult);
      } else if (message?.type === "error") {
        cleanup();
        reject(new Error(String(message.message)));
      }
    });

    worker.once("error", (error) => {
      cleanup();
      reject(error);
    });

    worker.once("exit", (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`Worker ${data.workerId} exited with code ${code}`));
      }
    });
  });
}

async function runWorker(data: WorkerData): Promise<WorkerResult> {
  const latencies: number[] = [];
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  for (let index = 0; index < data.iterations; index += 1) {
    const term =
      data.terms[Math.floor(Math.random() * data.terms.length)] ?? "love";
    const translation =
      data.translations[Math.floor(Math.random() * data.translations.length)] ??
      DEFAULT_TRANSLATION;
    const limit =
      data.limits[Math.floor(Math.random() * data.limits.length)] ??
      DEFAULT_LIMIT;
    const url = new URL("/api/search", data.baseUrl);
    url.searchParams.set("term", term);
    url.searchParams.set("translation", translation);
    url.searchParams.set("limit", String(limit));

    const requestStart = performance.now();

    try {
      const response = await fetch(url, {
        headers: {
          "x-api-key": data.apiKey,
        },
      });
      const duration = performance.now() - requestStart;
      latencies.push(duration);

      if (!response.ok) {
        failures += 1;
        if (errors.length < data.maxErrors) {
          errors.push(`HTTP ${response.status} ${response.statusText}`);
        }
        continue;
      }

      const payload = (await response.json().catch(() => undefined)) as
        | { results?: unknown }
        | undefined;

      if (!payload || !Array.isArray(payload.results)) {
        failures += 1;
        if (errors.length < data.maxErrors) {
          errors.push("Invalid response payload");
        }
        continue;
      }

      successes += 1;
    } catch (error) {
      const duration = performance.now() - requestStart;
      latencies.push(duration);
      failures += 1;

      if (errors.length < data.maxErrors) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return {
    workerId: data.workerId,
    latencies,
    successes,
    failures,
    errors,
  };
}

function buildReport({
  options,
  actualConcurrency,
  totalDurationMs,
  observedRequests,
  successes,
  failures,
  successRate,
  throughput,
  latenciesSummary,
  errors,
  latenciesCount,
}: {
  options: LoadTestOptions;
  actualConcurrency: number;
  totalDurationMs: number;
  observedRequests: number;
  successes: number;
  failures: number;
  successRate: number;
  throughput: number;
  latenciesSummary: LatencySummary;
  errors: string[];
  latenciesCount: number;
}): string {
  const nf0 = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  });
  const nf2 = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const lines: string[] = [];
  lines.push("# Bible API Load Test Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Configuration");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Base URL | ${options.baseUrl} |`);
  lines.push(`| Total requests | ${nf0.format(options.totalRequests)} |`);
  lines.push(`| Observed requests | ${nf0.format(observedRequests)} |`);
  lines.push(`| Concurrency (workers) | ${nf0.format(actualConcurrency)} |`);
  lines.push(`| Translations | ${options.translations.join(", ")} |`);
  lines.push(`| Limits | ${options.limits.join(", ")} |`);
  lines.push(`| Terms | ${options.terms.join(", ")} |`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Successes | ${nf0.format(successes)} |`);
  lines.push(`| Failures | ${nf0.format(failures)} |`);
  lines.push(`| Success rate | ${nf2.format(successRate)} % |`);
  lines.push(`| Total duration | ${nf2.format(totalDurationMs)} ms |`);
  lines.push(`| Throughput | ${nf2.format(throughput)} req/s |`);
  lines.push("");
  lines.push("## Latency (ms)");
  lines.push("");

  if (latenciesCount === 0) {
    lines.push("No latency data collected.");
  } else {
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Min | ${nf2.format(latenciesSummary.min)} |`);
    lines.push(`| Average | ${nf2.format(latenciesSummary.avg)} |`);
    lines.push(`| p50 | ${nf2.format(latenciesSummary.p50)} |`);
    lines.push(`| p90 | ${nf2.format(latenciesSummary.p90)} |`);
    lines.push(`| p95 | ${nf2.format(latenciesSummary.p95)} |`);
    lines.push(`| p99 | ${nf2.format(latenciesSummary.p99)} |`);
    lines.push(`| Max | ${nf2.format(latenciesSummary.max)} |`);
  }

  lines.push("");
  lines.push("## Errors");
  lines.push("");

  if (errors.length === 0) {
    lines.push("No errors recorded.");
  } else {
    for (const error of errors) {
      lines.push(`- ${error}`);
    }
    if (errors.length >= MAX_ERRORS_REPORTED) {
      lines.push("");
      lines.push(`_Showing first ${MAX_ERRORS_REPORTED} errors._`);
    }
  }

  return lines.join("\n");
}

type LatencySummary = {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
};

function summarizeLatencies(latencies: number[]): LatencySummary {
  if (latencies.length === 0) {
    return {
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
    };
  }

  const sorted = [...latencies].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function percentile(sortedValues: number[], percentileRank: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(percentileRank * sortedValues.length) - 1,
  );
  return sortedValues[Math.max(0, index)];
}

function parseArguments(argv: string[]): LoadTestOptions {
  let totalRequests = DEFAULT_TOTAL_REQUESTS;
  let concurrency = Math.max(1, Math.min(os.cpus().length, 10));
  const translationSet = new Set<string>();
  const limitSet = new Set<number>();
  const terms = new Set<string>();

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--requests" || arg === "-r") {
      if (!next) {
        throw new Error("Missing value for --requests flag.");
      }
      totalRequests = parsePositiveInteger(next, "requests");
      index += 2;
      continue;
    }

    if (arg === "--concurrency" || arg === "-c") {
      if (!next) {
        throw new Error("Missing value for --concurrency flag.");
      }
      concurrency = parsePositiveInteger(next, "concurrency");
      index += 2;
      continue;
    }

    if (arg === "--translation" || arg === "-t") {
      if (!next) {
        throw new Error("Missing value for --translation flag.");
      }
      translationSet.add(next.toUpperCase());
      index += 2;
      continue;
    }

    if (arg === "--limit" || arg === "-l") {
      if (!next) {
        throw new Error("Missing value for --limit flag.");
      }
      limitSet.add(parsePositiveInteger(next, "limit"));
      index += 2;
      continue;
    }

    if (arg === "--translations") {
      if (!next) {
        throw new Error("Missing value for --translations flag.");
      }
      next
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean)
        .forEach((value) => translationSet.add(value));
      index += 2;
      continue;
    }

    if (arg === "--limits") {
      if (!next) {
        throw new Error("Missing value for --limits flag.");
      }
      next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((value) =>
          limitSet.add(parsePositiveInteger(value, "limits")),
        );
      index += 2;
      continue;
    }

    if (arg === "--term") {
      if (!next) {
        throw new Error("Missing value for --term flag.");
      }
      terms.add(next.trim());
      index += 2;
      continue;
    }

    if (arg === "--terms") {
      if (!next) {
        throw new Error("Missing value for --terms flag.");
      }
      next
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .forEach((value) => terms.add(value));
      index += 2;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  const termList = terms.size > 0 ? [...terms] : [...DEFAULT_TERMS];

  if (translationSet.size === 0) {
    translationSet.add(DEFAULT_TRANSLATION);
    DEFAULT_AGGRESSIVE_TRANSLATIONS.forEach((value) =>
      translationSet.add(value.toUpperCase()),
    );
  }

  if (limitSet.size === 0) {
    DEFAULT_AGGRESSIVE_LIMITS.forEach((value) => limitSet.add(value));
  }

  const translationList = [...translationSet];
  const limitList = [...limitSet].sort((left, right) => left - right);

  const baseUrl = process.env.BIBLE_API_BASE_URL;
  const apiKey = process.env.API_KEY;

  return {
    totalRequests,
    concurrency,
    translations: translationList,
    limits: limitList,
    terms: termList,
    baseUrl: baseUrl ?? "",
    apiKey: apiKey ?? "",
  };
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function validateEnvironment(options: LoadTestOptions): void {
  if (!options.baseUrl) {
    throw new Error(
      "BIBLE_API_BASE_URL environment variable must be set before running the load test.",
    );
  }

  if (!options.apiKey) {
    throw new Error(
      "API_KEY environment variable must be set before running the load test.",
    );
  }
}

function loadEnvFromLocalFile(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  let content: string;

  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!key) {
      continue;
    }

    let value = line.slice(equalsIndex + 1).trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) {
      value = quoted[2];
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
