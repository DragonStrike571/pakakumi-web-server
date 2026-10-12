import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import { users, sessions, accounts, verifications } from "../db/schema.js";

import { CORS_ORIGINS } from "../config/cors.js";
import { authorizationFields } from "../config/access.js";

const isProduction = process.env.NODE_ENV === "production";
const cookieAttributes = isProduction
  ? { sameSite: "none" as const, secure: true, partitioned: true }
  : { sameSite: "lax" as const, secure: false };

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
  user: {
    additionalFields: authorizationFields,
  },
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: CORS_ORIGINS,
  advanced: {
    useSecureCookies: isProduction,
    defaultCookieAttributes: cookieAttributes,
    cookies: {
      session_token: {
        name: "better-auth.session_token",
        attributes: cookieAttributes,
      },
      session_data: {
        name: "better-auth.session_data",
        attributes: cookieAttributes,
      },
    },
  },
});
