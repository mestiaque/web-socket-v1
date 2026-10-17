# Release checklist

## Before tagging

- [ ] `npm ci` on a clean checkout
- [ ] `npm run lint` passes
- [ ] `npm test` passes on every supported Node version (CI matrix: 22, 24)
- [ ] `npm audit --omit=dev` reports no vulnerabilities
- [ ] `npm outdated` reviewed; `ws` on the latest 8.x patch
- [ ] PHP contract test ran (not skipped) — requires `php` on the runner
- [ ] `npm run test:e2e:setup -- /tmp/ds-laravel && npm run test:e2e -- /tmp/ds-laravel` passes
- [ ] `find examples/laravel -name '*.php' -exec php -l {} \;` clean
- [ ] Load test re-run if delivery/connection code changed; docs/LOADTEST.md updated with real numbers only
- [ ] Version bumped in `package.json`; API.md version header updated
- [ ] Docs match behaviour: close codes, error codes, limits, delivery semantics
- [ ] `THIRD_PARTY_NOTICES.md` matches `package-lock.json`
- [ ] No secrets in the repository (`git grep -nE "secret\"\\s*:\\s*\"[^\"]{20,}"` shows only test fixtures)
- [ ] `npm run test:docker` passes (image build, healthcheck, round trip, graceful stop, compose)

## Deployment

- [ ] `DS_HOST=127.0.0.1` behind a TLS-terminating proxy; only `wss://`/`https://` exposed
- [ ] Secrets via `secretEnv`, files `chmod 600`/`640`
- [ ] `allowedOrigins` exact; `allowMissingOrigin` only for non-browser apps
- [ ] `DS_TRUSTED_PROXIES` set only to proxies that overwrite `X-Forwarded-For`
- [ ] `DS_METRICS_TOKEN` set if metrics are scraped; `/metrics` not publicly routed
- [ ] Single process confirmed (`instanceId` constant across `/healthz` calls)
- [ ] Clocks NTP-synced on Laravel and DynamicSocket hosts
- [ ] Laravel token endpoint behind auth + throttle; returns `Cache-Control: no-store`
- [ ] Logout listener registered; `/v1/disconnect` reachable from Laravel
