import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { pakakumiCredentials } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { trycatch } from "../utils/try-catch.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { requireAuth } from "../middleware/auth.js";
import { AuthenticatedRequest } from "../types/express.js";
import { balancePool } from "../services/balance-pool.js";
import { checkPakakumiBalance } from "../utils/pakakumi-page.js";
import { requireActiveAccess } from "../middleware/access.js";
import rateLimit from "express-rate-limit";
import { requireHealthySource } from "../middleware/source.js";

const router = Router();

router.use(requireAuth);
router.use(requireActiveAccess());

const credentialsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const balanceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// ────────────────────── Credential CRUD ──────────────────────

const saveCredentialSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  phone: z.string().trim().min(5, "Phone is required").max(32),
  password: z.string().min(1, "Password is required").max(256),
});

/**
 * POST /account/credentials — Save encrypted credentials
 */
router.post("/credentials", credentialsLimiter, async (req: Request, res: Response) => {
  const validation = saveCredentialSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({ error: validation.error.format() });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  const { label, phone, password } = validation.data;

  const { data: credential, error } = await trycatch(async () => {
    const result = await db
      .insert(pakakumiCredentials)
      .values({
        userId,
        label,
        phone: encrypt(phone),
        password: encrypt(password),
      })
      .returning({ id: pakakumiCredentials.id });
    return result[0];
  });

  if (error || !credential) {
    console.error("Error saving credential:", error);
    res.status(500).json({ error: "Failed to save credentials" });
    return;
  }

  res.status(201).json({ id: credential.id, label, phone });
});

/**
 * GET /account/credentials — List saved credentials (phone only, no passwords)
 */
router.get("/credentials", async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user.id;

  const { data: creds, error } = await trycatch(async () => {
    return await db.query.pakakumiCredentials.findMany({
      where: eq(pakakumiCredentials.userId, userId),
      columns: {
        id: true,
        label: true,
        phone: true,
        createdAt: true,
      },
    });
  });

  if (error) {
    console.error("Error fetching credentials:", error);
    res.status(500).json({ error: "Failed to fetch credentials" });
    return;
  }

  // Decrypt phone for display, never return password
  const result = (creds || []).map((c) => ({
    id: c.id,
    label: c.label,
    phone: decrypt(c.phone),
    createdAt: c.createdAt,
  }));

  res.json(result);
});

/**
 * DELETE /account/credentials/:id — Remove saved credentials
 */
router.delete("/credentials/:id", async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user.id;
  const credentialId = req.params.id as string;

  const { error } = await trycatch(async () => {
    await db
      .delete(pakakumiCredentials)
      .where(
        and(
          eq(pakakumiCredentials.id, credentialId),
          eq(pakakumiCredentials.userId, userId),
        ),
      );
  });

  if (error) {
    console.error("Error deleting credential:", error);
    res.status(500).json({ error: "Failed to delete credential" });
    return;
  }

  res.status(204).send();
});

// ────────────────────── Balance Check ──────────────────────

const balanceCheckSchema = z.object({
  credentialId: z.uuid().optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  pass: z.string().min(1).max(256).optional(),
}).refine(
  (value) => Boolean(value.credentialId) !== Boolean(value.phone && value.pass),
  { message: "Provide either credentialId or phone+pass, not both" },
);

/**
 * POST /account/balance — Check Pakakumi balance via headless browser
 * Accepts either { credentialId } or { phone, pass }
 */
router.post("/balance", balanceLimiter, requireHealthySource(), async (req: Request, res: Response) => {
  const validation = balanceCheckSchema.safeParse(req.body);
  if (!validation.success) {
    res
      .status(400)
      .json({ error: "Provide either credentialId or phone+pass" });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  const { credentialId, phone: rawPhone, pass: rawPass } = validation.data;

  let phone: string;
  let pass: string;

  if (credentialId) {
    const { data: cred, error } = await trycatch(async () => {
      return await db.query.pakakumiCredentials.findFirst({
        where: and(
          eq(pakakumiCredentials.id, credentialId),
          eq(pakakumiCredentials.userId, userId),
        ),
      });
    });

    if (error || !cred) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

    phone = decrypt(cred.phone);
    pass = decrypt(cred.password);
  } else if (rawPhone && rawPass) {
    phone = rawPhone;
    pass = rawPass;
  } else {
    res
      .status(400)
      .json({ error: "Provide either credentialId or phone+pass" });
    return;
  }

  console.log("[Balance] Starting balance check...");

  const BALANCE_TIMEOUT_MS = 30_000; // Hard timeout for the entire balance check
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Balance request cancelled"));
  const onClosed = () => { if (!res.writableEnded) cancel(); };
  req.once("aborted", cancel);
  res.once("close", onClosed);

  const { data: balance, error: scrapeError } = await trycatch(async () => {
    const balancePromise = (async () => {
    const { context } = await balancePool.getContext(controller.signal);

    try {
      const page = await context.newPage();
      return await checkPakakumiBalance(page, phone, pass);
    } catch (error) {
      console.error("[Balance] Scrape error:", error);
      throw error;
    } finally {
      await balancePool.releaseContext(context);
    }
    })();

    // Hard timeout to prevent indefinite hangs
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("Balance check timed out after 30s"));
        reject(controller.signal.reason);
      }, BALANCE_TIMEOUT_MS);
    });
    try { return await Promise.race([balancePromise, timeout]); }
    finally { clearTimeout(timer!); req.removeListener("aborted", cancel); res.removeListener("close", onClosed); }
  });

  if (scrapeError) {
    console.error("[Balance] Overall error:", scrapeError);
    res
      .status(500)
      .json({ error: "Failed to check balance. Login may have failed." });
    return;
  }

  res.json({ balance: balance ?? null });
});

export default router;
