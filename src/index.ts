import express from "express";
import cors from "cors";
import "dotenv/config";
import authRouter from "./api/auth";
import mainRouter from "./api/main";
import { runBotTask } from "./bot/engine";
import { prisma } from "./lib/db";

const app = express();
const PORT = process.env.PORT || 3001;

// CORS: 브라우저는 http://localhost:3000 과 http://127.0.0.1:3000 을 다른 Origin으로 본다.
// origin: true → 요청의 Origin을 Access-Control-Allow-Origin에 그대로 반사 (preflight 포함).
const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  optionsSuccessStatus: 204,
};

// 1. 미들웨어 설정
app.use(cors(corsOptions));
app.use(express.json());

// 2. 라우터 연결
app.use("/api/auth", authRouter);
app.use("/api", mainRouter); // /api/config, /api/positions 등

/** DB 연결 확인 — nonce 500 나면 여기부터 보면 됨 */
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "up" });
  } catch (e) {
    console.error("[GET /api/health]", e);
    res.status(503).json({ ok: false, db: "down" });
  }
});

// 3. 백그라운드 스케줄러 (1분 간격)
setInterval(runBotTask, 60 * 1000);

// 4. 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  runBotTask(); // 초기 실행
});
