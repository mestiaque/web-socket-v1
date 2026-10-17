# Load-test plan

`scripts/loadtest.js` drives a running DynamicSocket with real WebSocket
clients and signed publish requests, then reports connection, publish and
end-to-end latency statistics as JSON.

## Parameters

| Flag | Default | Meaning |
|---|---|---|
| `--app` | required | App id (its first key is used to mint tokens / sign) |
| `--url` | `http://127.0.0.1:6001` | Server HTTP base URL |
| `--ws-url` | derived | WebSocket URL (without `?app=`) |
| `--origin` | app's first allowed origin | Origin header for clients |
| `--clients` | 100 | Concurrent WebSocket clients |
| `--channels` | 1 | Channels; client *i* subscribes to `loadtest.(i mod channels)` |
| `--rate` | 10 | Publish requests per second (round-robin across channels) |
| `--size` | 256 | Approximate event payload size in bytes |
| `--duration` | 10 | Publishing duration in seconds |
| `--connect-concurrency` | 50 | Clients connecting in parallel during ramp-up |

Fan-out per publish = `clients / channels`. Frames per second ≈
`rate × clients / channels`.

## Server configuration for load tests

All simulated clients come from one IP, so raise the per-IP limits and the
publish rate:

```dotenv
DS_MAX_CONNECTIONS_PER_IP=100000
DS_UPGRADES_PER_IP_PER_MIN=1000000
DS_PUBLISH_RATE_PER_SEC=100000
DS_PUBLISH_RATE_BURST=100000
DS_LOG_LEVEL=warn
```

The load generator mints tokens with the app secret: run it only against
environments you control.

## Procedure

1. Start the server on the target machine (`npm start`), ideally with the
   load generator on a **different machine** so they do not compete for CPU.
2. Raise `ulimit -n` on both sides above the client count.
3. Run a matrix, e.g.:

   ```bash
   for clients in 100 1000 5000; do
     for rate in 10 100; do
       npm run -s loadtest -- --app shop --url http://SERVER:6001 \
         --clients $clients --channels 10 --rate $rate --size 512 --duration 60 \
         > results-$clients-$rate.json
     done
   done
   ```

4. Record server RSS (`ps -o rss= -p <pid>`) and CPU during each run, plus
   `/metrics` (`ds_frames_dropped_total`, `ds_slow_consumer_disconnects_total`).
5. Pass criteria to define for your workload, e.g. `framesReceived ==
   framesReportedSent`, publish p99 < 50 ms, end-to-end p99 < 250 ms,
   no unexpected closes.

Interpretation:

- `publishing.httpLatencyMs` includes the synchronous fan-out to local
  sockets (the in-memory bus delivers inside the request).
- `delivery.endToEndLatencyMs` = client receive time − publish send time,
  measured on the generator's clock (both ends on one machine, so no clock
  skew). With one generator process receiving every frame, the generator's
  own event loop often dominates this number at high fan-out.
- `framesReceived < framesReportedSent` means frames were lost after
  `ws.send()` (connection died) or the 1 s drain wait was too short.

## Measured results

Environment: Intel Core i5-8350U (4 cores / 8 threads, 1.7 GHz), Linux
6.8.0, Node.js 20.18.1, server and load generator **on the same machine**
(they compete for CPU), loopback networking, no TLS, `DS_LOG_LEVEL=warn`.
Measured 2026-10-16. These are single runs on a laptop, not a capacity
guarantee; repeat on your hardware.

| Scenario | Clients / channels | Rate × size × duration | Connected | Publish errors | Frames sent → received | Publish HTTP p50 / p95 / p99 | End-to-end p50 / p95 / p99 / max | Server RSS at end |
|---|---|---|---|---|---|---|---|---|
| A | 1000 / 10 (fan-out 100) | 100/s × 512 B × 15 s | 1000 / 1000 in 623 ms | 0 | 150 000 → 150 000 | 2.8 / 3.7 / 6.2 ms | 2 / 3 / 4 / 64 ms | ~81 MB |
| B | 3000 / 1 (fan-out 3000) | 20/s × 1 KB × 15 s | 3000 / 3000 in 1409 ms | 0 | 900 000 → 900 000 | 48.5 / 54.4 / 130.4 ms | 25 / 47 / 104 / 173 ms | ~173 MB |

Not measured: TLS termination cost, cross-machine latency, more than 3000
connections, long-duration (hours) memory stability, behaviour behind
cPanel/Passenger.
