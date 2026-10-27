import { emailResult } from "../lib/email-validation.js";
import { issuePhoneProof } from "../lib/phone-proof.js";
import crypto from "node:crypto";
import { applyCors, methodNotAllowed, jsonBody } from "../lib/validation.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return typeof req.headers["x-real-ip"] === "string" ? req.headers["x-real-ip"].trim() : "";
}

let rateLimitSetup;
async function ensureRateLimits(serviceSid, auth) {
  if (rateLimitSetup) return rateLimitSetup;
  rateLimitSetup = (async () => {
    const base = "https://verify.twilio.com/v2/Services/" + encodeURIComponent(serviceSid) + "/RateLimits";
    async function request(url, fields) {
      const response = await fetch(url, {
        method: fields ? "POST" : "GET",
        headers: { Authorization: "Basic " + auth, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        body: fields ? new URLSearchParams(fields) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error("Twilio rate limit setup failed.");
        error.code = data.code;
        error.detail = typeof data.message === "string" ? data.message.replace(/\+?\d{6,}/g, "[redacted]").slice(0, 180) : "";
        error.stage = url.includes("/Buckets") ? "buckets" : (fields ? "create-limit" : "list-limits");
        throw error;
      }
      return data;
    }
    let limits = (await request(base + "?PageSize=100")).rate_limits;
    if (!Array.isArray(limits)) throw new Error("Unexpected Twilio rate limit response.");
    for (const name of ["end_user_ip", "phone_number"]) {
      let limit = limits.find(item => item.unique_name === name);
      if (!limit) {
        try {
          limit = await request(base, { UniqueName: name, Description: "Customer service SMS verification" });
        } catch (error) {
          if (error.code !== 60208) throw error;
          limits = (await request(base + "?PageSize=100")).rate_limits;
          limit = limits.find(item => item.unique_name === name);
          if (!limit) throw error;
        }
      }
      const bucketUrl = base + "/" + encodeURIComponent(limit.sid) + "/Buckets";
      const buckets = (await request(bucketUrl)).buckets;
      if (!Array.isArray(buckets)) throw new Error("Unexpected Twilio bucket response.");
      const required = name === "phone_number" ? [[3600, 5], [30, 1]] : [[3600, 5]];
      for (const [interval, max] of required) {
        if (buckets.some(item => Number(item.interval) === interval)) continue;
        try {
          await request(bucketUrl, { Interval: String(interval), Max: String(max) });
        } catch (error) {
          if (error.code !== 60211) throw error;
        }
      }
    }
  })().catch(error => {
    rateLimitSetup = undefined;
    console.error("SMS rate limit setup failed; Twilio code " + (error.code || "unknown") + "; stage " + (error.stage || "unknown") + "; " + (error.detail || "") + ".");
    throw error;
  });
  return rateLimitSetup;
}

async function sendPhoneCode(phone, req, res) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const ip = clientIp(req);
  if (!accountSid || !apiKey || !apiSecret || !serviceSid || !ip) {
    console.error("SMS verification is missing server configuration.");
    return res.status(503).json({ ok: false, message: "Phone verification is temporarily unavailable." });
  }
  const form = new URLSearchParams({
    To: phone,
    Channel: "sms",
    RateLimits: JSON.stringify({ end_user_ip: hash(ip), phone_number: hash(phone) }),
  });
  try {
    const auth = Buffer.from(apiKey + ":" + apiSecret).toString("base64");
    await ensureRateLimits(serviceSid, auth);
    const upstream = await fetch(
      "https://verify.twilio.com/v2/Services/" + encodeURIComponent(serviceSid) + "/Verifications",
      {
        method: "POST",
        headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!upstream.ok) {
      const detail = await upstream.json().catch(() => ({}));
      console.error("SMS verification provider returned HTTP " + upstream.status + "; Twilio code " + (detail.code || "unknown") + ".");
      const status = upstream.status === 429 ? 429 : 503;
      const retryHeader = Number(upstream.headers.get("retry-after"));
      const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? Math.min(3600, Math.ceil(retryHeader)) : 60;
      if (status === 429) res.setHeader("Retry-After", String(retryAfter));
      return res.status(status).json({
        ok: false,
        code: status === 429 ? "sms_rate_limited" : "sms_unavailable",
        retryAfter: status === 429 ? retryAfter : undefined,
        providerCode: typeof detail.code === "number" ? detail.code : undefined,
        message: status === 429 ? "Too many verification code requests. No new SMS was sent. If you already received a code, try verifying with it. Wait at least a minute before retrying; repeated requests can reach the five-per-hour limit for your phone number or internet connection. If that limit has been reached, allow up to an hour for it to reset." : "Phone verification is temporarily unavailable.",
      });
    }
    const verification = await upstream.json();
    if (verification.status !== "pending") {
      return res.status(503).json({ ok: false, message: "Phone verification is temporarily unavailable." });
    }
    return res.status(200).json({ ok: true, status: "pending" });
  } catch (error) {
    console.error("SMS verification provider request failed.");
    return res.status(503).json({ ok: false, message: "Phone verification is temporarily unavailable." });
  }
}

async function checkPhoneCode(phone, code, res) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!accountSid || !apiKey || !apiSecret || !serviceSid) {
    console.error("SMS verification is missing server configuration.");
    return res.status(503).json({ ok: false, message: "Phone verification is temporarily unavailable." });
  }
  try {
    const auth = Buffer.from(apiKey + ":" + apiSecret).toString("base64");
    const upstream = await fetch(
      "https://verify.twilio.com/v2/Services/" + encodeURIComponent(serviceSid) + "/VerificationCheck",
      {
        method: "POST",
        headers: { Authorization: "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: phone, Code: code }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!upstream.ok) {
      console.error("SMS code check provider returned HTTP " + upstream.status + ".");
      return res.status(503).json({ ok: false, message: "Code verification is temporarily unavailable." });
    }
    const check = await upstream.json();
    const approved = check.status === "approved";
    return res.status(200).json({
      ok: approved,
      status: approved ? "approved" : "pending",
      verificationToken: approved ? issuePhoneProof(phone) : undefined,
      message: approved ? undefined : "That code is not correct or has expired.",
    });
  } catch (error) {
    console.error("SMS code check provider request failed.");
    return res.status(503).json({ ok: false, message: "Code verification is temporarily unavailable." });
  }
}

export default async function handler(req, res) {
  if (!applyCors(req, res)) return res.status(403).json({ ok: false, message: "Request origin not allowed." });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return methodNotAllowed(res);

  const body = jsonBody(req);
  if (!body) return res.status(400).json({ ok: false, message: "Invalid request." });
  if (body.action === "email") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ ok: false, status: "invalid", message: "Please check your email address." });
    }
    return res.status(200).json(await emailResult(email));
  }
  if (body.action === "phone-send" || body.action === "phone-check") {
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return res.status(400).json({ ok: false, message: "Enter a valid phone number with its country code." });
    }
    if (body.action === "phone-send") return sendPhoneCode(phone, req, res);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{4,10}$/.test(code)) {
      return res.status(400).json({ ok: false, message: "Enter the phone number and code as shown." });
    }
    return checkPhoneCode(phone, code, res);
  }
  return res.status(400).json({ ok: false, message: "Unknown validation action." });
}

