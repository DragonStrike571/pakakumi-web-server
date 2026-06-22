import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../types/express.js";
/**
 * Middleware to restrict access based on user role and accessStatus.
 * Admins have full access.
 * Users with "active" accessStatus have access.
 * If requireBotAccess is true, "telegram_premium" users are blocked.
 */
export const requireActiveAccess = (requireBotAccess = false) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (user.role === "admin") {
      return next();
    }
    if (user.accessStatus === "suspended" || user.accessStatus === "pending") {
      return res
        .status(403)
        .json({ error: `Access denied: Account is ${user.accessStatus}` });
    }
    if (requireBotAccess && user.accessStatus === "telegram_premium") {
      return res.status(403).json({
        error:
          "Access denied: Telegram Premium users cannot access the bot section",
      });
    }
    if (
      user.accessStatus === "active" ||
      user.accessStatus === "telegram_premium"
    ) {
      return next();
    }
    return res.status(403).json({ error: "Access denied" });
  };
};
