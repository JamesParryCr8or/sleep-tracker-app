import crypto from "node:crypto";
function signature(body) {
  const secret = process.env.TWILIO_API_SECRET;
  if (!secret) throw new Error("Verification signing configuration missing.");
  return crypto.createHmac("sha256", secret).update("sleep-quiz:" + body).digest();
}
export function issuePhoneProof(phone) {
  const body = Buffer.from(JSON.stringify({ phone, exp: Date.now() + 15 * 60 * 1000 })).toString("base64url");
  return body + "." + signature(body).toString("base64url");
}
export function validatePhoneProof(token, phone) {
  try {
    if (typeof token !== "string" || token.length > 1024) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const actual = Buffer.from(parts[1], "base64url"), expected = signature(parts[0]);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return data.phone === phone && Number.isFinite(data.exp) && data.exp > Date.now();
  } catch { return false; }
}

