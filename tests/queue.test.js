'use strict';
/**
 * queue.test.js — Tests for MCP queue reading logic.
 * Covers: force:true delivery, message_id deduplication, negative IDs with force.
 * Uses Node.js built-in test runner (node:test).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─── Inline queue reader (mirrors mcp-telegram fetch_messages logic) ──────────

/**
 * Read queue file and return messages that should be delivered given lastId.
 * Mirrors the logic in the MCP server's fetch_messages tool:
 *   - Positive message_id > lastId → deliver (dedup by id in seen set)
 *   - Negative message_id + force:true → always deliver (dedup by id in seen set)
 */
function readQueue(queueFile, lastId, seen = new Set()) {
  const results = [];
  if (!fs.existsSync(queueFile)) return results;

  const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }

    const mid = msg.message_id ?? 0;

    if (mid > 0 && mid > lastId && !seen.has(mid)) {
      seen.add(mid);
      results.push(msg);
    } else if (mid < 0 && msg.force === true && !seen.has(mid)) {
      seen.add(mid);
      results.push(msg);
    }
  }
  return results;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Queue reading - basic delivery', () => {
  let tmpDir, queueFile;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-test-'));
    queueFile = path.join(tmpDir, 'tg-queue-test.jsonl');
  }
  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test('delivers messages with id > lastId', () => {
    setup();
    const entries = [
      { message_id: 10, user: 'alice', text: 'hi', ts: 1 },
      { message_id: 20, user: 'bob',   text: 'hey', ts: 2 },
      { message_id: 30, user: 'carol', text: 'yo',  ts: 3 },
    ];
    for (const e of entries) fs.appendFileSync(queueFile, JSON.stringify(e) + '\n');

    const results = readQueue(queueFile, 15);
    assert.equal(results.length, 2); // id 20 and 30
    assert.equal(results[0].message_id, 20);
    assert.equal(results[1].message_id, 30);
    teardown();
  });

  test('does not deliver messages with id <= lastId', () => {
    setup();
    const entries = [
      { message_id: 5,  user: 'alice', text: 'old', ts: 1 },
      { message_id: 10, user: 'bob',   text: 'old', ts: 2 },
    ];
    for (const e of entries) fs.appendFileSync(queueFile, JSON.stringify(e) + '\n');

    const results = readQueue(queueFile, 10);
    assert.equal(results.length, 0);
    teardown();
  });

  test('empty queue returns empty array', () => {
    setup();
    fs.writeFileSync(queueFile, '');
    const results = readQueue(queueFile, 0);
    assert.equal(results.length, 0);
    teardown();
  });

  test('non-existent queue file returns empty array', () => {
    setup();
    const results = readQueue(path.join(tmpDir, 'does-not-exist.jsonl'), 0);
    assert.equal(results.length, 0);
    teardown();
  });
});

describe('Queue reading - force:true entries', () => {
  let tmpDir, queueFile;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-test-'));
    queueFile = path.join(tmpDir, 'tg-queue-test.jsonl');
  }
  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test('delivers negative-id force:true entries always', () => {
    setup();
    const entry = {
      message_id: -1700000000,
      user: 'scheduler',
      text: 'Stand-up time!',
      ts: Math.floor(Date.now() / 1000),
      via: 'scheduler',
      force: true,
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const results = readQueue(queueFile, 0);
    assert.equal(results.length, 1);
    assert.equal(results[0].text, 'Stand-up time!');
    teardown();
  });

  test('does not deliver negative-id entries WITHOUT force:true', () => {
    setup();
    const entry = {
      message_id: -1700000001,
      user: 'system',
      text: 'no force flag',
      ts: Math.floor(Date.now() / 1000),
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const results = readQueue(queueFile, 0);
    assert.equal(results.length, 0);
    teardown();
  });

  test('button callbacks (negative id + force) are always delivered', () => {
    setup();
    const now = Math.floor(Date.now() / 1000);
    const entry = {
      message_id: -(now % 2147483647),
      user: 'Alice',
      user_id: 12345,
      text: 'Yes',
      ts: now,
      via: 'callback',
      force: true,
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const results = readQueue(queueFile, 999999); // high lastId
    assert.equal(results.length, 1);
    assert.equal(results[0].via, 'callback');
    teardown();
  });

  test('force:true entries delivered even when lastId is very high', () => {
    setup();
    const entry = {
      message_id: -42,
      user: 'peer',
      text: 'peer message',
      ts: Math.floor(Date.now() / 1000),
      via: 'peer',
      force: true,
    };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const results = readQueue(queueFile, 2147483647); // max int32
    assert.equal(results.length, 1);
    teardown();
  });
});

describe('Queue reading - message_id deduplication', () => {
  let tmpDir, queueFile;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-test-'));
    queueFile = path.join(tmpDir, 'tg-queue-dedup.jsonl');
  }
  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  test('duplicate positive message_id only delivered once', () => {
    setup();
    const entry = { message_id: 100, user: 'alice', text: 'dup', ts: 1 };
    // Write same entry twice (simulates bot restart rewriting queue)
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const seen = new Set();
    const results = readQueue(queueFile, 0, seen);
    assert.equal(results.length, 1, 'should deduplicate same message_id');
    teardown();
  });

  test('duplicate negative force:true entries only delivered once', () => {
    setup();
    const entry = { message_id: -777, user: 'scheduler', text: 'sched', ts: 1, force: true };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const seen = new Set();
    const results = readQueue(queueFile, 0, seen);
    assert.equal(results.length, 1, 'should deduplicate duplicate force entries');
    teardown();
  });

  test('seen set persists across calls (simulates session state)', () => {
    setup();
    const entry = { message_id: 200, user: 'bob', text: 'hi', ts: 1 };
    fs.appendFileSync(queueFile, JSON.stringify(entry) + '\n');

    const seen = new Set();
    const first = readQueue(queueFile, 0, seen);
    assert.equal(first.length, 1);

    // Second call with same seen set — should not re-deliver
    const second = readQueue(queueFile, 0, seen);
    assert.equal(second.length, 0, 'already-seen messages should not be re-delivered');
    teardown();
  });

  test('mixed: regular + force, only new ones delivered', () => {
    setup();
    const entries = [
      { message_id: 50,  user: 'a', text: 'regular old', ts: 1 },
      { message_id: 100, user: 'b', text: 'regular new', ts: 2 },
      { message_id: -1,  user: 'scheduler', text: 'forced', ts: 3, force: true },
    ];
    for (const e of entries) fs.appendFileSync(queueFile, JSON.stringify(e) + '\n');

    const results = readQueue(queueFile, 50); // lastId=50 — skip id<=50
    assert.equal(results.length, 2); // id:100 and id:-1(force)
    const texts = results.map(r => r.text);
    assert.ok(texts.includes('regular new'));
    assert.ok(texts.includes('forced'));
    teardown();
  });
});
