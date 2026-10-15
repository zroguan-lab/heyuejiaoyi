import path from "node:path";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { atomicJson } from "../src/research/historical-job-runtime.js";
import { HistoricalDataCatalog } from "../src/research/historical-data-catalog.js";
import {
  loadHistoricalReplayInputs,
  RESEARCH_CURRENT_METADATA,
  resolveHistoricalReplayWindow,
  STRICT_POINT_IN_TIME_METADATA,
} from "../src/research/historical-market-replay.js";
import {
  assessPointInTimeWindowCoverage,
  evaluateV23ParameterStability,
  runHistoricalV23WalkForwardValidation,
  SEALED_HOLDOUT_AUTHORIZATION,
} from "../src/research/v2-3-validation.js";

function integerArgument(name, fallback, { minimum, maximum }) {
  const raw = process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} 必须是${minimum}到${maximum}的整数`);
  }
  return value;
}

function summarize(result) {
  return {
    modelVersion: result.modelVersion,
    strategyFingerprint: result.strategyFingerprint,
    policy: result.policy,
    holdoutFraction: result.holdoutFraction,
    folds: result.folds.map((fold) => ({
      fold: fold.fold,
      train: fold.train,
      validation: fold.validation,
      metrics: fold.result.metrics,
      promotionEligible: fold.result.promotionEligible,
    })),
    dataCoverage: result.dataCoverage,
    validation: result.validation,
    promotionGate: result.promotionGate,
    sealedHoldout: result.sealedHoldout.status === "OPENED"
      ? {
        status: result.sealedHoldout.status,
        start: result.sealedHoldout.start,
        end: result.sealedHoldout.end,
        decisionPointCount: result.sealedHoldout.decisionPointCount,
        strategyFingerprint: result.sealedHoldout.strategyFingerprint,
        metrics: result.sealedHoldout.result.metrics,
        promotionEligible: result.sealedHoldout.result.promotionEligible,
      }
      : result.sealedHoldout,
  };
}

function neighborConfig(config, offset) {
  const copy = structuredClone(config);
  copy.shadowV2.explorationMinimumScore = Math.max(0, Math.min(100, Number(copy.shadowV2.explorationMinimumScore) + offset));
  copy.shadowV2.preMoveHardMinimumExplosionScore = Math.max(0, Math.min(100, Number(copy.shadowV2.preMoveHardMinimumExplosionScore) + offset));
  copy.shadowV2.preMoveHardMinimumDirectionScore = Math.max(0, Math.min(100, Number(copy.shadowV2.preMoveHardMinimumDirectionScore) + offset));
  return copy;
}

async function cli() {
  loadDotEnv();
  const config = loadConfig();
  const outputPath = path.resolve(
    process.cwd(),
    process.argv.find((item) => item.startsWith("--output="))?.split("=")[1]
      ?? "research-data/v2-3-validation-latest.json",
  );
  const points = integerArgument("points", 288, { minimum: 20, maximum: 2_016 });
  const folds = integerArgument("folds", 4, { minimum: 1, maximum: 10 });
  const allowCurrent = process.argv.includes("--research-only-current-metadata");
  const runStability = process.argv.includes("--stability");
  const holdoutArgument = process.argv.find((item) => item.startsWith("--open-holdout="))?.split("=")[1] ?? null;
  const catalog = new HistoricalDataCatalog({
    root: path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data"),
  });
  const stepMs = Number(config.marketRadar.refreshMinutes) * 60_000;
  const replayWindow = await resolveHistoricalReplayWindow({ catalog, decisionPoints: points, stepMs, config });
  const inputs = await loadHistoricalReplayInputs({
    catalog,
    symbols: replayWindow.symbols,
    startTime: replayWindow.loadStartTime,
    endTime: replayWindow.loadEndTime,
  });
  const endTime = replayWindow.decisionEndTime;
  const decisionTimes = Array.from({ length: points }, (_, index) => endTime - (points - index - 1) * stepMs);
  const replayOptions = {
    ...inputs,
    metadataPolicy: allowCurrent ? RESEARCH_CURRENT_METADATA : STRICT_POINT_IN_TIME_METADATA,
  };
  let pointInTimeCoverage = null;
  if (!allowCurrent) {
    pointInTimeCoverage = assessPointInTimeWindowCoverage({
      decisionTimes,
      contractRecords: inputs.contractRecords,
      marketCoverageSnapshots: inputs.marketCoverageSnapshots,
      config,
    });
    if (!pointInTimeCoverage.ready) {
      const output = {
        status: "BLOCKED",
        blocker: "POINT_IN_TIME_FACT_COVERAGE_INCOMPLETE",
        period: {
          start: new Date(decisionTimes[0]).toISOString(),
          end: new Date(endTime).toISOString(),
          decisionPoints: points,
          symbols: inputs.symbols.length,
        },
        pointInTimeCoverage,
        note: "分钟K线可以回填，但历史榜单、盘口和合约快照不能倒填；需要继续按时采集真实快照后再运行正式M5。",
      };
      await atomicJson(outputPath, output);
      console.log(JSON.stringify(output, null, 2));
      return;
    }
  }
  const run = (variantConfig) => runHistoricalV23WalkForwardValidation({
    ...replayOptions,
    decisionTimes,
    config: variantConfig,
    validationOptions: { folds, holdoutFraction: 0.2, minimumTrainFraction: 0.4 },
    openSealedHoldout: holdoutArgument !== null,
    holdoutAuthorization: holdoutArgument,
  });
  const result = run(config);
  const output = {
    period: {
      start: new Date(decisionTimes[0]).toISOString(),
      end: new Date(endTime).toISOString(),
      decisionPoints: points,
      symbols: inputs.symbols,
    },
    pointInTimeCoverage,
    ...summarize(result),
  };
  if (runStability) {
    const variants = [
      { label: "threshold_minus_5", config: neighborConfig(config, -5) },
      { label: "baseline", config },
      { label: "threshold_plus_5", config: neighborConfig(config, 5) },
    ].map((variant) => ({ label: variant.label, result: variant.label === "baseline" ? result : run(variant.config) }));
    output.parameterStability = evaluateV23ParameterStability(variants);
  }
  await atomicJson(outputPath, output);
  console.log(JSON.stringify(output, null, 2));
}

cli().catch((error) => {
  if (error?.message === "M5_OPEN_HOLDOUT_REQUIRES_EXPLICIT_AUTHORIZATION") {
    console.error(`打开封存样本必须显式使用 --open-holdout=${SEALED_HOLDOUT_AUTHORIZATION}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
