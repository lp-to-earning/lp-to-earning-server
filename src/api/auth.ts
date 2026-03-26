import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { prisma, JWT_SECRET } from "../lib/db";

const router = Router();

// 지갑 인증용 Nonce 발급
router.post("/nonce", async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) {
      return res.status(400).json({ error: "walletAddress is required" });
    }
    if (typeof walletAddress !== "string" || walletAddress.length > 256) {
      return res.status(400).json({ error: "Invalid walletAddress" });
    }

    const nonce = crypto.randomUUID();
    let user = await prisma.user.findUnique({ where: { walletAddress } });

    if (user) {
      user = await prisma.user.update({
        where: { walletAddress },
        data: { nonce },
      });
    } else {
      user = await prisma.user.create({
        data: {
          walletAddress,
          nonce,
          config: {
            create: {}, // Default config
          },
        },
      });
    }

    res.json({ nonce: user.nonce });
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    console.error("[POST /api/auth/nonce]", err?.code ?? "", err?.message ?? e);
    const dev = process.env.NODE_ENV !== "production";
    res.status(500).json({
      error: "Failed to issue nonce",
      ...(dev && { detail: err?.message, prismaCode: err?.code }),
    });
  }
});

// 서명 검증 및 JWT 발급
router.post("/login", async (req, res) => {
  const { walletAddress, signature } = req.body;

  const user = await prisma.user.findUnique({ where: { walletAddress } });
  if (!user) return res.status(404).json({ error: "User not found" });

  try {
    const messageBytes = new TextEncoder().encode(
      `Sign this message to authenticate dashboard: ${user.nonce}`,
    );
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(walletAddress);

    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKeyBytes,
    );
    if (!isValid) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  } catch (err) {
    return res.status(400).json({ error: "Signature format is invalid" });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

export default router;
