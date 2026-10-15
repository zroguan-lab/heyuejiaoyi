import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectExecutionRuns } from "../src/execution/execution-run-projection.js";
import {
  PERFORMANCE_EPOCH_METADATA_KEY,
  PERFORMANCE_EPOCH_HISTORY_METADATA_KEY,
  V2_3_DEMO_STRATEGY_VERSION,
  V2_EXECUTION_SOURCE,
} from "../src/execution/execution-strategy-source.js";
import { buildV23DemoBaseline, renderV23DemoBaselineMarkdown } from "../src/research/v2-3-demo-baseline.js";

const FROZEN_BASELINE_AS_OF = 1791355259075;

function argument(name, fallback = null) {
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function parseTimestamp(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`无法解析时间: ${value}`);
  return parsed;
}

async function atomicText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

function metadata(db, key) {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

async function main() {
  const databasePath = path.resolve(process.cwd(), argument("database", process.env.RESEARCH_DATABASE_PATH ?? "data/research.sqlite"));
  const jsonPath = path.resolve(process.cwd(), argument("json", "research-data/v2-3-demo-baseline-114.json"));
  const markdownPath = path.resolve(process.cwd(), argument("markdown", "docs/V2_3_DEMO_PROFITABILITY_BASELINE.md"));
  const expectedCount = Number(argument("expected-count", 114));
  if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error("--expected-count 必须为正整数");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const activeEpoch = metadata(db, PERFORMANCE_EPOCH_METADATA_KEY);
    const epochHistory = metadata(db, PERFORMANCE_EPOCH_HISTORY_METADATA_KEY);
    const epoch = [activeEpoch, ...(Array.isArray(epochHistory) ? epochHistory : [])]
      .filter((item) => item?.strategySource === V2_EXECUTION_SOURCE && item?.strategyVersion === V2_3_DEMO_STRATEGY_VERSION)
      .sort((left, right) => Number(right.startedAt) - Number(left.startedAt))[0] ?? null;
    if (!epoch) throw new Error("找不到已冻结的V2.3 Demo绩效纪元，拒绝生成错误基线");
    const strategySnapshot = metadata(db, "v2_3_strategy_snapshot");
    const runs = db.prepare("SELECT payload FROM execution_runs ORDER BY created_at").all().map((row) => JSON.parse(row.payload));
    const trades = projectExecutionRuns(runs);
    const asOf = parseTimestamp(argument("as-of"), FROZEN_BASELINE_AS_OF);
    const report = buildV23DemoBaseline({
      trades,
      epoch,
      strategyFingerprint: strategySnapshot?.fingerprint ?? null,
      asOf,
      generatedAt: Date.now(),
    });
    if (report.sample.selectedTradeCount !== expectedCount) {
      throw new Error(`基线样本数量漂移: 期望${expectedCount}笔，实际${report.sample.selectedTradeCount}笔；请显式检查截止时间`);
    }
    await atomicText(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await atomicText(markdownPath, renderV23DemoBaselineMarkdown(report));
    console.log(JSON.stringify({
      status: "BASELINE_FROZEN",
      jsonPath,
      markdownPath,
      sampleCount: report.sample.selectedTradeCount,
      sampleHash: report.sample.sampleHash,
      asOf: report.asOfIso,
      profitabilityGate: report.profitabilityGate,
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
