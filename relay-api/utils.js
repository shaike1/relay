'use strict';
/**
 * utils.js — Pure logic functions extracted from server.js for testability.
 * Imported by server.js and used directly in tests.
 */

// --- Rate limiter: 30 messages per minute per user ---
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

/**
 * Create a fresh rate-limiter instance (own Map, so tests can isolate state).
 * Returns { checkRateLimit(userId) → boolean }
 */
function createRateLimiter(max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  const map = new Map(); // userId → number[]
  return {
    check(userId) {
      const now = Date.now();
      const timestamps = (map.get(userId) || []).filter(t => now - t < windowMs);
      if (timestamps.length >= max) {
        map.set(userId, timestamps);
        return false; // rate limited
      }
      timestamps.push(now);
      map.set(userId, timestamps);
      return true; // allowed
    },
    _map: map, // exposed for testing
  };
}

// --- Cron helpers ---

/**
 * Test whether a single cron field matches a value.
 * Supports: *, /step, lo-hi, comma list, exact number.
 */
function parseCronField(field, value, min, max) {
  if (field === '*') return true;
  if (field.includes('/')) {
    const [, step] = field.split('/');
    return value % parseInt(step) === 0;
  }
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map(Number);
    return value >= lo && value <= hi;
  }
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  return parseInt(field) === value;
}

/**
 * Test whether a 5-field cron expression matches a Date object.
 */
function cronMatches(cronExpr, date) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    parseCronField(min,  date.getMinutes(),  0, 59) &&
    parseCronField(hour, date.getHours(),    0, 23) &&
    parseCronField(dom,  date.getDate(),     1, 31) &&
    parseCronField(mon,  date.getMonth() + 1, 1, 12) &&
    parseCronField(dow,  date.getDay(),      0,  6)
  );
}

// --- Multi-tenant thread resolver ---

/**
 * Resolve effective thread_id for multi-tenant sessions.
 * @param {string|number} threadId   The telegram thread_id from the session topic.
 * @param {string|number} userId     The sender's Telegram user_id.
 * @param {string}        userName   Display name for the user.
 * @param {object}        opts
 * @param {Function}      opts.readSessions  () → parsed sessions array
 * @param {Function}      opts.readMap       (threadId) → object (or throws)
 * @param {Function}      opts.writeMap      (threadId, map) → void
 * @returns {string|number} effectiveThreadId
 */
function resolveMultiTenantThread(threadId, userId, userName, opts = {}) {
  const { readSessions, readMap, writeMap } = opts;
  try {
    const sessions = readSessions();
    const session = sessions.find(s => String(s.thread_id) === String(threadId));
    if (!session || !session.multi_tenant) return threadId;

    let map = {};
    try { map = readMap(threadId); } catch (_) {}

    if (!map[userId]) {
      const existing = Object.values(map);
      const idx = existing.length + 1;
      map[userId] = { virtual_thread: parseInt(threadId) * 10000 + idx, name: userName };
      writeMap(threadId, map);
    }
    return map[userId].virtual_thread;
  } catch (_) {
    return threadId;
  }
}

// --- Command parser ---

/**
 * Parse a Telegram message text and return the recognised command name,
 * or null if it's not a relay command.
 * Works with or without @BotName suffix.
 */
function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const clean = text.trim();
  const m = clean.match(/^\/([a-z_]+)(@\S+)?(\s|$)/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

module.exports = {
  createRateLimiter,
  parseCronField,
  cronMatches,
  resolveMultiTenantThread,
  parseCommand,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
};
