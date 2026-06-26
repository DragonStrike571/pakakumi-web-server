const DEFAULT_ORIGINS = [
  "https://pakakumi-web-client.vercel.app",
  "https://pakakumi.softdocs.org",
  "http://localhost:3000",
  "http://localhost:5173",
];

// Allow CORS origins to be extended via environment variable
const envOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

export const CORS_ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...envOrigins])];
