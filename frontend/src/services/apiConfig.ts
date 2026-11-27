export function resolveApiConfig(env: Record<string, string | undefined>) {
  const rawMode = (env.VITE_API_MODE || "same-origin").trim();
  const mode = rawMode === "php" ? "same-origin" : rawMode;
  if (mode !== "same-origin" && mode !== "secure") {
    throw new Error("VITE_API_MODE must be same-origin or secure");
  }
  const baseUrl = (env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
  // Empty means same origin. An explicit base must be an HTTP(S) origin,
  // never a media proxy or an /api/v1 endpoint.
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("VITE_API_BASE_URL must be an HTTP(S) origin");
    }
    if (
      !/^https?:\/\/[^/?#]+$/i.test(baseUrl) ||
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      /[\\\s]/.test(baseUrl)
    ) {
      throw new Error("VITE_API_BASE_URL must be empty or an HTTP(S) origin");
    }
  }
  return {
    mode,
    baseUrl,
    parseUrl: baseUrl + "/api/parse",
    catalogUrl: baseUrl + "/api/platforms",
  };
}

export const apiConfig = resolveApiConfig(import.meta.env);
