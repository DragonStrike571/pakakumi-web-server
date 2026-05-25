import { Request } from "express";

/**
 * Extended Request type for routes behind `requireAuth` middleware.
 * Provides typed access to `user` and `session` set by the auth middleware.
 */
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
}
