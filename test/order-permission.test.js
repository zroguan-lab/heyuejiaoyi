import test from "node:test";
import assert from "node:assert/strict";
import {
  createPermissionAttestation,
  credentialFingerprint,
  ORDER_PERMISSION_TTL_MS,
  permissionAttestationStatus,
} from "../src/execution/order-permission.js";

test("权限证明绑定 API Key、BTC 测试网端点和短有效期", () => {
  const verifiedAt = 1_000_000;
  const credentialHash = credentialFingerprint("key-a");
  const attestation = createPermissionAttestation({ credentialHash, symbol: "BTCUSDT", verifiedAt });
  assert.equal(permissionAttestationStatus(attestation, {
    credentialHash,
    now: verifiedAt + 1,
  }).valid, true);
  assert.equal(permissionAttestationStatus(attestation, {
    credentialHash: credentialFingerprint("key-b"),
    now: verifiedAt + 1,
  }).valid, false);
  assert.equal(permissionAttestationStatus(attestation, {
    credentialHash,
    now: verifiedAt + ORDER_PERMISSION_TTL_MS,
  }).valid, false);
});

test("权限证明按实际策略标的隔离", () => {
  const verifiedAt = 2_000_000;
  const credentialHash = credentialFingerprint("key-a");
  const attestation = createPermissionAttestation({ credentialHash, symbol: "AKEUSDT", verifiedAt });
  assert.equal(permissionAttestationStatus(attestation, { credentialHash, symbol: "AKEUSDT", now: verifiedAt + 1 }).valid, true);
  assert.equal(permissionAttestationStatus(attestation, { credentialHash, symbol: "BTCUSDT", now: verifiedAt + 1 }).valid, false);
});
