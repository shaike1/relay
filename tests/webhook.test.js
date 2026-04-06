'use strict';
/**
 * webhook.test.js — Integration tests for relay webhook logic.
 * Uses Node.js built-in test runner (node:test) — no external framework needed.
 * Tests pure functions from relay-api/utils.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRateLimiter,
  parseCronField,
  cronMatches,
  parseCommand,
  resolveMultiTenantThread,
  RATE_LIMIT_MAX,
} = require('../relay-api/utils.js');

// ─── JSONL queue write helper (mirrors server.js logic) ───────────────────────

describe('Queue JSONL write', () => {
  test('writes a valid JSONL entry to file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
    const queueFile = path.join(tmpDir, 'tg-queue-123.jsonl');

    const entry = {
      message_id: 42,
      user: 'TestUser',
      user_id: 999,
      text: 'Hello relay',
      ts: Math.floor(Date.now() / 1000),
      via: 'webhook',
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const lines = fs.readFileSync(queueFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'should have exactly one JSONL line');
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.message_id, 42);
    assert.equal(parsed.user, 'TestUser');
    assert.equal(parsed.text, 'Hello relay');
    assert.equal(parsed.via, 'webhook');

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('appends multiple entries correctly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
    const queueFile = path.join(tmpDir, 'tg-queue-456.jsonl');

    for (let i = 1; i <= 3; i++) {
      const entry = { message_id: i, user: 'u', text: `msg${i}`, ts: Date.now(), via: 'webhook' };
      fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    }

    const lines = fs.readFileSync(queueFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).message_id, 3);

    fs.rmSync(tmpDir, { recursive: true });
  });

  test('force:true entries are written with force flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
    const queueFile = path.join(tmpDir, 'tg-queue-789.jsonl');

    const entry = {
      message_id: -(Math.floor(Date.now() / 1000) % 2147483647),
      user: 'scheduler',
      text: 'Scheduled task',
      ts: Math.floor(Date.now() / 1000),
      via: 'scheduler',
      force: true,
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const parsed = JSON.parse(fs.readFileSync(queueFile, 'utf8').trim());
    assert.ok(parsed.force === true, 'force flag should be true');
    assert.ok(parsed.message_id < 0, 'scheduled entries have negative message_id');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ─── Command parsing ───────────────────────────────────────────────────────────

describe('Command parsing', () => {
  test('parses /status command', () => {
    assert.equal(parseCommand('/status'), 'status');
  });

  test('parses /status@BotName command', () => {
    assert.equal(parseCommand('/status@MyBot'), 'status');
  });

  test('parses /history command', () => {
    assert.equal(parseCommand('/history 2'), 'history');
  });

  test('parses /cancel command', () => {
    assert.equal(parseCommand('/cancel'), 'cancel');
  });

  test('parses /restart command', () => {
    assert.equal(parseCommand('/restart'), 'restart');
  });

  test('parses /pause command', () => {
    assert.equal(parseCommand('/pause'), 'pause');
  });

  test('parses /resume command', () => {
    assert.equal(parseCommand('/resume'), 'resume');
  });

  test('returns null for non-command text', () => {
    assert.equal(parseCommand('Hello world'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(parseCommand(''), null);
  });

  test('returns null for null', () => {
    assert.equal(parseCommand(null), null);
  });
});

// ─── Rate limiter ──────────────────────────────────────────────────────────────

describe('Rate limiter', () => {
  test('allows messages under the limit', () => {
    const limiter = createRateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      assert.ok(limiter.check(111), `message ${i + 1} should be allowed`);
    }
  });

  test('blocks the 31st message in the same minute (default limit)', () => {
    const limiter = createRateLimiter(RATE_LIMIT_MAX, 60000);
    const userId = 222;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      limiter.check(userId);
    }
    assert.ok(!limiter.check(userId), 'should be rate limited after 30 messages');
  });

  test('different users have independent limits', () => {
    const limiter = createRateLimiter(2, 60000);
    limiter.check(1);
    limiter.check(1);
    // user 1 is now limited
    assert.ok(!limiter.check(1), 'user 1 should be limited');
    // user 2 should still be allowed
    assert.ok(limiter.check(2), 'user 2 should not be limited');
  });

  test('allows messages again after window expires', async () => {
    const limiter = createRateLimiter(2, 50); // 50ms window
    const userId = 333;
    limiter.check(userId);
    limiter.check(userId);
    assert.ok(!limiter.check(userId), 'should be limited');
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    assert.ok(limiter.check(userId), 'should be allowed after window expires');
  });
});

// ─── Cron expression parser ────────────────────────────────────────────────────

describe('Cron expression parser - parseCronField', () => {
  test('wildcard * always matches', () => {
    assert.ok(parseCronField('*', 0, 0, 59));
    assert.ok(parseCronField('*', 59, 0, 59));
    assert.ok(parseCronField('*', 30, 0, 59));
  });

  test('exact number match', () => {
    assert.ok(parseCronField('5', 5, 0, 59));
    assert.ok(!parseCronField('5', 6, 0, 59));
  });

  test('range match lo-hi', () => {
    assert.ok(parseCronField('1-5', 3, 0, 6));
    assert.ok(parseCronField('1-5', 1, 0, 6));
    assert.ok(parseCronField('1-5', 5, 0, 6));
    assert.ok(!parseCronField('1-5', 6, 0, 6));
  });

  test('comma list match', () => {
    assert.ok(parseCronField('1,3,5', 3, 0, 6));
    assert.ok(!parseCronField('1,3,5', 2, 0, 6));
  });

  test('step /N match', () => {
    assert.ok(parseCronField('*/15', 0, 0, 59));
    assert.ok(parseCronField('*/15', 15, 0, 59));
    assert.ok(parseCronField('*/15', 30, 0, 59));
    assert.ok(parseCronField('*/15', 45, 0, 59));
    assert.ok(!parseCronField('*/15', 16, 0, 59));
  });
});

