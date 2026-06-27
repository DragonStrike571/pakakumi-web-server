import { Router } from "express";
import { db } from "../db/index.js";
import { payments, telegramUsers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { bot } from "../services/telegram/bot.js";
import { verifyPayment, handleSuccessfulPayment } from "../services/paystack/paystack.js";

const router = Router();

// Paystack redirects here after a user attempts payment
router.get("/callback", async (req, res) => {
  const reference = req.query.reference as string;
  if (!reference) {
    return res.status(400).send("No reference provided");
  }

  try {
    const data = await verifyPayment(reference);
    
    if (data.status && data.data.status === "success") {
      // Process successful payment
      await handleSuccessfulPayment(reference, data.data);
      res.send("Payment successful! You can close this window and return to Telegram.");
    } else {
      res.send("Payment verification is pending or failed. Please check your Telegram bot for updates.");
    }
  } catch (err) {
    console.error("Error verifying payment callback:", err);
    res.status(500).send("Error verifying payment");
  }
});



export default router;
