import type { RequestHandler } from "express";
import { gameScraper } from "../services/scraper.js";

/** Reject new provider-dependent operations while recovery is in progress. */
export function requireHealthySource(readStatus = () => gameScraper.getStatus()): RequestHandler {
  return (_req, res, next) => {
    const status = readStatus();
    if (status.healthy) return next();
    const seconds = status.nextRetryAt ? Math.max(1, Math.ceil((Date.parse(status.nextRetryAt) - Date.now()) / 1000)) : 30;
    res.setHeader("Retry-After", String(seconds));
    res.status(503).json({ code: "SOURCE_UNAVAILABLE", error: "Pakakumi collection is unavailable or waiting for new rounds. Try again after collection resumes." });
  };
}
