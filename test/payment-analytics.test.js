import test from 'node:test';
import assert from 'node:assert/strict';
import { getPaymentAnalytics, formatPaymentAnalytics } from '../src/admin/dashboard-repository.js';

test('payment analytics runs 30-day aggregates for daily, method, totals, premium and payers', async () => {
  const calls = [];
  const pool = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes('date_trunc')) return { rows: [{ day: '2026-11-19', currency: 'INR', successful_count: 2, unsuccessful_count: 1, successful_minor: 19900, total_count: 3 }] };
    if (sql.includes('GROUP BY method')) return { rows: [{ method: 'telegram_stars', currency: 'INR', successful_count: 2, unsuccessful_count: 0, successful_minor: 19900, total_count: 2 }] };
    if (sql.includes('GROUP BY currency')) return { rows: [{ currency: 'INR', successful_count: 2, unsuccessful_count: 1, successful_minor: 19900, total_count: 3 }] };
    if (sql.includes('premium_memberships')) return { rows: [{ active_members: 4, new_members_30d: 2, membership_records_30d: 3 }] };
    return { rows: [{ paying_users_30d: 2 }] };
  } };
  const data = await getPaymentAnalytics(pool);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((sql) => sql.includes("INTERVAL '30 days'")));
  assert.equal(data.totals[0].successful_minor, 19900);
  assert.equal(data.methods[0].method, 'telegram_stars');
  assert.equal(data.premium.active_members, 4);
  assert.equal(data.payingUsers, 2);
});

test('analytics formatter displays currency, payment methods, membership and daily rows', () => {
  const output = formatPaymentAnalytics({
    totals: [{ currency: 'INR', successful_minor: 12500, successful_count: 2, unsuccessful_count: 1, total_count: 3 }],
    methods: [{ method: 'telegram_stars', currency: 'INR', successful_minor: 12500, successful_count: 2, unsuccessful_count: 0, total_count: 2 }],
    premium: { active_members: 5, new_members_30d: 3, membership_records_30d: 3 },
    payingUsers: 2,
    daily: [{ day: '2026-11-19', currency: 'INR', successful_minor: 12500, successful_count: 2 }],
  });
  assert.match(output, /Revenue: 125\.00 INR/);
  assert.match(output, /telegram_stars/);
  assert.match(output, /Active memberships now: 5/);
  assert.match(output, /Unique paying users \(30d\): 2/);
  assert.match(output, /2026-11-19/);
});
