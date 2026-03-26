import express from "express";
import cors from "cors";
import "dotenv/config";
import authRouter from "./api/auth";
import mainRouter from "./api/main";
import { runBotTask } from "./bot/engine";

const app = express();
const PORT = process.env.PORT || 3001;

// 1. 미들웨어 설정
app.use(cors());
app.use(express.json());

// 2. 라우터 연결
app.use("/api/auth", authRouter);
app.use("/api", mainRouter); // /api/config, /api/positions 등

// 3. 백그라운드 스케줄러 (1분 간격)
setInterval(runBotTask, 60 * 1000);

// 4. 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  runBotTask(); // 초기 실행
});
