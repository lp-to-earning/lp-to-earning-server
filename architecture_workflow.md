# 🚀 멀티 유저 지원 LP 봇 아키텍처 및 워크플로우

이 문서는 추후 다중 사용자(Multi-User) 환경으로 시스템을 개편할 때 참조할 수 있는 **지갑 인증(Wallet Auth)** 및 **사용자별 봇 실행 워크플로우** 설계도입니다.

## 1. 지갑 로그인 및 설정 변경 (웹/앱 개입)

사용자가 자신의 솔라나 지갑을 연결하여 봇 설정을 조회하고 변경하는 과정입니다.

```mermaid
sequenceDiagram
    participant User as 사용자 (Web/App)
    participant Wallet as 솔라나 지갑 (Phantom)
    participant Server as Node.js 서버
    participant DB as SQLite DB

    %% 로그인 과정
    Note over User, DB: 1. 지갑 인증 로그인 (Wallet Auth)
    User->>Wallet: 지갑 연결 요청
    Wallet-->>User: 지갑 주소(Pubkey) 반환
    User->>Server: 지갑 주소로 로그인 요청
    Server-->>User: 고유 서명 메시지(Nonce) 발급
    User->>Wallet: Nonce 서명 요청
    Wallet-->>User: 암호화된 서명(Signature) 반환
    User->>Server: 서명 검증 요청
    Server->>Server: 서명 수학적 검증 수행
    Server->>DB: 사용자 정보 확인 또는 신규 생성
    DB-->>Server: User ID 반환
    Server-->>User: 로그인 성공 (JWT 토큰 발급)

    %% 설정 조회 및 변경
    Note over User, DB: 2. 봇 설정 (Config) 커스텀
    User->>Server: 내 봇 설정 조회 (JWT 포함)
    Server->>DB: user_configs 조회
    DB-->>Server: 기존 설정 값 반환
    Server-->>User: 설정 화면 렌더링
    User->>Server: 설정값 변경 저장 (탑 포지션, 금액 등)
    Server->>DB: user_configs 업데이트
    Server-->>User: 저장 완료
```

## 2. 봇 백그라운드 구동 흐름 (멀티 유저)

서버 백그라운드에서 주기적으로(intervalMs) 실행되면서, **각 사용자의 설정(Config)을 불러와 개별적으로 봇 로직을 수행**하는 흐름입니다.

```mermaid
sequenceDiagram
    participant Cron as 백그라운드 스케줄러 (setInterval)
    participant Bot as Main Bot Logic
    participant DB as SQLite DB
    participant RPC as Solana RPC (CLI)

    Cron->>Bot: 매 모니터링 주기마다 실행 트리거
    Bot->>DB: 현재 활성화된(is_active) 모든 사용자 및 설정 로드
    DB-->>Bot: [UserA(Config), UserB(Config), ...] 반환

    loop 각 사용자(User)마다 반복
        Note over Bot, RPC: 사용자 A의 설정 기반
        Bot->>RPC: 사용자 A의 타겟 풀 정보 조회 (pools info)
        RPC-->>Bot: 풀 가격, 상위 포지션 등 응답
        
        Bot->>Bot: 사용자 A의 조건(minApr, score 등) 필터링
        
        opt 조건에 맞는 좋은 포지션 발견
            Bot->>RPC: 사용자 A 지갑 권한으로 Copy Trade 실행
            RPC-->>Bot: 트랜잭션 결과 반환
        end
        
        Bot->>DB: 사용자 A의 새로운 포지션/로그DB (positions_db) 업데이트
    end
    
    Note over Bot: 모든 사용자에 대한 이번 주기 스캔 완료
```

## 🔐 주요 데이터베이스 구조 (Prisma Schema 예시)

다음에 개발을 시작하실 때 사용할 수 있는 `schema.prisma` 코드의 핵심 뼈대입니다.

```prisma
// schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite" // 초기엔 sqlite, 추후 postgresql로 쉽게 변경 가능
  url      = "file:./dev.db"
}

// 사용자 지갑 정보
model User {
  id            Int         @id @default(autoincrement())
  walletAddress String      @unique
  nonce         String      // 서명 검증을 위한 랜덤 문자열
  createdAt     DateTime    @default(now())
  
  // 1:1 관계
  config        UserConfig? 
}

// 사용자별 상세 설정 (현재 config.js 내용)
model UserConfig {
  id                  Int      @id @default(autoincrement())
  userId              Int      @unique
  user                User     @relation(fields: [userId], references: [id])
  
  // ── 복사 기준 ──
  topN                Int      @default(3)
  maxCopyAttempts     Int      @default(10)
  sortBy              String   @default("score")
  requireInRange      Boolean  @default(true)
  minAprPercent       Float    @default(20.0)
  
  // ── 복사 설정 및 스케줄 ──
  copyAmountUsd       Float    @default(3.0)
  dryRun              Boolean  @default(false)
  intervalMs          Int      @default(1800000)
  
  // JSON으로 유연하게 관리할 항목들 (풀 목록, 충전 토큰)
  pools               String   @default("[]") // JSON String 형태
  autoRechargeTokens  String   @default("[]") // JSON String 형태
}
```

### 💡 다음 스텝 제안
1. **현재 상태 유지:** 오늘은 구조도만 확인하시고, 당장은 하나의 `config.js`를 수정하면서 단일 봇을 고도화시킵니다.
2. **멀티유저 이사 준비:** 추후 준비가 되시면, 이 문서를 기반으로 `npm install @prisma/client prisma` 를 실행해 DB 연동을 가장 먼저 시작하시면 됩니다.
