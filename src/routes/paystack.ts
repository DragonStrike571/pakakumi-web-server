import { Router } from "express";
import { verifyPayment, handleSuccessfulPayment } from "../services/paystack/paystack.js";

const router = Router();

// Paystack redirects here after a user attempts payment
router.get("/callback", async (req, res) => {
  const reference = req.query.reference as string;
  if (!reference || typeof reference !== "string" || reference.length > 200) {
    return res.status(400).send("Invalid or missing reference");
  }

  // Sanitize the reference for use in Paystack API
  const sanitizedRef = encodeURIComponent(reference.trim());

  try {
    const data = await verifyPayment(sanitizedRef);
    
    if (data.status && data.data.status === "success") {
      // Process successful payment
      await handleSuccessfulPayment(sanitizedRef, data.data);
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
