import { Router } from "express";
import rateLimit from "express-rate-limit";
import { verifyPayment, handleSuccessfulPayment } from "../services/paystack/paystack.js";

const router = Router();
const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Paystack redirects here after a user attempts payment
router.get("/callback", callbackLimiter, async (req, res) => {
  const reference = req.query.reference as string;
  if (
    !reference ||
    typeof reference !== "string" ||
    !/^[A-Za-z0-9._=-]{1,200}$/.test(reference)
  ) {
    return res.status(400).send("Invalid or missing reference");
  }

  const sanitizedRef = reference.trim();

  try {
    const data = await verifyPayment(sanitizedRef);
    
    if (data.status && data.data?.status === "success") {
      // Process successful payment
      const fulfilled = await handleSuccessfulPayment(sanitizedRef, data.data);
      if (!fulfilled) return res.status(422).send("The verified payment could not be matched to a valid order. Contact support with your reference.");
      res.send("Payment successful! Your access is active and the invite is queued for Telegram delivery. Use /status to request another invite.");
    } else {
      res.send("Payment verification is pending or failed. Please check your Telegram bot for updates.");
    }
  } catch (err) {
    console.error("Error verifying payment callback:", err);
    res.status(500).send("Error verifying payment");
  }
});

export default router;
