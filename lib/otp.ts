import { createHash, randomInt } from "node:crypto";

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashOtp(otp: string): string {
  const pepper = process.env.OTP_PEPPER ?? "dev-pepper";
  return createHash("sha256").update(`${pepper}:${otp}`).digest("hex");
}
