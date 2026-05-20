ARG DOCKER_BASE_REGISTRY=docker.m.daocloud.io/library
ARG NPM_REGISTRY=https://mirrors.huaweicloud.com/repository/npm/

FROM ${DOCKER_BASE_REGISTRY}/node:22-alpine AS builder

WORKDIR /app

RUN npm config set registry ${NPM_REGISTRY} \
  && npm config set replace-registry-host always \
  && npm config set audit false \
  && npm config set fund false

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

COPY . .
RUN npm run build

FROM ${DOCKER_BASE_REGISTRY}/nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
