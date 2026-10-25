const ALLOWED_ORIGINS = new Set(["https://dreamsilk.io", "https://www.dreamsilk.io"]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return true;
}

function methodNotAllowed(res) {
  res.setHeader("Allow", "POST, OPTIONS");
  return res.status(405).json({ ok: false, message: "Method not allowed." });
}

function jsonBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return null;
  return req.body;
}

export { applyCors, methodNotAllowed, jsonBody };
