import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import { users, sessions, accounts, verifications } from "../db/schema.js";

// CORS origins — Better Auth needs these to set its own CORS headers
const CORS_ORIGINS = [
  "https://pakakumi-web-client.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [
    "https://pakakumi-web-client.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
  ],
  advanced: {
    useSecureCookies: true,
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
    },
  },
});
