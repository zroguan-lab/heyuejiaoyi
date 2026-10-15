import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { buildV23StrategySnapshot } from "../src/domain/v2-3-strategy-engine.js";

loadDotEnv();
const snapshot = buildV23StrategySnapshot(loadConfig());
console.log(JSON.stringify(snapshot, null, 2));
