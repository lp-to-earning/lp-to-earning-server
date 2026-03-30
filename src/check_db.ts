import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function check() {
  try {
    const user = await prisma.user.findFirst({
      select: {
          id: true,
          walletAddress: true,
          hotWalletAddress: true,
      }
    });
    console.log('CHECK_RESULT:', JSON.stringify(user, null, 2));
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await prisma.$disconnect();
  }
}

check();
