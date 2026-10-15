function retryAfterMilliseconds(headers) {
  const raw = headers?.get?.("retry-after");
  if (raw === null || raw === undefined || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

const sharedBlocks = new Map();

export function recordBinanceBlock(scope, retryAt) {
  if (!scope || !Number.isFinite(retryAt)) return retryAt;
  sharedBlocks.set(scope, Math.max(sharedBlocks.get(scope) ?? 0, retryAt));
  return sharedBlocks.get(scope);
}

export function getBinanceBlockedUntil(scope, localBlockedUntil = 0) {
  return Math.max(Number(localBlockedUntil) || 0, scope ? sharedBlocks.get(scope) ?? 0 : 0);
}

export function binanceRetryAt(response, text, now = Date.now()) {
  if (![418, 429].includes(Number(response?.status))) return null;
  const banMatch = String(text ?? "").match(/banned until\s+(\d{4,16})/i);
  if (banMatch) {
    const timestamp = Number(banMatch[1]);
    if (Number.isFinite(timestamp) && timestamp > now) return timestamp;
  }
  const retryMs = retryAfterMilliseconds(response?.headers);
  if (Number.isFinite(retryMs)) return now + retryMs;
  return now + (Number(response?.status) === 418 ? 60_000 : 10_000);
}

export function assertBinanceRequestAvailable(blockedUntil, now = Date.now(), scope = null) {
  const effectiveBlockedUntil = getBinanceBlockedUntil(scope, blockedUntil);
  if (!Number.isFinite(effectiveBlockedUntil) || now >= effectiveBlockedUntil) return;
  const error = new Error(`Binance 请求已本地暂停至 ${new Date(effectiveBlockedUntil).toISOString()}，避免重复触发限流`);
  error.name = "BinanceRateLimitBlockedError";
  error.code = "BINANCE_RATE_LIMIT_BLOCKED";
  error.retryAt = effectiveBlockedUntil;
  throw error;
}
