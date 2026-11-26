# The operator image. No build step: Node 24 runs the TypeScript directly,
# stripping its types. One dependency, the AHP client.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
# Where Kubernetes mounts the service account's CA: fetch() trusts the API
# server through it.
ENV NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
ENV NODE_OPTIONS=--dns-result-order=ipv4first
USER node
ENTRYPOINT ["node", "/app/src/main.ts"]
