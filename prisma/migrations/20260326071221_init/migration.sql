-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encryptedPrivateKey" TEXT,
    "iv" TEXT,
    "authTag" TEXT
);

-- CreateTable
CREATE TABLE "UserConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "topN" INTEGER NOT NULL DEFAULT 3,
    "maxCopyAttempts" INTEGER NOT NULL DEFAULT 10,
    "sortBy" TEXT NOT NULL DEFAULT 'score',
    "requireInRange" BOOLEAN NOT NULL DEFAULT true,
    "minAprPercent" REAL NOT NULL DEFAULT 20.0,
    "copyAmountUsd" REAL NOT NULL DEFAULT 3.0,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "intervalMs" INTEGER NOT NULL DEFAULT 1800000,
    "pools" TEXT NOT NULL DEFAULT '[]',
    "autoRechargeTokens" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "UserConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "UserConfig_userId_key" ON "UserConfig"("userId");
