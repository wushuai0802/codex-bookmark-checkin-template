FROM node:24-alpine

ENV NODE_ENV=production \
    FABRIC_BIND=0.0.0.0 \
    FABRIC_PORT=8787 \
    FABRIC_DATA_DIR=/data \
    FABRIC_ADMIN_TOKEN_FILE=/run/secrets/fabric_admin_token \
    FABRIC_TRUST_PROXY_TLS=1

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/dashboard-server.mjs"]
