# paperless-middleware

Reads an incoming correlation id header (or generates a new v4 UUID) and attaches it to `req.correlationId`, `req.correlationContext`, and a response header.

```js
import { createCorrelationIdMiddleware } from 'paperless-middleware';

const correlationId = createCorrelationIdMiddleware({
  header: 'x-correlation-id',
  responseHeader: 'x-correlation-id',
});

function handler(req, res, next) {
  correlationId(req, res, next);
  // req.correlationId is now a string you can log or pass downstream
  console.log(req.correlationId);
}
```

## Why this exists

Distributed services need a single id threaded through every log line and propagated in the response so callers can correlate their request with server-side traces. Doing this inline in every handler is noisy and inconsistent; a single middleware that normalizes the behavior is the boring, correct answer.

The trade-off: this library is deliberately small and inflexible. It generates RFC 4122 v4 UUIDs only — no caller-supplied id generator, no snowflake ids, no sequential counters. If you need a different id scheme, wrap the middleware and override the header afterward.

## Edge cases

The middleware sanitizes incoming header values before trusting them. An id containing CR/LF characters (a header-injection vector), NUL bytes, other ASCII control characters, or exceeding 200 bytes is discarded and replaced with a fresh UUID. Surrounding whitespace is trimmed from accepted values. An empty or whitespace-only header also triggers generation. The frozen `req.correlationContext` object prevents downstream handlers from silently mutating the correlation id for the current request.
