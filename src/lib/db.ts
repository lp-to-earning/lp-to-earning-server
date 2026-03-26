import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

if (!process.env.JWT_SECRET) {
  console.warn(
    "⚠️  [Security Warning] JWT_SECRET is not defined in .env! Using a temporary fallback is NOT recommended.",
  );
}

export const JWT_SECRET =
  process.env.JWT_SECRET ||
  "emergency-unsecure-fallback-replace-me-immediately";
