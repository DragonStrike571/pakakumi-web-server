const DEPLOYED_ORIGINS = [
  "https://pakakumi-web-client.vercel.app",
  "https://pakakumi.softdocs.org",
];
const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
];
const DEFAULT_ORIGINS = process.env.NODE_ENV === "production"
  ? DEPLOYED_ORIGINS
  : [...DEPLOYED_ORIGINS, ...LOCAL_ORIGINS];

const parseOrigin = (value: string) => {
  const candidate = value.trim();
  if (!candidate || candidate === "*") {
    throw new Error("CORS origins must be explicit HTTP(S) origins");
  }

  const url = new URL(candidate);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid CORS origin: ${candidate}`);
  }
  return url.origin;
};

// Extend the allow-list without accepting wildcards, credentials, or paths.
const envOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").filter((origin) => origin.trim()).map(parseOrigin)
  : [];

export const CORS_ORIGINS = [
  ...new Set([...DEFAULT_ORIGINS.map(parseOrigin), ...envOrigins]),
];
