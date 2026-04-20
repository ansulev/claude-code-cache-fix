function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const config = {
  port: envInt("CACHE_FIX_PROXY_PORT", 9801),
  bind: process.env.CACHE_FIX_PROXY_BIND || "127.0.0.1",
  upstream: process.env.CACHE_FIX_PROXY_UPSTREAM || "https://api.anthropic.com",
  timeout: envInt("CACHE_FIX_PROXY_TIMEOUT", 600_000),
};

export default config;
