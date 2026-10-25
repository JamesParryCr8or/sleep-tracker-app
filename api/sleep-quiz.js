import { applyCors, methodNotAllowed, jsonBody } from "../lib/validation.js";
import { validatePhoneProof } from "../lib/phone-proof.js";
import { emailResult } from "../lib/email-validation.js";

const WEBHOOK = "https://services.leadconnectorhq.com/hooks/xRtnEUKQPRH6oIIPYlin/webhook-trigger/9bbc6cb4-24cb-4539-80d7-d5ed4a2ef5c1";
export default async function handler(req, res) {
  if (!applyCors(req, res)) return res.status(403).json({ ok: false, message: "Request origin not allowed." });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return methodNotAllowed(res);
  const body = jsonBody(req);
  if (!body || JSON.stringify(body).length > 24000) return res.status(400).json({ ok: false, message: "Invalid quiz submission." });
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !validatePhoneProof(body.verificationToken, phone)) {
    return res.status(400).json({ ok: false, code: "phone_unverified", message: "Verify your phone number before revealing your result. If your code expired, request a new one." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, message: "Please check your email address." });
  }
  const token = process.env.GHL_PIT_TOKEN, locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) return res.status(503).json({ ok: false, message: "We cannot save your quiz right now. Please try again shortly." });
  const checked = await emailResult(email);
  if (!checked.ok) return res.status(400).json(checked);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 150) : "";
  const marketingConsent = body.marketingConsent === true;
  try {
    const contactResponse = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Version: "v3", "Content-Type": "application/json" },
      body: JSON.stringify({
        locationId, name, email, phone, source: "DREAMSILK Sleep Improvement Quiz",
        ...(!marketingConsent ? { dndSettings: { email: { status: "active" } } } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!contactResponse.ok) {
      console.error("Sleep quiz GHL contact upsert returned HTTP " + contactResponse.status + ".");
      return res.status(503).json({ ok: false, message: "We could not save your sleep plan. Your details are still here; please try again shortly." });
    }
    const saved = await contactResponse.json();
    if (!saved.contact?.id) throw new Error("GHL contact ID missing.");
    const tagResponse = await fetch("https://services.leadconnectorhq.com/contacts/" + encodeURIComponent(saved.contact.id) + "/tags", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Version: "v3", "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["sleep quiz"] }), signal: AbortSignal.timeout(10000),
    });
    if (!tagResponse.ok) {
      console.error("Sleep quiz tag addition returned HTTP " + tagResponse.status + ".");
      return res.status(503).json({ ok: false, message: "Your contact details were saved, but your sleep plan could not be completed yet. Please try again." });
    }
    const payload = {
      source: "https://dreamsilk.io/pages/sleep-quiz",
      status: "completed", timestamp: new Date().toISOString(), quiz: "DREAMSILK Sleep Improvement Quiz",
      name, email, phone, marketingConsent, phoneVerified: true, emailValidationStatus: checked.status,
      ghlContactId: saved.contact.id,
      sleepProfile: typeof body.sleepProfile === "string" ? body.sleepProfile.slice(0, 100) : "",
      sleepSetupScore: Number.isFinite(body.sleepSetupScore) ? body.sleepSetupScore : null,
      sleepBlocker: body.sleepBlocker, sleepGoal: body.sleepGoal, habitBlocker: body.habitBlocker,
      preferredSupport: body.preferredSupport, answers: body.answers, utm: body.utm,
      recommendedProducts: body.recommendedProducts,
      trackerPrizeUrl: "https://sleep.dreamsilk.io/", pdfIncludedWithOrder: "Yes", silkDiscountAutoApplied: "25%",
    };
    const workflow = await fetch(WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    if (!workflow.ok) {
      console.error("Sleep quiz workflow returned HTTP " + workflow.status + ".");
      return res.status(503).json({ ok: false, message: "Your contact details were saved, but your sleep plan could not be sent yet. Please try again." });
    }
    return res.status(200).json({ ok: true, emailValidationStatus: checked.status });
  } catch (error) {
    console.error("Sleep quiz integration request failed.");
    return res.status(503).json({ ok: false, message: "We could not save your sleep plan. Please try again shortly." });
  }
}

