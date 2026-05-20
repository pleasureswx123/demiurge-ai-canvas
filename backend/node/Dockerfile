ARG DOCKER_BASE_REGISTRY=docker.m.daocloud.io/library
ARG NPM_REGISTRY=https://mirrors.huaweicloud.com/repository/npm/

FROM ${DOCKER_BASE_REGISTRY}/node:22-alpine

WORKDIR /app/backend/node

ENV NODE_ENV=production

RUN npm config set registry ${NPM_REGISTRY} \
  && npm config set replace-registry-host always \
  && npm config set audit false \
  && npm config set fund false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

COPY src ./src

EXPOSE 3200

CMD ["npm", "start"]
