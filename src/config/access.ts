import { z } from "zod";

export const authorizationFields = {
  role: {
    type: "string" as const,
    defaultValue: "user",
    input: false,
    validator: { input: z.enum(["user", "admin"]) },
  },
  accessStatus: {
    type: "string" as const,
    defaultValue: "pending",
    input: false,
    validator: { input: z.enum(["pending", "active", "telegram_premium", "suspended"]) },
  },
};

export function hasActiveAccess(user: { role?: string; accessStatus?: string } | null | undefined) {
  return Boolean(user && (user.role === "admin" || user.accessStatus === "active" || user.accessStatus === "telegram_premium"));
}
