import path from "node:path";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { HistoricalDataCatalog } from "../src/research/historical-data-catalog.js";
import {
  loadHistoricalReplayInputs,
  RESEARCH_CURRENT_METADATA,
  runHistoricalV23Point,
  runHistoricalV23Timeline,
  resolveHistoricalReplayWindow,
  STRICT_POINT_IN_TIME_METADATA,
} from "../src/research/historical-market-replay.js";

function summary(result) {
  return {
    decisionTime: result.decisionTime,
    decisionTimeIso: new Date(result.decisionTime).toISOString(),
    promotionEligible: result.promotionEligible,
    reconstruction: result.radar.reconstruction,
    discoverySize: result.radar.discoverySize,
    eligibleSize: result.radar.eligibleSize,
    selectedSymbols: result.radar.selectedSymbols,
    leaders: result.radar.leaders.slice(0, 5),
    laggards: result.radar.laggards.slice(0, 5),
    rankVelocityLeaders: result.radar.rankVelocityLeaders.slice(0, 5),
    marketRegime: result.marketRegime,
    candidateCount: result.candidateCount,
    decisions: result.decisions.map((item) => ({
      adapter: item.adapter,
      symbol: item.decision.symbol,
      status: item.decision.status,
      trend: item.decision.trend,
      candidates: item.decision.candidates.map((candidate) => ({
        id: candidate.id,
        direction: candidate.direction,
        score: candidate.shadowV2?.score,
        tier: candidate.shadowV2?.experimentTier,
        eligible: candidate.shadowV2?.eligible,
        rejectionReasons: candidate.shadowV2?.rejectionReasons,
      })),
    })),
  };
}

async function cli() {
  loadDotEnv();
  const config = loadConfig();
  const catalog = new HistoricalDataCatalog({
    root: path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data"),
  });
  const allowCurrent = process.argv.includes("--research-only-current-metadata");
  const pointsArgument = process.argv.find((item) => item.startsWith("--points="));
  const points = Number(pointsArgument?.split("=")[1] ?? 1);
  if (!Number.isInteger(points) || points < 1 || points > 288) throw new Error("--points 必须是1到288的整数");
  const stepMs = config.marketRadar.refreshMinutes * 60_000;
  const replayWindow = await resolveHistoricalReplayWindow({ catalog, decisionPoints: points, stepMs, config });
  const inputs = await loadHistoricalReplayInputs({
    catalog,
    symbols: replayWindow.symbols,
    startTime: replayWindow.loadStartTime,
    endTime: replayWindow.loadEndTime,
  });
  const decisionTime = replayWindow.decisionEndTime;
  const common = {
    ...inputs,
    config,
    metadataPolicy: allowCurrent ? RESEARCH_CURRENT_METADATA : STRICT_POINT_IN_TIME_METADATA,
  };
  if (points === 1) {
    console.log(JSON.stringify(summary(runHistoricalV23Point({ ...common, decisionTime })), null, 2));
    return;
  }
  const decisionTimes = Array.from({ length: points }, (_, index) => decisionTime - (points - index - 1) * stepMs);
  const timeline = runHistoricalV23Timeline({ ...common, decisionTimes });
  const result = summary(timeline.at(-1));
  result.timeline = timeline.map((item) => ({
    decisionTime: item.decisionTime,
    snapshotId: item.radar.snapshotId,
    previousSnapshotId: item.radar.previousSnapshotId,
    selectedSymbols: item.radar.selectedSymbols,
    rankVelocityLeaders: item.radar.rankVelocityLeaders.slice(0, 5),
    candidateCount: item.candidateCount,
  }));
  console.log(JSON.stringify(result, null, 2));
}

cli().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
