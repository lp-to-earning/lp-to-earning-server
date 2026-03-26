#!/bin/sh
set -e
# 기존 볼륨 DB는 마이그레이션 히스토리 없이 생긴 경우가 많아 deploy가 실패할 수 있음 → 그때는 db push로 컬럼 누락(isActive 등) 보정
npx prisma migrate deploy 2>/dev/null || true
npx prisma db push --skip-generate
exec node dist/index.js
