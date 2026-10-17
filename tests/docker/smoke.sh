#!/usr/bin/env bash
# Docker smoke test: builds the image, runs it, and checks health, a real
# WebSocket auth + signed publish round trip, non-root user, graceful
# SIGTERM shutdown and the docker compose setup.
#   tests/docker/smoke.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
IMAGE=dynamicsocket:smoke
NAME=dynamicsocket-smoke
PORT=6301
SECRET=docker-smoke-secret-0123456789abcdef012345
APPS='[{"id":"shop","keys":[{"id":"k1","secretEnv":"DS_SHOP_SECRET_K1"}],"allowedOrigins":["http://localhost:8000"],"publicChannels":["online"],"presenceChannels":["online"]}]'
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker compose -p dssmoke down >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
pass() { printf '  \342\234\224 %s\n' "$1"; }

echo "▶ Building image"
docker build -q -t "$IMAGE" . >/dev/null
pass "image built ($(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1e6}'))"

echo "▶ Running container"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:6001" \
  -e DS_APPS_JSON="$APPS" -e DS_SHOP_SECRET_K1="$SECRET" -e DS_LOG_LEVEL=info "$IMAGE" >/dev/null
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.2; done
curl -fs "http://127.0.0.1:$PORT/healthz" | grep -q '"status":"ok"'
pass "/healthz ok"
[ "$(docker exec "$NAME" id -un)" = "node" ] && pass "runs as non-root user 'node'"
for _ in $(seq 1 40); do
  [ "$(docker inspect "$NAME" --format '{{.State.Health.Status}}')" = "healthy" ] && break; sleep 1
done
[ "$(docker inspect "$NAME" --format '{{.State.Health.Status}}')" = "healthy" ] && pass "Docker HEALTHCHECK reports healthy"
docker exec "$NAME" sh -c 'test ! -d /app/tests && test ! -e /app/.env && test ! -d /app/node_modules/eslint' && pass "no tests, .env or dev dependencies in the image"

echo "▶ WebSocket round trip against the container"
DS_APPS_JSON="$APPS" DS_SHOP_SECRET_K1="$SECRET" PORT="$PORT" node --input-type=module -e '
import WebSocket from "ws";
import { loadConfig } from "./src/config/index.js";
import { createClientToken } from "./src/auth/client-token.js";
import { signRequest } from "./src/auth/request-signature.js";
const config = loadConfig(process.env);
const key = config.apps[0].keys[0];
const base = `127.0.0.1:${process.env.PORT}`;
const ws = new WebSocket(`ws://${base}/ws?app=shop`, { origin: "http://localhost:8000" });
const timer = setTimeout(() => { console.error("timeout"); process.exit(1); }, 5000);
ws.on("message", async (raw) => {
  const m = JSON.parse(raw);
  if (m.type === "hello") ws.send(JSON.stringify({ type: "auth", token: createClientToken({ appId: "shop", sub: "1", channels: ["orders"], user: { name: "Docker" }, keyId: key.id, secret: key.secret }) }));
  if (m.type === "auth_ok") { ws.send(JSON.stringify({ type: "subscribe", channel: "orders" })); ws.send(JSON.stringify({ type: "subscribe", channel: "online" })); }
  if (m.type === "subscribed" && m.channel === "online") {
    if (m.presence.members[0].info.name !== "Docker") process.exit(1);
    const body = JSON.stringify({ channel: "orders", event: "order.created", data: { id: 7 } });
    const headers = signRequest({ method: "POST", path: "/v1/publish", body, appId: "shop", keyId: key.id, secret: key.secret });
    const res = await fetch(`http://${base}/v1/publish`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body });
    if (res.status !== 200) { console.error(await res.text()); process.exit(1); }
  }
  if (m.type === "event" && m.data.id === 7) { clearTimeout(timer); ws.close(); }
});
ws.on("close", () => process.exit(0));
'
pass "auth, presence and signed publish work through the published port"

echo "▶ Graceful shutdown"
START=$(date +%s)
docker stop -t 15 "$NAME" >/dev/null
EXIT=$(docker inspect "$NAME" --format '{{.State.ExitCode}}')
[ "$EXIT" = "0" ] && pass "SIGTERM -> exit code 0 in $(( $(date +%s) - START ))s"
docker logs "$NAME" 2>&1 | grep -q '"msg":"shutdown complete"' && pass "logs show graceful shutdown"
! docker logs "$NAME" 2>&1 | grep -q "$SECRET" && pass "secret not in container logs"

echo "▶ docker compose"
cp .env.example "$WORK/.env"
echo "DS_SHOP_SECRET_K1=$SECRET" >> "$WORK/.env"
echo "$APPS" > "$WORK/apps.json"
cp docker-compose.yml Dockerfile .dockerignore package.json package-lock.json "$WORK/"
cp -r src sdk "$WORK/"
sed -i "s/127.0.0.1:6001:6001/127.0.0.1:$PORT:6001/" "$WORK/docker-compose.yml"
(cd "$WORK" && docker compose -p dssmoke up -d --build --quiet-pull >/dev/null 2>&1)
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.2; done
curl -fs "http://127.0.0.1:$PORT/healthz" | grep -q '"status":"ok"' && pass "docker compose up: healthy with mounted apps.json and .env"
(cd "$WORK" && docker compose -p dssmoke down >/dev/null 2>&1)
pass "docker compose down"

echo
echo "DOCKER SMOKE TEST PASSED"
