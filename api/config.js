module.exports = function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed." });
  }

  response.setHeader("Cache-Control", "no-store");
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return response.status(503).json({ error: "Supabase is not configured for this deployment." });
  }
  if (isPrivilegedKey(SUPABASE_ANON_KEY)) {
    return response.status(500).json({ error: "Configure the Supabase publishable/anon key, never a secret key." });
  }

  return response.status(200).json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
};

function isPrivilegedKey(key) {
  if (key.startsWith("sb_secret_")) return true;
  const payload = key.split(".")[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.role === "service_role";
  } catch {
    return false;
  }
}
