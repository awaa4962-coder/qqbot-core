FROM node:22.23.2-bookworm-slim

ARG PIP_INDEX_URL=https://pypi.org/simple

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/qqfriend-venv/bin:$PATH \
    NODE_ENV=production \
    TZ=Asia/Shanghai

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-noto-cjk \
      python3 \
      python3-venv \
      tini \
    && python3 -m venv /opt/qqfriend-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force

COPY scripts/requirements-jm.txt ./scripts/requirements-jm.txt
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r scripts/requirements-jm.txt

COPY bridge ./bridge
COPY scripts ./scripts
COPY napcat_bridge.mjs daily_summary.mjs ./
COPY package.json CHANGELOG.md README.md ./
COPY launcher/QQFriendLauncher/Web ./launcher/QQFriendLauncher/Web

RUN mkdir -p /config /data /logs /tmp/qqfriend \
    && chown -R node:node /config /data /logs /tmp/qqfriend

USER node

ENV QQBOT_CONFIG_ROOT=/config \
    QQBOT_DATA_DIR=/data \
    QQBOT_LOG_DIR=/logs \
    QQBOT_TEMP_DIR=/tmp/qqfriend \
    TMPDIR=/tmp/qqfriend \
    QQBOT_JM_PYTHON=python

EXPOSE 16789

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:16789/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "napcat_bridge.mjs"]
