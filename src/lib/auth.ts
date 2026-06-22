import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import { users, sessions, accounts, verifications } from "../db/schema.js";

import { CORS_ORIGINS } from "../config/cors.js";

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
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user"
      },
      accessStatus: {
        type: "string",
        defaultValue: "pending"
      }
    }
  },
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: CORS_ORIGINS,
  advanced: {
    useSecureCookies: true,
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
      partitioned: true,
    },
    cookies: {
      session_token: {
        name: "better-auth.session_token",
        attributes: {
          sameSite: "none",
          secure: true,
          partitioned: true,
        },
      },
      session_data: {
        name: "better-auth.session_data",
        attributes: {
          sameSite: "none",
          secure: true,
          partitioned: true,
        },
      },
    },
  },
});
