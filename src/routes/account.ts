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
import { GAME_SELECTORS } from "../utils/selectors.js";

const router = Router();

router.use(requireAuth);

// ────────────────────── Credential CRUD ──────────────────────

const saveCredentialSchema = z.object({
  label: z.string().min(1, "Label is required"),
  phone: z.string().min(1, "Phone is required"),
  password: z.string().min(1, "Password is required"),
});

/**
 * POST /account/credentials — Save encrypted credentials
 */
router.post("/credentials", async (req: Request, res: Response) => {
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
  credentialId: z.string().uuid().optional(),
  phone: z.string().min(1).optional(),
  pass: z.string().min(1).optional(),
});

/**
 * POST /account/balance — Check Pakakumi balance via headless browser
 * Accepts either { credentialId } or { phone, pass }
 */
router.post("/balance", async (req: Request, res: Response) => {
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

  const { data: balance, error: scrapeError } = await trycatch(async () => {
    const { context } = await balancePool.getContext();

    try {
      const page = await context.newPage();
      await page.goto("https://play.pakakumi.com/login", {
        waitUntil: "networkidle",
        timeout: 15000,
      });

      console.log("[Balance] Login page loaded, filling form...");

      // Wait for login fields - support both previous and current selectors
      await page.waitForSelector(GAME_SELECTORS.LOGIN.PHONE_INPUT, { timeout: 10000 });

      // Try multiple possible selectors since game UI updates frequently
      const phoneInput = await page.$(GAME_SELECTORS.LOGIN.PHONE_INPUT);
      const passInput = await page.$(GAME_SELECTORS.LOGIN.PASS_INPUT);

      if (!phoneInput || !passInput) {
        throw new Error("Login fields not found on page");
      }

      await phoneInput.fill(phone);
      await passInput.fill(pass);

      const loginBtn = await page.$(GAME_SELECTORS.LOGIN.SUBMIT_BTN);
      if (!loginBtn) throw new Error("Login button not found");
      await loginBtn.click();

      console.log("[Balance] Login submitted, waiting for dashboard...");

      // Wait for the balance link to appear after login
      await page.waitForSelector('a[href="/account"]', {
        timeout: 20000,
      });

      console.log(
        "[Balance] Dashboard loaded, waiting for balance to hydrate...",
      );

      // Poll for the real balance (page hydrates "KES 0" then updates).
      const balanceText = await page.evaluate(async () => {
        for (let i = 0; i < 20; i++) {
          const links = document.querySelectorAll('a[href="/account"]');
          for (let j = 0; j < links.length; j++) {
            const text = links[j].textContent?.trim() || "";
            if (text.startsWith("KES")) {
              const num = parseFloat(text.replace(/[^0-9.]/g, ""));
              if (num > 0) return text;
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        // Final attempt — return whatever is there
        const finalLinks = document.querySelectorAll('a[href="/account"]');
        for (let j = 0; j < finalLinks.length; j++) {
          const text = finalLinks[j].textContent?.trim() || "";
          if (text.startsWith("KES")) return text;
        }
        return null;
      });

      console.log("[Balance] Raw balance text:", balanceText);

      if (balanceText) {
        const numStr = balanceText.replace(/[^0-9.,]/g, "").replace(/,/g, "");
        const parsed = parseFloat(numStr);
        return isNaN(parsed) ? null : parsed;
      }

      return null;
    } catch (error) {
      console.error("[Balance] Scrape error:", error);
      throw error;
    } finally {
      await balancePool.releaseContext(context);
    }
  });

  if (scrapeError) {
    console.error("[Balance] Overall error:", scrapeError);
    res
      .status(500)
      .json({ error: "Failed to check balance. Login may have failed." });
    return;
  }

  console.log("[Balance] Returning balance:", balance);
  res.json({ balance: balance ?? null });
});

export default router;
