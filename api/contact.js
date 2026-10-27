import { applyCors, methodNotAllowed, jsonBody } from "../lib/validation.js";
import { validatePhoneProof } from "../lib/phone-proof.js";
import { emailResult } from "../lib/email-validation.js";

export default async function handler(req, res) {
  if (!applyCors(req, res)) return res.status(403).json({ ok: false, message: "Request origin not allowed." });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return methodNotAllowed(res);
  const body = jsonBody(req);
  if (!body || JSON.stringify(body).length > 16000) return res.status(400).json({ ok: false, message: "Invalid contact request." });
  const text = key => typeof body[key] === "string" ? body[key].trim() : "";
  const phone = text("phone");
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !validatePhoneProof(body.verificationToken, phone)) {
    return res.status(400).json({ ok: false, code: "phone_unverified", message: "Verify your phone number before sending your message. Request a new SMS code if verification expired." });
  }
  if (text("website")) return res.status(400).json({ ok: false, message: "Your message could not be accepted." });
  const email = text("email").toLowerCase(), firstName = text("first_name"), lastName = text("last_name"), message = text("message");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, message: "Please check your email address." });
  }
  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100 || message.length < 5 || message.length > 10000) {
    return res.status(400).json({ ok: false, message: "Enter your first and last name and a message between 5 and 10,000 characters." });
  }
  const token = process.env.GHL_PIT_TOKEN, locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) return res.status(503).json({ ok: false, message: "Customer service is temporarily unavailable. Your message has not been sent. Please try again shortly." });
  const checked = await emailResult(email);
  if (!checked.ok) return res.status(400).json(checked);
  const headers = { Authorization: "Bearer " + token, Version: "v3", "Content-Type": "application/json" };
  async function ghl(path, payload, stage) {
    const response = await fetch("https://services.leadconnectorhq.com" + path, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const reason = [detail.message, detail.error].flat().filter(value => typeof value === "string").join("; ")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
        .replace(/\+?\d{7,}/g, "[number]").slice(0, 500);
      console.error("Customer service GHL " + stage + " returned HTTP " + response.status + "; " + reason);
      const error = new Error("Customer service save failed.");
      error.stage = stage;
      throw error;
    }
    return response.json();
  }
  try {
    const saved = await ghl("/contacts/upsert", { locationId, firstName, lastName, email, phone, source: "Contact Us Page - dreamsilk.io", createNewIfDuplicateAllowed: false }, "contact upsert");
    if (!saved.contact?.id) throw new Error("GHL contact ID missing.");
    const contactPath = "/contacts/" + encodeURIComponent(saved.contact.id);
    await ghl(contactPath + "/tags", { tags: ["customer service"] }, "tag");
    const note = await ghl(contactPath + "/notes", {
      title: "Website customer service request",
      body: "DREAMSILK customer service request\nSubmitted: " + new Date().toISOString() +
        "\nPhone verified by SMS: " + phone + "\nEmail validation: " + checked.status +
        "\n\n" + message,
    }, "message note");
    if (!note.note?.id) throw new Error("GHL note ID missing.");
    const enrollment = await ghl(contactPath + "/workflow/fe426647-dada-4e90-88aa-3868a0e2c873", {
      eventStartTime: new Date().toISOString(),
    }, "workflow enrollment");
    if (enrollment.succeeded !== true && enrollment.succeded !== true) {
      console.error("Customer service workflow enrollment was not acknowledged.");
      throw new Error("GHL workflow enrollment failed.");
    }
    return res.status(200).json({ ok: true, emailValidationStatus: checked.status, workflowEnrolled: true });
  } catch (error) {
    console.error("Customer service request could not be completed.");
    if (error.stage === "workflow enrollment") {
      return res.status(503).json({ ok: false, code: "workflow_enrollment_failed", message: "Your message was saved, but the support notification could not be completed. Your details are still here." });
    }
    return res.status(503).json({ ok: false, message: "Your message could not be saved. Your details are still here; please try again shortly." });
  }
}
