import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCorrelationIdMiddleware,
  DEFAULT_HEADER,
  DEFAULT_RESPONSE_HEADER,
} from '../src/core.js';

/**
 * Minimal fake request object shaped like Node's IncomingMessage for the parts
 * this middleware touches: a `headers` object and a place to store attachments.
 */
function fakeReq(headers = {}) {
  return { headers };
}

/**
 * Minimal fake response that records setHeader calls in a map, so tests can
 * assert on them deterministically without spinning up a real http.Server.
 */
function fakeRes() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
  };
}

test('generates a uuid when no incoming header is present', () => {
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq();
  const res = fakeRes();
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(typeof req.correlationId, 'string');
  assert.match(req.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(req.correlationContext.correlationId, req.correlationId);
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), req.correlationId);
});

test('uses incoming header when present and well-formed', () => {
  const middleware = createCorrelationIdMiddleware();
  const incoming = 'abc-123-request-id';
  const req = fakeReq({ [DEFAULT_HEADER]: incoming });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.equal(req.correlationId, incoming);
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), incoming);
});

test('incoming header is case-insensitive on the request side', () => {
  // Node normalizes to lowercase, so a caller asking for 'X-Correlation-Id' must still
  // find a value stored under the lowercase key. We pass the key as given to the options.
  const middleware = createCorrelationIdMiddleware({ header: 'X-Correlation-Id' });
  const req = fakeReq({ 'x-correlation-id': 'case-test-42' });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.equal(req.correlationId, 'case-test-42');
});

test('falls back to a generated id when incoming header is empty string', () => {
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq({ [DEFAULT_HEADER]: '   ' });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.match(req.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('falls back to a generated id when incoming header contains a newline', () => {
  // CR/LF in a header value is a header-injection vector; we must reject it.
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq({ [DEFAULT_HEADER]: 'evil\r\nX-Injected: yes' });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.match(req.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), req.correlationId);
  // Ensure nothing resembling the injected header leaked through.
  assert.equal(res.getHeader('x-injected'), undefined);
});

test('falls back to a generated id when incoming header contains a NUL byte', () => {
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq({ [DEFAULT_HEADER]: 'bad\u0000value' });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.match(req.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('falls back to a generated id when incoming header is excessively long', () => {
  const middleware = createCorrelationIdMiddleware();
  const tooLong = 'a'.repeat(201);
  const req = fakeReq({ [DEFAULT_HEADER]: tooLong });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.match(req.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(req.correlationId, tooLong);
});

test('accepts an incoming id exactly at the maximum length', () => {
  const middleware = createCorrelationIdMiddleware();
  const atLimit = 'a'.repeat(200);
  const req = fakeReq({ [DEFAULT_HEADER]: atLimit });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.equal(req.correlationId, atLimit);
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), atLimit);
});

test('respects a custom request and response header name', () => {
  const middleware = createCorrelationIdMiddleware({
    header: 'X-Request-Id',
    responseHeader: 'X-Trace-Id',
  });
  const req = fakeReq({ 'x-request-id': 'trace-99' });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.equal(req.correlationId, 'trace-99');
  assert.equal(res.getHeader('x-trace-id'), 'trace-99');
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), undefined);
});

test('correlationContext is frozen and cannot be mutated', () => {
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq();
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.equal(Object.isFrozen(req.correlationContext), true);
  assert.throws(() => { req.correlationContext.correlationId = 'tampered'; }, TypeError);
});

test('still sets the response header when next is omitted', () => {
  // Some ad-hoc call sites invoke middleware without a next function. We must not throw.
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq({ [DEFAULT_HEADER]: 'no-next-1' });
  const res = fakeRes();
  assert.doesNotThrow(() => middleware(req, res));
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), 'no-next-1');
});

test('trims surrounding whitespace from an accepted incoming id', () => {
  const middleware = createCorrelationIdMiddleware();
  const req = fakeReq({ [DEFAULT_HEADER]: '  trimmed-id-7  ' });
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.equal(req.correlationId, 'trimmed-id-7');
});

test('handles a request with no headers object at all', () => {
  const middleware = createCorrelationIdMiddleware();
  const req = {};
  const res = fakeRes();
  middleware(req, res, () => {});

  assert.match(req.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(res.getHeader(DEFAULT_RESPONSE_HEADER), req.correlationId);
});
