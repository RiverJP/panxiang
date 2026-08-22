import crypto from "node:crypto";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) {
    encoded += base32Alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return encoded;
}

const username = process.env.ADMIN_SETUP_USER || "admin";
const issuer = process.env.ADMIN_SETUP_ISSUER || "盼享随充后台";
const password = crypto.randomBytes(24).toString("base64url");
const salt = crypto.randomBytes(16);
const passwordHash = crypto.scryptSync(password, salt, 64);
const secret = base32Encode(crypto.randomBytes(20));
const label = encodeURIComponent(`${issuer}:${username}`);
const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

console.log("\n请立即保存以下信息；脚本不会写入任何文件。\n");
console.log(`后台账号: ${username}`);
console.log(`后台密码: ${password}`);
console.log(`Google Authenticator 设置密钥: ${secret}`);
console.log("类型: 基于时间\n");
console.log("复制到 .env：");
console.log(`ADMIN_USER=${username}`);
console.log(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString("hex")}$${passwordHash.toString("hex")}`);
console.log(`ADMIN_TOTP_SECRET=${secret}`);
console.log("ADMIN_SESSION_TTL_SECONDS=28800\n");
console.log("如使用支持 otpauth 的二维码工具，可导入下面的 URI（不要发给他人）：");
console.log(otpauth);
