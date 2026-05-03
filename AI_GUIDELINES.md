# 🤖 AI Agent Coding Guidelines & Harness

이 문서는 이 프로젝트(`lp-to-earning-server`)를 다루는 모든 AI 에이전트가 반드시 준수해야 하는 **하네스(Harness) 규정**입니다. 어떤 모델이든 이 규칙을 바탕으로 일관된 코드를 생성해야 합니다.

---

## 🏗️ 1. Architecture & Directory Structure
모든 코드는 정해진 위치에 있어야 하며, 역할이 섞이지 않도록 합니다.

- **`src/api/`**: Express 라우터 및 API 핸들러. (비즈니스 로직은 최소화)
- **`src/core/`**: 도메인 핵심 로직 (Swap, DEX 연동, 포지션 계산 등). 외부 의존성이 가장 적어야 함.
- **`src/bot/`**: 백그라운드에서 돌아가는 봇 엔진 및 스케줄러 로직.
- **`src/lib/`**: DB 클라이언트, 암호화 도구, 공통 유틸리티.
- **`prisma/`**: 데이터베이스 스키마 및 마이그레이션 파일.

---

## 🛠️ 2. Coding Standards (Vercel Style Based)
지속 가능한 코드 품질을 위해 다음 규칙을 엄격히 적용합니다.

- **TypeScript First**: `any` 사용을 금지합니다. 모든 변수와 함수 리턴값에 명확한 타입을 지정하세요.
- **Function Length**: 하나의 함수는 가능하면 **20줄**을 넘지 않도록 작게 쪼갭니다.
- **Component Separation**: 로직이 복잡해지면 별도의 유틸리티나 서비스로 즉시 분리합니다.
- **Error Handling**: 모든 외부 호출(RPC, DB)에는 `try-catch`와 명확한 에러 로그(`console.error`)를 포함합니다.
- **Async/Await**: Callback 대신 반드시 `async/await` 패턴을 사용합니다.

---

## 🔐 3. Security & Key Management
자산을 다루는 프로젝트이므로 보안은 최우선 순위입니다.

- **Private Key Isolation**: `SOLANA_WALLET_PRIVATE_KEY` 등의 민감 정보는 절대 로그(`console.log`)에 찍지 않습니다.
- **Decryption Rule**: DB에 저장된 암호화된 키는 사용하기 직전에만 `decrypt()`를 통해 복구하고, 메모리에 오래 머물지 않도록 합니다.
- **Environment Variables**: 새로운 설정이 필요하면 `.env.example`에도 반드시 추가합니다.

---

## 🚀 4. Workflow Protocol (The "Harness" Loop)
작업을 수행할 때 다음 순서를 지킵니다.

1.  **Check**: 코드를 수정하기 전, 관련 파일(`package.json`, `schema.prisma` 등)을 읽어 의존성을 확인합니다.
2.  **Plan**: 수정할 내용을 디자인 패턴 위주로 한 줄 요약하여 사용자에게 먼저 보고합니다.
3.  **Implement**: 정해진 스타일 가이드에 맞춰 코드를 작성합니다.
4.  **Validate**: 가능할 경우 `npm run build`를 제안하거나 실행하여 타입 에러가 없는지 확인합니다.

---

## 📝 5. Communication Style
- **Language**: 모든 설명과 주석은 **한국어**를 기본으로 합니다.
- **Feedback**: 코드에 잠재적인 위험(Code Smell)이 발견되면 즉시 `[Code Smell]` 경고를 표시합니다.

---

**이 가이드라인은 프로젝트의 법전과 같습니다. 에이전트는 이 규칙 내에서만 자유롭게 코드를 제안할 수 있습니다.**
