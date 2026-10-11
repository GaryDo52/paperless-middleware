/**
 * Default name of the request header that may carry an incoming correlation id.
 * Case-insensitive per HTTP semantics, but normalized to lowercase for lookup.
 */
export const DEFAULT_HEADER = 'x-correlation-id';

/**
 * Default name of the response header that echoes the correlation id back to the
 * caller. Also normalized to lowercase.
 */
export const DEFAULT_RESPONSE_HEADER = 'x-correlation-id';

/**
 * Upper bound on the length of an *incoming* correlation id we will accept and
 * forward. This guards against clients that send absurdly long header values,
 * which some log aggregators and proxies choke on. Generated UUIDs are always
 * well under this limit.
 */
const MAX_INCOMING_LENGTH = 200;

/**
 * Fast, dependency-free RFC 4122 v4 UUID generator using crypto.getRandomValues.
 * Falls back to crypto.randomUUID when available (Node 19+ and modern browsers)
 * since it is a single native call rather than several.
 *
 * The fallback exists so the library works on runtimes that lack randomUUID
 * but do expose the Web Crypto getRandomValues (older Node, some edge runtimes).
 *
 * @returns {string} A lowercase UUID v4 string.
 */
function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Minimal v4 UUID via getRandomValues. Works on Node 16+ (global crypto) and browsers.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // RFC 4122 §4.4: set version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Normalizes a header name to lowercase and trims surrounding whitespace.
 * HTTP header names are case-insensitive, and Node's req.headers object already
 * lowercases keys, so we enforce lowercase consistently to avoid silent misses
 * when a caller passes 'X-Correlation-Id'.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeHeaderName(name) {
  return String(name).trim().toLowerCase();
}

/**
 * Sanitizes an incoming correlation id header value.
 *
 * We deliberately reject values containing CR/LF characters and other ASCII
 * control bytes. Such characters in a response header can enable header
 * injection if echoed verbatim, and they serve no legitimate purpose in an
 * identifier. We also reject overlong values to protect downstream systems.
 *
 * Returns null when the value should be discarded and a fresh id generated.
 *
 * @param {string|undefined} value
 * @returns {string|null}
 */
function sanitizeIncoming(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (str === '') return null;
  if (str.length > MAX_INCOMING_LENGTH) return null;
  // Reject any byte < 0x20 (control chars, including CR/LF) or DEL (0x7F).
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return str;
}

/**
 * Creates a correlation-id middleware compatible with the Node.js http module's
 * (req, res) convention and common frameworks like Express that expose the same
 * signature.
 *
 * ## Design decision: header name only, no generator override
 * The brief says "reads an incoming header or generates a new uuid". We expose
 * the header name as an option but do NOT accept a custom id generator. Allowing
 * a caller-supplied generator would invite non-uuid, non-deterministic ids and
 * make the "generates a new uuid" guarantee meaningless. If you need a different
 * id format, wrap the middleware and post-process the header.
 *
 * ## Context attachment
 * The resolved id is attached to `req.correlationId` (a plain string property)
 * and also stored on `req.correlationContext` as a frozen object. We freeze it so
 * downstream handlers cannot mutate the single source of truth for this request.
 *
 * ## Behavior
 * 1. Look up the configured request header (case-insensitive) on req.headers.
 * 2. If present and sane, use it. Otherwise generate a new v4 UUID.
 * 3. Attach to req.correlationId and req.correlationContext.
 * 4. Set the response header (case-insensitive name).
 * 5. Call next() — synchronous, matching Express-style middleware. The response
 *    header is set before next() so it is available even if downstream code throws.
 *
 * @param {object} [options]
 * @param {string} [options.header=DEFAULT_HEADER] Request header to read from.
 * @param {string} [options.responseHeader=DEFAULT_RESPONSE_HEADER] Response header to set.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: Function) => void}
 */
export function createCorrelationIdMiddleware(options = {}) {
  const headerName = normalizeHeaderName(options.header ?? DEFAULT_HEADER);
  const responseHeaderName = normalizeHeaderName(options.responseHeader ?? DEFAULT_RESPONSE_HEADER);

  return function correlationIdMiddleware(req, res, next) {
    // Node lowercases header keys, so a plain lookup on the normalized name is sufficient
    // and avoids Header prototype pitfalls that some frameworks introduce.
    const incoming = req && typeof req.headers === 'object'
      ? req.headers[headerName]
      : undefined;

    const sanitized = sanitizeIncoming(incoming);
    const correlationId = sanitized ?? generateUuid();

    // Attach to the request object. req may be a plain object in some test harnesses,
    // so we guard rather than assume an IncomingMessage instance.
    if (req && typeof req === 'object') {
      req.correlationId = correlationId;
      req.correlationContext = Object.freeze({ correlationId });
    }

    // Set the response header before calling next(). This ensures the header is present
    // even if a downstream handler throws synchronously, which is the whole point of
    // putting correlation on the response at the middleware layer.
    if (res && typeof res.setHeader === 'function') {
      res.setHeader(responseHeaderName, correlationId);
    }

    if (typeof next === 'function') {
      next();
    }
  };
}
