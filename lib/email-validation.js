export async function emailResult(email) {
  const token = process.env.GHL_PIT_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    console.error("Email verification is missing server configuration.");
    return { ok: true, status: "unverified" };
  }
  try {
    const url = new URL("https://services.leadconnectorhq.com/email/verify");
    url.searchParams.set("locationId", locationId);
    const upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, Version: "v3", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "email", verify: email }),
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      console.error("Email verification provider returned HTTP " + upstream.status + ".");
      return { ok: true, status: "unverified" };
    }
    const result = await upstream.json();
    if (result.verified === false) return { ok: true, status: "unverified" };
    const category = typeof result.result === "string" ? result.result : "unknown";
    const recommended = result.leadConnectorRecommendation?.isEmailValid ?? result.isEmailValid;
    const rejected = ["undeliverable", "do_not_send"].includes(category) || recommended === false;
    return {
      ok: !rejected,
      status: category,
      message: rejected ? "Please check your email address." : undefined,
    };
  } catch (error) {
    console.error("Email verification provider request failed.");
    return { ok: true, status: "unverified" };
  }
}



