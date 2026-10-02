# 多阶段镜像：
# - build 阶段装依赖、过类型检查、产出生产构建；
# - runtime 阶段只用 nginx 托管静态产物，镜像里不含源码与 node_modules。
# 定稿闸门（make gate / scripts/release-gate.mjs）在本地与 CI 先跑，
# 这里镜像内再跑一次类型检查兜底，保证配置与构建产物一致。
FROM node:20-alpine AS build
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/web/dist /usr/share/nginx/html
EXPOSE 80

# 开发态目标：docker compose --profile dev up frontend-dev
FROM node:20-alpine AS dev
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
