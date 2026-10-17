# DynamicSocket container image (single process, in-memory state).
FROM node:24-alpine

ENV NODE_ENV=production \
    DS_HOST=0.0.0.0 \
    DS_PORT=6001

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY sdk ./sdk

USER node
EXPOSE 6001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:6001/healthz >/dev/null || exit 1
CMD ["node", "src/server.js"]
