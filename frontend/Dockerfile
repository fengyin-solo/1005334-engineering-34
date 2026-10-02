FROM node:20-alpine
WORKDIR /srv/web
# 按锁文件装载：镜像里的依赖与仓库锁定的版本一致，重复构建不产生漂移
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
