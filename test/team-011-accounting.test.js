import test from 'node:test';
import assert from 'node:assert/strict';
import { TestnetCanaryExecutor } from '../src/execution/testnet-canary-executor.js';
import { BinanceTestnetTradingClient } from '../src/execution/binance-testnet-trading.js';
import { confirmationHash } from '../src/execution/canary-plan.js';
import { createHash } from 'node:crypto';

const NOW = 1_800_000_000_000;
const fill = (id, orderId, side, quantity = 1, overrides = {}) => ({ id: String(id), orderId: String(orderId), symbol: 'BTCUSDT', side, quantity, price: 100, commission: 0.01, commissionAsset: 'USDT', realizedPnl: 0, time: NOW - 1000, ...overrides });
function runFixture() {
  return { id: 'team-011-offline', symbol: 'BTCUSDT', direction: 'LONG', createdAt: NOW - 10000, status: 'ACCOUNTING_PENDING', entryOrder: { orderId: '10', executedQuantity: 1, side: 'BUY', status: 'FILLED' }, protection: { stop: { actualOrderId: '20', status: 'FINISHED' }, takeProfit1: { actualOrderId: '0', status: 'CANCELED' } }, plan: { direction: 'LONG', entrySide: 'BUY', exitSide: 'SELL', prices: { entry: 100, stopLoss: 90 }, orderReasons: {}, clientIds: { entry: 'entry', stop: 'stop' }, order: { quantity: 1, side: 'BUY' } } };
}
function harness(overrides = {}) {
  const audit = [];
  const client = { listUserTrades: async () => [fill(1, 10, 'BUY'), fill(2, 20, 'SELL')], listIncomeHistory: async () => [], ...overrides };
  const store = { appendExecutionAudit: async (...args) => audit.push(args), saveExecutionRun: async value => value, getMetadata: async () => null };
  return { executor: new TestnetCanaryExecutor({ client, store, now: () => NOW }), client, audit };
}

test('TEAM-011 canceled conditional leg actualOrderId 0 does not require a nonexistent fill', async () => {
  const { executor } = harness();
  const facts = await executor.collectRunTrades(runFixture());
  assert.equal(facts.accountingComplete, true);
  assert.ok(!facts.ownedOrderIds.includes('0'));
});

test('TEAM-011 missing funding API or rejected funding request remains unknown', async () => {
  for (const listIncomeHistory of [undefined, async () => { throw new Error('offline funding unavailable'); }]) {
    const { executor } = harness({ listIncomeHistory });
    const run = runFixture();
    delete run.protection.takeProfit1;
    const facts = await executor.collectRunTrades(run);
    assert.equal(facts.accountingComplete, false);
    assert.equal(executor.buildRunResult(facts, run).netPnl, null);
  }
});

test('TEAM-011 missing commission, non-USDT commission and incomplete exit quantities block settlement', async () => {
  for (const exit of [fill(2, 20, 'SELL', 1, { commission: null }), fill(2, 20, 'SELL', 1, { commissionAsset: 'BNB' }), fill(2, 20, 'SELL', 0.5)]) {
    const { executor } = harness({ listUserTrades: async () => [fill(1, 10, 'BUY'), exit] });
    const run = runFixture();
    delete run.protection.takeProfit1;
    const facts = await executor.collectRunTrades(run);
    assert.equal(facts.accountingComplete, false);
    assert.equal(executor.buildRunResult(facts, run).netPnl, null);
  }
});

test('TEAM-011 paginates 1000+ fills, removes overlapping IDs and ignores unrelated orders', async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => fill(index + 1, 10, 'BUY', 0.001));
  const queries = [];
  const { executor } = harness({ listUserTrades: async (_symbol, query) => {
    queries.push(query);
    if (query.fromId) {
      assert.equal(query.startTime, undefined);
      assert.equal(query.endTime, undefined);
    }
    return query.fromId ? [rows[999], fill(1001, 20, 'SELL'), fill(1002, 999, 'SELL')] : rows;
  } });
  const run = runFixture();
  delete run.protection.takeProfit1;
  const facts = await executor.collectRunTrades(run);
  assert.ok(queries.length >= 2);
  assert.equal(facts.trades.length, 1001);
  assert.equal(new Set(facts.trades.map(row => row.id)).size, 1001);
  assert.equal(facts.accountingComplete, true);
});

