FROM node:20-slim AS builder

WORKDIR /app

# 1. 빌드 도구 및 라이브러리 설치
RUN apt-get update && apt-get install -y openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
RUN npx prisma generate

# 2. 소스 코드 빌드 (TypeScript -> JavaScript)
COPY . .
RUN npm run build

# --- 실행 단계 ---
FROM node:20-slim

# Prisma 엔진 실행에 필요한 라이브러리 설치
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 3. 필요한 실행 파일만 복사
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# 4. byreal-cli 설치 (서버 내에서 봇 구동용)
RUN npm install -g @byreal-io/byreal-cli

# 5. 환경 변수 기본값
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["npm", "run", "start"]
