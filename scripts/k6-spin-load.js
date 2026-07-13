// k6 distributed load test for /api/spin.
//
// Proves the sequence-based claim path handles high real concurrency. Writes to
// an isolated test_bucket (safe: never touches real player data). Clean up the
// bucket afterwards via SQL.
//
// Run:
//   TARGET=1000  k6 run -e WHEEL_TEST_TOKEN=... -e TARGET=1000  scripts/k6-spin-load.js
//   TARGET=10000 k6 run -e WHEEL_TEST_TOKEN=... -e TARGET=10000 -e HOLD=20s scripts/k6-spin-load.js
//
// The bucket id is printed at startup (BUCKET=...) — use it for the SQL correctness check.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'https://wheel-of-fortune-roan.vercel.app';
const TOKEN = __ENV.WHEEL_TEST_TOKEN;
const TARGET = __ENV.TARGET ? parseInt(__ENV.TARGET) : 1000;
const RAMP = __ENV.RAMP || '30s';
const HOLD = __ENV.HOLD || '30s';

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: TARGET }, // ramp up to full concurrency
        { duration: HOLD, target: TARGET }, // hold at full concurrency
        { duration: '10s', target: 0 },     // ramp down
      ],
      gracefulRampDown: '15s',
    },
  },
  // server_busy (503) is graceful shedding, not a hard failure — count it separately.
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
  },
  discardResponseBodies: false,
};

const serverBusy = new Counter('server_busy_503');
const okSpins = new Counter('spins_ok');

export function setup() {
  const bucket = `k6-${Date.now()}`;
  console.log(`BUCKET=${bucket}  TARGET=${TARGET}  BASE=${BASE}`);
  return { bucket };
}

export default function (data) {
  const id = `${data.bucket}_${__VU}_${__ITER}`;
  const res = http.post(
    `${BASE}/api/spin`,
    JSON.stringify({ customerId: id, fingerprint: id, test: true, testBucket: data.bucket, skipDedupe: true }),
    { headers: { 'Content-Type': 'application/json', 'x-wheel-test-token': TOKEN } }
  );

  if (res.status === 503) serverBusy.add(1);
  if (res.status === 200) okSpins.add(1);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'not a 5xx server error': (r) => r.status < 500 || r.status === 503,
  });
}

export function teardown(data) {
  console.log(`DONE bucket=${data.bucket} — run the SQL correctness check on this bucket.`);
}
