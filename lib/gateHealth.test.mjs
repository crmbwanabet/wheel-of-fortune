import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGateHealth } from './gateHealth.js';

const TH = { minSample: 10, failRateShadow: 0.30, failRateEnforce: 0.20, p95Ms: 1500, falseDenials: 3 };
// helper to build N rows with overrides applied to the first `k`
const rows = (specs) => specs.flatMap(({ n, ...over }) => Array.from({ length: n }, () => ({
  mode: 'shadow', decision: 'eligible', reason: 'deposit_found', eventual_eligible: true, eventual_latency_ms: 200, ...over,
})));

test('healthy window: nothing fires', () => {
  const ev = evaluateGateHealth(rows([{ n: 20 }]), TH);
  assert.equal(ev.n, 20);
  assert.equal(ev.conditions.api_failing.firing, false);
  assert.equal(ev.conditions.latency.firing, false);
  assert.equal(ev.conditions.false_denials.firing, false);
});

test('shadow API failing: >=30% error/timeout with enough sample fires (warning)', () => {
  const ev = evaluateGateHealth(rows([
    { n: 8, reason: 'error', decision: 'forced_loss', eventual_eligible: false },
    { n: 12, reason: 'deposit_found' },
  ]), TH);
  assert.equal(ev.n, 20);
  assert.equal(ev.failureRate, 0.4);
  assert.equal(ev.conditions.api_failing.firing, true);
  assert.equal(ev.conditions.api_failing.severity, 'warning');
});

test('below min sample never fires api_failing', () => {
  const ev = evaluateGateHealth(rows([{ n: 3, reason: 'error', decision: 'forced_loss', eventual_eligible: false }]), TH);
  assert.equal(ev.conditions.api_failing.firing, false); // n=3 < minSample
});

test('enforce API failing uses stricter threshold + critical severity', () => {
  const ev = evaluateGateHealth(rows([
    { n: 3, mode: 'enforce', reason: 'timeout', decision: 'forced_loss', eventual_eligible: false },
    { n: 12, mode: 'enforce', reason: 'deposit_found' },
  ]), TH);
  assert.equal(ev.hasEnforce, true);
  assert.equal(ev.enforceN, 15);
  assert.equal(ev.enforceFailureRate, 0.2);
  assert.equal(ev.conditions.api_failing.firing, true);   // 20% >= failRateEnforce(0.20)
  assert.equal(ev.conditions.api_failing.severity, 'critical');
});

test('latency p95 fires when high (nearest-rank)', () => {
  const ev = evaluateGateHealth(rows([
    { n: 18, eventual_latency_ms: 300 },
    { n: 2, eventual_latency_ms: 1800 },
  ]), TH);
  // sorted asc, N=20, p95 index = ceil(0.95*20)-1 = 18 -> the 19th value = 1800
  assert.equal(ev.p95LatencyMs, 1800);
  assert.equal(ev.conditions.latency.firing, true);
});

test('latency ignores null eventual_latency_ms', () => {
  const ev = evaluateGateHealth(rows([
    { n: 15, eventual_latency_ms: 200 },
    { n: 5, eventual_latency_ms: null },
  ]), TH);
  assert.equal(ev.p95LatencyMs, 200);
  assert.equal(ev.conditions.latency.firing, false);
});

test('false_denials counts forced_loss + eventual_eligible=true only', () => {
  const ev = evaluateGateHealth(rows([
    { n: 4, decision: 'forced_loss', eventual_eligible: true },   // false denials
    { n: 2, decision: 'forced_loss', eventual_eligible: false },  // legit denials
    { n: 2, decision: 'forced_loss', eventual_eligible: null },   // unknown (not counted)
    { n: 12, decision: 'eligible', eventual_eligible: true },
  ]), TH);
  assert.equal(ev.falseDenials, 4);
  assert.equal(ev.conditions.false_denials.firing, true);
});

test('empty window is safe', () => {
  const ev = evaluateGateHealth([], TH);
  assert.equal(ev.n, 0);
  assert.equal(ev.failureRate, 0);
  assert.equal(ev.p95LatencyMs, null);
  assert.equal(ev.conditions.api_failing.firing, false);
});
