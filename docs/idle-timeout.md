# Idle Connections and the Connection Sweeper

Hushgate's HTTP server carries a small connection sweeper whose job is to bound
how long a connection may squat on a file descriptor without making progress.
This page explains what it bounds, what it deliberately does not, and what
operators should know when running the proxy in front of real traffic.

The implementation lives in `src/proxy/server.ts` (roughly lines 458–565).

## Why Node's built-in timeouts are not enough

Node exposes two knobs that sound like they should cover this:

- `server.requestTimeout` — re-checked only at request boundaries.
- `server.headersTimeout` — pushed forward by every arriving byte.

Both are polled on an interval of their own. A client that connects and then
says nothing at all is reaped by neither; neither is one that drips a single
byte every few hundred milliseconds to keep `headersTimeout` restamping itself
forever. Hushgate still sets both knobs (`requestTimeout` from
`limits.requestTimeoutMs`, `headersTimeout` capped at 60 s) because they cost
nothing — but the sweeper is what actually bounds a hostile connection.

## Configuration

| Setting | Meaning |
| --- | --- |
| `limits.idleTimeoutMs` | How long a connection may sit with nothing happening before it is destroyed. **Default: `60000`** (60 seconds). Must be a positive integer; `0` is rejected. |
| `HUSHGATE_IDLE_TIMEOUT_MS` | Environment override. Same positive-integer rule; invalid values fail config parsing. |
| `limits.requestTimeoutMs` | How long a *request in progress* may take the client to deliver (headers + body). Unrelated to idle pooling — see [What requestTimeoutMs does and does not bound](#what-requesttimeoutms-does-and-does-not-bound). |

## The three phases

Every accepted socket is tracked as `{ phase, since }`, where `since` is the
moment it entered its current phase:

1. **`idle`** — nobody's turn. Either the socket was just accepted and has sent
   nothing yet, or a finished response has returned it to the keep-alive pool.
   Budget: `idleTimeoutMs`.
2. **`receiving`** — the client's turn. Request headers have arrived but the
   body has not finished. The clock is stamped once when the request starts and
   is **never restamped by incoming data** — restamping is exactly what would
   let a slow-drip request live forever. Budget: `requestTimeoutMs`.
3. **`serving`** — hushgate's turn. The request body is complete and the proxy
   is waiting on / streaming from upstream. **Deliberately unbounded by the
   sweeper.**

### Why serving is deliberately unbounded

A model can think in silence for minutes before the first SSE token arrives,
and an upstream request mid-retry-backoff is silent for longer still. Reaping
on wire silence alone would kill legitimate streaming responses — which is why
a plain `socket.setTimeout()` is not sufficient here. What eventually bounds
the serving phase is `upstreamTimeoutMs`, applied one layer down against the
upstream call itself, not against socket quiet.

## How the sweep works

- One `setInterval` for the whole server, not a timer per socket — a per-socket
  timer would hand every squatting connection its own allocation, the same
  amplification the sweeper exists to prevent. The interval is derived from
  `min(1s, max(25ms, min(idleTimeoutMs, requestTimeoutMs) / 4))`.
- On each tick, any socket in `idle` or `receiving` whose elapsed time exceeds
  its phase budget is destroyed. Sockets in `serving` are skipped.
- The timer is `unref()`'d so it can never keep a CLI process alive.
- Phase transitions are wired with a **prepended** `request` listener so the
  phase is correct even for requests served synchronously; `response.finish`
  and `response.close` both return the socket to `idle`.

## What requestTimeoutMs does and does not bound

`requestTimeoutMs` bounds **processing of the incoming request** — how long the
client may take to finish sending headers and body. It is not a cap on
wire-silence during the answer: once the body is complete and the response is
in flight, no sweeper budget applies. A long model "thinking" pause inside a
streamed response is expected and will not be reaped.

## Operator guidance

- **File descriptors:** every pooled or half-open connection holds an fd until
  the sweeper destroys it. Make sure the process's `ulimit -n` (nofile) is well
  above your expected concurrency plus headroom for the full
  `idleTimeoutMs` window — e.g. `ulimit -n 65536` or the equivalent in your
  service unit / container limits. A low nofile turns a slow-loris style
  squatter into an outage even though the sweeper is doing its job.
- **Load-balancer idle timeouts:** anything in front of the proxy (ALB/NLB,
  nginx, Envoy) has its own idle timeout. Keep it comfortably shorter than
  Hushgate's `idleTimeoutMs` if you want the LB, not hushgate, to be the one
  closing dead keep-alives — otherwise clients may race a reset mid-request.
  Conversely, do not set the LB timeout longer than `idleTimeoutMs`: the proxy
  will close connections out from under healthy-looking pooled sessions.
- **Streaming responses:** do not try to shorten perceived latency budgets by
  lowering `idleTimeoutMs` below typical model time-to-first-token. Idle
  timeout never applies while a response is being served, so there is no need
  to raise it for that reason either.