test('TEAM-011 signed read client forwards paging and preserves unknown fee fields', async () => {
  const client = new BinanceTestnetTradingClient({ baseUrl: 'https://demo-fapi.binance.com', apiKey: 'offline-fixture', apiSecret: 'offline-fixture' });
  const calls = [];
  client.signedRequest = async (method, path, query) => {
    calls.push({ method, path, query });
    return path.endsWith('userTrades') ? [{ id: 1, orderId: 10, symbol: 'BTCUSDT', qty: '1', price: '100' }] : [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE' }];
  };
  const trades = await client.listUserTrades('BTCUSDT', { startTime: 1, endTime: 2, orderId: 10 });
  await client.listUserTrades('BTCUSDT', { fromId: 3 });
  const income = await client.listIncomeHistory('BTCUSDT', { page: 2 });
  assert.deepEqual(calls[0].query, { symbol: 'BTCUSDT', startTime: 1, endTime: 2, fromId: undefined, orderId: 10, limit: 1000 });
  assert.equal(calls[1].query.fromId, 3);
  assert.equal(calls[2].query.page, 2);
  await assert.rejects(client.listUserTrades('BTCUSDT', { fromId: 3, startTime: 1 }), /fromId/);
  await assert.rejects(client.listUserTrades('BTCUSDT', { fromId: 3, endTime: 2 }), /fromId/);
  assert.equal(trades[0].commission, null);
  assert.equal(trades[0].realizedPnl, null);
  assert.equal(income[0].income, null);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('TEAM-011 funding 1000+ pages deduplicate transaction identity', async () => {
  const income = Array.from({ length: 1000 }, (_, index) => ({ transactionId: String(index + 1), symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: 0.001, asset: 'USDT', time: NOW - 1000 }));
  const pages = [];
  const { executor } = harness({ listIncomeHistory: async (_symbol, { page = 1 }) => {
    pages.push(page);
    return page === 1 ? income : [income[999], { ...income[0], transactionId: '1001' }];
  } });
  const run = runFixture();
  delete run.protection.takeProfit1;
  const facts = await executor.collectRunTrades(run);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(facts.fundingIncome.length, 1001);
  assert.ok(Math.abs(facts.fundingPnl - 1.001) < 1e-10);
});

test('TEAM-011 missing funding amount cannot silently become zero', async () => {
  const { executor } = harness({ listIncomeHistory: async () => [{ transactionId: '1', symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: null, asset: 'USDT', time: NOW - 1000 }] });
  const run = runFixture();
  delete run.protection.takeProfit1;
  const facts = await executor.collectRunTrades(run);
  assert.equal(facts.accountingComplete, false);
  assert.equal(executor.buildRunResult(facts, run).netPnl, null);
});

function entryHarness({ positionQuantity = 0, order = null, trades = [] } = {}) {
  let clock = NOW;
  let saved = runFixture();
  saved.status = 'ENTRY_PENDING';
  saved.protection = {};
  saved.plan.expiresAt = NOW + 600000;
  saved.plan.quantity = 1;
  saved.plan.rules = { stepSize: 0.001 };
  saved.entryOrder = { orderId: '10', status: 'FILLED', side: 'BUY', executedQuantity: 1, averagePrice: 100 };
  saved.entryExecution = { submittedAt: NOW - 1000 };
  const account = { positions: positionQuantity ? [{ symbol: 'BTCUSDT', quantity: positionQuantity, positionSide: 'BOTH' }] : [], openOrders: [], openAlgoOrders: [] };
  const protectedQuantities = [];
  const state = harness({ queryOrder: async () => structuredClone(order), fetchAccountState: async () => structuredClone(account), listUserTrades: async () => structuredClone(trades) });
  state.executor.now = () => clock;
  state.executor.store.saveExecutionRun = async run => { saved = structuredClone(run); return run; };
  state.executor.store.getExecutionRun = async () => structuredClone(saved);
  state.executor.ensureRunOrderReasons = async () => {};
  state.executor.ensureProtection = async (run, quantity) => { protectedQuantities.push(quantity); run.status = 'OPEN_PROTECTED'; await state.executor.store.saveExecutionRun(run); return run; };
  return { ...state, account, protectedQuantities, load: () => structuredClone(saved), advance: ms => { clock += ms; } };
}

test('TEAM-011 transient absent GET stays pending; repeated absence after grace isolates ACK conflict across restart', async () => {
  const state = entryHarness();
  const first = await state.executor.reconcileEntry(state.load(), state.account);
  assert.notEqual(first.status, 'CANCELED');
  assert.notEqual(first.status, 'CLOSED');
  assert.notEqual(first.status, 'ENTRY_FACT_CONFLICT');
  state.advance(121000);
  const restored = new TestnetCanaryExecutor({ client: state.client, store: state.executor.store, now: state.executor.now });
  const second = await restored.reconcileEntry(state.load(), state.account);
  assert.equal(second.status, 'ENTRY_FACT_CONFLICT');
  assert.equal(second.performanceEligible, false);
  assert.equal(second.result?.netPnl ?? null, null);
  assert.deepEqual(state.protectedQuantities, []);
});

test('TEAM-011 real position receives protection even while GET and fills are absent', async () => {
  const state = entryHarness({ positionQuantity: 0.4 });
  await state.executor.reconcileEntry(state.load(), state.account);
  assert.deepEqual(state.protectedQuantities, [0.4]);
});

test('TEAM-011 signed GET confirmed fill receives protection while fills endpoint is delayed', async () => {
  const order = { orderId: '10', clientOrderId: 'entry', symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', executedQuantity: 1, averagePrice: 100, updateTime: NOW };
  const state = entryHarness({ positionQuantity: 1, order });
  await state.executor.reconcileEntry(state.load(), state.account);
  assert.deepEqual(state.protectedQuantities, [1]);
});

test('TEAM-011 concurrent reconciliation of the same persisted run is serialized', async () => {
  const state = entryHarness();
  let queries = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  state.client.queryOrder = async () => { queries += 1; await blocked; return null; };
  const first = state.executor.reconcile(state.load().id, { account: state.account });
  await new Promise(resolve => setImmediate(resolve));
  const second = state.executor.reconcile(state.load().id, { account: state.account });
  release();
  await Promise.all([first, second]);
  assert.equal(queries, 1);
});

test('TEAM-011 partial fill cancels the remainder and protects only confirmed executed quantity', async () => {
  const order = { orderId: '10', clientOrderId: 'entry', symbol: 'BTCUSDT', side: 'BUY', status: 'PARTIALLY_FILLED', executedQuantity: 0.98, averagePrice: 100, updateTime: NOW };
  const state = entryHarness({ positionQuantity: 0.98, order });
  let canceled = 0;
  state.client.cancelOrder = async () => { canceled += 1; return { ...order, status: 'CANCELED' }; };
  await state.executor.reconcileEntry(state.load(), state.account);
  assert.equal(canceled, 1);
  assert.deepEqual(state.protectedQuantities, [0.98]);
});

test('TEAM-011 late matching GET resolves transient fact delay', async () => {
  const state = entryHarness();
  await state.executor.reconcileEntry(state.load(), state.account);
  state.client.queryOrder = async () => ({ orderId: '10', clientOrderId: 'entry', symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', executedQuantity: 1, averagePrice: 100 });
  state.account.positions = [{ symbol: 'BTCUSDT', quantity: 1, positionSide: 'BOTH' }];
  const recovered = await state.executor.reconcileEntry(state.load(), state.account);
  assert.equal(recovered.entryFactVerification.status, 'ORDER_VERIFIED');
  assert.deepEqual(state.protectedQuantities, [1]);
});

test('TEAM-011 malformed or foreign fills cannot confirm absent entry', async () => {
  for (const override of [{ symbol: 'ETHUSDT' }, { side: 'SELL' }, { id: '0' }, { price: null }, { time: null }]) {
    const state = entryHarness({ trades: [fill(1, 10, 'BUY', 1, override)] });
    const facts = await state.executor.verifyEntryFacts(state.load(), state.account);
    assert.equal(facts.pending, true, JSON.stringify(override));
  }
});

test('TEAM-011 two executor objects sharing one store do not reconcile a run concurrently', async () => {
  const state = entryHarness();
  let queries = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  state.client.queryOrder = async () => { queries += 1; await blocked; return null; };
  const restored = new TestnetCanaryExecutor({ client: state.client, store: state.executor.store, now: state.executor.now });
  restored.ensureRunOrderReasons = async () => {};
  const first = state.executor.reconcile(state.load().id, { account: state.account });
  await new Promise(resolve => setImmediate(resolve));
  const second = restored.reconcile(state.load().id, { account: state.account });
  release();
  await Promise.all([first, second]);
  assert.equal(queries, 1);
});

test('TEAM-011 FILLED submission ACK alone does not place protection or permit duplicate entry', async () => {
  const state = entryHarness();
  const prepared = state.load();
  prepared.status = 'PREPARED';
  prepared.entryOrder = null;
  prepared.confirmationCodeHash = confirmationHash('offline-code', prepared.id);
  prepared.plan.rules.tickSize = 0.1;
  prepared.plan.orderReasons.entry = '离线回归测试的模拟入场原因，不连接交易所。';
  await state.executor.store.saveExecutionRun(prepared);
  state.executor.enabled = true;
  state.executor.assertFreshExecutionPreconditions = async () => {};
  state.executor.configureAccount = async () => {};
  let submissions = 0;
  state.client.placeLimitOrder = async () => {
    submissions += 1;
    return { orderId: '10', clientOrderId: 'entry', symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', executedQuantity: 1, averagePrice: 100 };
  };
  const pending = await state.executor.execute(prepared.id, 'offline-code');
  assert.equal(pending.status, 'ENTRY_FACT_PENDING');
  assert.equal(pending.entryFactVerification.ack.status, 'FILLED');
  assert.deepEqual(state.protectedQuantities, []);
  await assert.rejects(state.executor.execute(prepared.id, 'offline-code'), /不允许提交/);
  assert.equal(submissions, 1);
});

test('TEAM-011 malformed signed history responses reject instead of becoming empty pages', async () => {
  const client = new BinanceTestnetTradingClient({ baseUrl: 'https://demo-fapi.binance.com', apiKey: 'offline-fixture', apiSecret: 'offline-fixture' });
  for (const payload of [null, {}, { code: 200 }]) {
    client.signedRequest = async () => payload;
    await assert.rejects(client.listUserTrades('BTCUSDT'), TypeError);
    await assert.rejects(client.listIncomeHistory('BTCUSDT'), TypeError);
  }
});

test('TEAM-011 changed account fingerprint cannot reuse persisted entry evidence', async () => {
  const state = entryHarness({ positionQuantity: 1 });
  const run = state.load();
  run.entryFactVerification = { accountFingerprint: createHash('sha256').update('previous-account').digest('hex'), ack: run.entryOrder, checks: 1, history: [] };
  state.client.credentialFingerprint = 'different-account';
  const result = await state.executor.reconcileEntry(run, state.account);
  assert.equal(result.status, 'ENTRY_FACT_CONFLICT');
  assert.equal(result.result.netPnl, null);
  assert.deepEqual(state.protectedQuantities, []);
});

test('TEAM-011 opposite, hedge-mode, oversized and ambiguous same-symbol positions stay isolated', async () => {
  for (const kind of ['opposite', 'hedge', 'oversized', 'ambiguous']) {
    const state = entryHarness({ positionQuantity: kind === 'opposite' ? -1 : kind === 'oversized' ? 2 : 1 });
    if (kind === 'hedge') state.account.positions[0].positionSide = 'LONG';
    if (kind === 'ambiguous') state.executor.store.listActiveExecutionRuns = async () => [state.load(), { ...state.load(), id: 'other-run' }];
    const result = await state.executor.reconcileEntry(state.load(), state.account);
    assert.equal(result.status, 'ENTRY_FACT_CONFLICT', kind);
    assert.deepEqual(state.protectedQuantities, [], kind);
  }
});

test('TEAM-011 partial-fill protection precedes a slow or failed remainder cancellation', async () => {
  const order = { orderId: '10', clientOrderId: 'entry', symbol: 'BTCUSDT', side: 'BUY', status: 'PARTIALLY_FILLED', executedQuantity: 0.98, averagePrice: 100 };
  const state = entryHarness({ positionQuantity: 0.98, order });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  state.client.cancelOrder = async () => { await blocked; throw new Error('offline cancellation timeout'); };
  const pending = state.executor.reconcileEntry(state.load(), state.account);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.protectedQuantities[0], 0.98);
  release();
  await pending;
  assert.ok(state.protectedQuantities.every(quantity => quantity === 0.98));
});

test('TEAM-011 lagging NEW zero aggregate with a real position keeps reconciling its remaining entry', async () => {
  const initial = { orderId: '10', clientOrderId: 'entry', symbol: 'BTCUSDT', side: 'BUY', status: 'NEW', executedQuantity: 0, averagePrice: 0 };
  const state = entryHarness({ positionQuantity: 0.4, order: initial });
  const run = state.load();
  run.plan.quantity = 0.4;
  await state.executor.store.saveExecutionRun(run);
  let cancellations = 0;
  state.client.cancelOrder = async () => { cancellations += 1; return { ...initial, status: 'CANCELED', executedQuantity: 0.4, averagePrice: 100 }; };
  await state.executor.reconcile(run.id, { account: state.account });
  const pending = state.load();
  assert.equal(pending.status, 'ENTRY_FACT_PENDING');
  assert.equal(pending.entryExecution.remainderPending, true);
  assert.equal(cancellations, 0);
  assert.equal(state.protectedQuantities[0], 0.4);
  state.client.queryOrder = async () => ({ ...initial, status: 'PARTIALLY_FILLED', executedQuantity: 0.4, averagePrice: 100 });
  await state.executor.reconcile(run.id, { account: state.account });
  assert.equal(cancellations, 1);
  assert.equal(state.load().entryExecution.remainderPending, false);
  assert.ok(state.protectedQuantities.every(quantity => quantity === 0.4));
});

for (const stopOnly of [true, false]) {
  test(`TEAM-011 below-minimum partial quantity still establishes full-position stop (stopOnly=${stopOnly})`, async () => {
    const requests = [];
    let currentStop = null;
    const { executor, audit } = harness({
      queryAlgoOrder: async () => currentStop,
      placeStopClose: async request => {
        requests.push({ type: 'stop', ...request });
        currentStop = { symbol: request.symbol, side: request.side, clientAlgoId: request.clientAlgoId, algoId: '123', status: 'NEW', type: 'STOP_MARKET', closePosition: true };
        return currentStop;
      },
      placeTakeProfitClose: async () => { requests.push({ type: 'tp' }); throw new Error('unexpected TP submission'); },
      closePositionMarket: async () => { requests.push({ type: 'close' }); throw new Error('unexpected close'); },
    });
    const run = runFixture();
    run.protection = {};
    run.plan.rules = { minQuantity: 0.01, stepSize: 0.001, minNotional: 5 };
    run.plan.prices.takeProfit1 = 110;
    run.plan.prices.takeProfit2 = 120;
    run.plan.orderReasons.stop = '离线测试已有部分成交，因此建立全仓止损。';
    const result = await executor.ensureProtection(run, 0.001, { stopOnly });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, 'stop');
    assert.equal(requests[0].quantity, undefined);
    assert.equal(requests[0].triggerPrice, 90);
    assert.equal(result.protection.stop.status, 'NEW');
    assert.equal(result.status, stopOnly ? 'PARTIALLY_FILLED' : 'PROTECTION_INCOMPLETE');
    assert.equal(result.protection.phase, stopOnly ? 'ENTRY_REMAINDER_PENDING' : 'TP_QUANTITY_PENDING');
    assert.ok(!audit.some(([, event]) => event === 'STOP_PROTECTION_FAILED'));
    // Rechecking an already confirmed stop must not submit another stop.
    await executor.ensureProtection(result, 0.001, { stopOnly });
    assert.equal(requests.length, 1);
  });
}

