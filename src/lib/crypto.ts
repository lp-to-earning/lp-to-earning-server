import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const MASTER_KEY = process.env.BOT_MASTER_KEY; // .env에서 주입받는 비밀 마스터 키

if (!MASTER_KEY || MASTER_KEY.length < 32) {
  throw new Error('⚠️ [CRITICAL] BOT_MASTER_KEY must be at least 32 characters long in .env');
}

// 1. 암호화 (Encrypt)
export function encrypt(text: string) {
  const iv = crypto.randomBytes(12); // 초기화 벡터 (매번 다름)
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(MASTER_KEY!.substring(0, 32)), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex'); // 무결성 검증용 태그
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag
  };
}

// 2. 복호화 (Decrypt)
export function decrypt(encryptedData: string, ivHex: string, authTagHex: string) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM, 
    Buffer.from(MASTER_KEY!.substring(0, 32)), 
    Buffer.from(ivHex, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