describe('Cron expression parser - cronMatches', () => {
  test('every minute expression "* * * * *" always matches', () => {
    const now = new Date();
    assert.ok(cronMatches('* * * * *', now));
  });

  test('exact minute:hour match', () => {
    const d = new Date(2026, 0, 1, 9, 0, 0); // Jan 1 2026 09:00
    assert.ok(cronMatches('0 9 * * *', d));
    assert.ok(!cronMatches('0 10 * * *', d));
  });

  test('weekday range match', () => {
    // Jan 1 2026 is a Thursday (day 4)
    const d = new Date(2026, 0, 1, 9, 0, 0);
    assert.ok(cronMatches('0 9 * * 1-5', d)); // Mon-Fri
    assert.ok(!cronMatches('0 9 * * 6', d));  // Saturday
  });

  test('invalid expression (wrong field count) returns false', () => {
    assert.ok(!cronMatches('* * * *', new Date()));       // 4 fields
    assert.ok(!cronMatches('* * * * * *', new Date()));  // 6 fields
  });

  test('specific date match', () => {
    const d = new Date(2026, 2, 15, 12, 30, 0); // Mar 15 2026 12:30
    assert.ok(cronMatches('30 12 15 3 *', d));
    assert.ok(!cronMatches('30 12 16 3 *', d)); // wrong day
  });
});

// ─── Multi-tenant thread resolution ───────────────────────────────────────────

describe('resolveMultiTenantThread', () => {
  function makeMockOpts(sessions, initialMap = {}) {
    let map = { ...initialMap };
    return {
      readSessions: () => sessions,
      readMap: () => ({ ...map }),
      writeMap: (tid, m) => { map = { ...m }; },
      getMap: () => map,
    };
  }

  test('returns original threadId when session not found', () => {
    const opts = makeMockOpts([]);
    assert.equal(resolveMultiTenantThread('100', '42', 'Alice', opts), '100');
  });

  test('returns original threadId when multi_tenant is not set', () => {
    const opts = makeMockOpts([{ thread_id: '100', session: 'test' }]);
    assert.equal(resolveMultiTenantThread('100', '42', 'Alice', opts), '100');
  });

  test('assigns virtual thread for new user in multi-tenant session', () => {
    const opts = makeMockOpts([{ thread_id: '100', session: 'test', multi_tenant: true }]);
    const result = resolveMultiTenantThread('100', '42', 'Alice', opts);
    // Virtual: 100 * 10000 + 1 = 1000001
    assert.equal(result, 1000001);
  });

  test('same user always gets same virtual thread', () => {
    const opts = makeMockOpts([{ thread_id: '100', session: 'test', multi_tenant: true }]);
    const first  = resolveMultiTenantThread('100', '42', 'Alice', opts);
    const second = resolveMultiTenantThread('100', '42', 'Alice', opts);
    assert.equal(first, second);
  });

  test('different users get different virtual threads', () => {
    const opts = makeMockOpts([{ thread_id: '100', session: 'test', multi_tenant: true }]);
    const alice = resolveMultiTenantThread('100', '42', 'Alice', opts);
    const bob   = resolveMultiTenantThread('100', '99', 'Bob', opts);
    assert.notEqual(alice, bob);
  });
});
