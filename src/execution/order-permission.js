import { createHash, randomBytes } from "node:crypto";
import { ceilToStep, formatToStep, parseContractRules, quantizeEntryPrice } from "./contract-rules.js";
import { assertExecutionSymbol } from "./execution-symbols.js";

export const ORDER_PERMISSION_METADATA_KEY = "binance_testnet_order_test_permission";
export const ORDER_PERMISSION_TTL_MS = 15 * 60 * 1000;

export function credentialFingerprint(apiKey) {
  if (!apiKey) throw new Error("缺少 API Key，无法绑定权限验证结果");
  return createHash("sha256").update(String(apiKey)).digest("hex");
}

export function createPermissionAttestation({ credentialHash, symbol, verifiedAt = Date.now() }) {
  assertExecutionSymbol(symbol, "权限验证标的");
  if (!credentialHash || !Number.isFinite(verifiedAt)) throw new TypeError("权限验证凭据格式无效");
  return {
    accepted: true,
    environment: "TESTNET",
    endpoint: "/fapi/v1/order/test",
    submittedToMatchingEngine: false,
    symbol,
    credentialHash,
    verifiedAt,
    expiresAt: verifiedAt + ORDER_PERMISSION_TTL_MS,
  };
}

export function permissionAttestationStatus(attestation, { credentialHash, symbol = attestation?.symbol, now = Date.now() } = {}) {
  const valid = Boolean(
    attestation?.accepted === true
    && attestation.environment === "TESTNET"
    && attestation.endpoint === "/fapi/v1/order/test"
    && attestation.submittedToMatchingEngine === false
    && attestation.symbol === symbol
    && attestation.credentialHash === credentialHash
    && Number.isFinite(attestation.verifiedAt)
    && Number.isFinite(attestation.expiresAt)
    && attestation.verifiedAt <= now
    && attestation.expiresAt > now,
  );
  return {
    valid,
    accepted: attestation?.accepted === true,
    environment: attestation?.environment ?? null,
    endpoint: attestation?.endpoint ?? null,
    submittedToMatchingEngine: attestation?.submittedToMatchingEngine ?? null,
    symbol: attestation?.symbol ?? null,
    verifiedAt: Number.isFinite(attestation?.verifiedAt) ? attestation.verifiedAt : null,
    expiresAt: Number.isFinite(attestation?.expiresAt) ? attestation.expiresAt : null,
  };
}

export async function probeTestnetOrderPermission({ client, symbol = "BTCUSDT", targetNotional = 100, symbolInfo = null, now = Date.now() } = {}) {
  if (!client) throw new Error("缺少 Binance Testnet 交易客户端");
  const [resolvedSymbolInfo, markPrice] = await Promise.all([
    symbolInfo ?? client.fetchExchangeInfo(symbol),
    client.fetchMarkPrice(symbol),
  ]);
  const rules = parseContractRules(resolvedSymbolInfo);
  const price = quantizeEntryPrice("LONG", markPrice, rules);
  const requiredNotional = Math.max(targetNotional, rules.minNotional * 1.01);
  const quantity = ceilToStep(Math.max(rules.minQuantity, requiredNotional / price), rules.stepSize);
  if (quantity > rules.maxQuantity) throw new Error(`权限验证数量超过 ${symbol} 合约上限`);
  await client.testLimitOrderPermission({
    symbol,
    side: "BUY",
    quantity: formatToStep(quantity, rules.stepSize),
    price: formatToStep(price, rules.tickSize),
    clientOrderId: `cfs-perm-${now.toString(36)}-${randomBytes(3).toString("hex")}`,
  });
  return createPermissionAttestation({
    credentialHash: client.credentialFingerprint,
    symbol,
    verifiedAt: now,
  });
}
