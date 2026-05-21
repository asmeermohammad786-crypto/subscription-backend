const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: "*" }));

// ─── Razorpay Instance ────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_live_SkJZAnmCm3jnMA",
  key_secret: process.env.RAZORPAY_SECRET,
});

// ─── Plans Config ─────────────────────────────────────────────────────────────
// ₹299 plan  → ₹10 trial today, subscription starts after 10 hours (36000s)
// ₹499 plan  → ₹10 trial today, subscription starts after 1 month  (2592000s)
const PLANS = {
  "299": {
    id: "plan_SrSddVrdCygFY9",
    label: "2 Monthly",
    amount: 29900,        // ₹299 in paise
    trialFee: 1000,       // ₹10 trial in paise
    startAfter: 36000,    // 10 hours in seconds
    totalCount: 240,      // 20 years monthly
  },
  "499": {
    id: "plan_SdVs0uO9gIHYDk",
    label: "4 Monthly",
    amount: 49900,        // ₹499 in paise
    trialFee: 1000,       // ₹10 trial in paise
    startAfter: 2592000,  // 1 month in seconds
    totalCount: 240,      // 20 years monthly
  },
};

// ─── Input Validation Helpers ─────────────────────────────────────────────────

/**
 * Validates Indian mobile number (10 digits, starts with 6-9).
 */
function isValidMobile(mobile) {
  return /^[6-9]\d{9}$/.test(String(mobile).trim());
}

/**
 * Sanitises a string — strips HTML/script tags, trims whitespace.
 */
function sanitise(str) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").trim().slice(0, 200);
}

// ─── POST /create-subscription ────────────────────────────────────────────────
/**
 * Creates a Razorpay subscription with ₹10 trial addon.
 *
 * Body: { plan_type: "299"|"499", mobile: "9876543210", name?: string }
 * Returns: { success: true, subscription_id, key_id }
 */
app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_type, mobile, name } = req.body;

    // — Validate plan
    if (!plan_type || !PLANS[plan_type]) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan. Choose 299 or 499.",
      });
    }

    // — Validate mobile number
    const cleanMobile = String(mobile || "").replace(/\D/g, "");
    if (!isValidMobile(cleanMobile)) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid 10-digit Indian mobile number.",
      });
    }

    const cleanName = sanitise(name) || "User";
    const plan = PLANS[plan_type];
    const startAt = Math.floor(Date.now() / 1000) + plan.startAfter;

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.id,
      customer_notify: 1,
      total_count: plan.totalCount,
      start_at: startAt,
      addons: [
        {
          item: {
            amount: plan.trialFee,  // ₹10 in paise
            currency: "INR",
            name: "Trial Fee",
          },
        },
      ],
      notes: {
        mobile: cleanMobile,
        name: cleanName,
        plan_type,
        plan_label: plan.label,
      },
    });

    res.json({
      success: true,
      subscription_id: subscription.id,
      key_id: process.env.RAZORPAY_KEY_ID || "rzp_live_SkJZAnmCm3jnMA",
      plan_label: plan.label,
      trial_amount: plan.trialFee,
      prefill: {
        contact: `+91${cleanMobile}`,
        name: cleanName,
      },
    });
  } catch (err) {
    console.error("❌ Create subscription error:", err);
    res.status(500).json({
      success: false,
      error:
        err?.error?.description ||
        err?.message ||
        "Subscription creation failed. Please try again.",
    });
  }
});

// ─── POST /verify-payment ─────────────────────────────────────────────────────
/**
 * Verifies Razorpay payment signature after checkout.
 *
 * Body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
 * Returns: { success: true|false }
 */
app.post("/verify-payment", (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } =
      req.body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment verification fields.",
      });
    }

    const secret = process.env.RAZORPAY_SECRET;
    if (!secret) {
      console.error("❌ RAZORPAY_SECRET not set");
      return res.status(500).json({ success: false, error: "Server config error." });
    }

    const body = `${razorpay_payment_id}|${razorpay_subscription_id}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      console.log("✅ Payment verified:", razorpay_payment_id);
      res.json({ success: true, payment_id: razorpay_payment_id });
    } else {
      console.warn("⚠️  Signature mismatch for payment:", razorpay_payment_id);
      res.status(400).json({ success: false, error: "Payment verification failed." });
    }
  } catch (err) {
    console.error("❌ Verify payment error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /webhook ────────────────────────────────────────────────────────────
/**
 * Handles Razorpay webhook events.
 * Uses raw body for signature verification.
 */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const signature = req.headers["x-razorpay-signature"];
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

      if (!secret) {
        console.error("❌ RAZORPAY_WEBHOOK_SECRET not set");
        return res.status(500).json({ error: "Server config error." });
      }

      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      if (expectedSignature !== signature) {
        console.warn("⚠️  Invalid webhook signature");
        return res.status(400).json({ error: "Invalid signature." });
      }

      const event = JSON.parse(req.body.toString());
      console.log("📩 Webhook event:", event.event);

      switch (event.event) {
        case "subscription.activated": {
          const sub = event.payload.subscription.entity;
          console.log("✅ Subscription ACTIVATED:", sub.id, "| Plan notes:", sub.notes);
          // TODO: Mark user as active in your DB using sub.notes.mobile
          break;
        }
        case "subscription.charged": {
          const payment = event.payload.payment.entity;
          console.log("💰 Subscription CHARGED:", payment.id);
          // TODO: Log payment record
          break;
        }
        case "subscription.halted": {
          const sub = event.payload.subscription.entity;
          console.log("⏸️  Subscription HALTED:", sub.id);
          // TODO: Notify user via SMS/email
          break;
        }
        case "subscription.cancelled": {
          const sub = event.payload.subscription.entity;
          console.log("❌ Subscription CANCELLED:", sub.id);
          // TODO: Revoke user access
          break;
        }
        case "payment.failed": {
          const payment = event.payload.payment.entity;
          console.log("❌ Payment FAILED:", payment.id, "| Error:", payment.error_description);
          // TODO: Notify user of failure
          break;
        }
        default:
          console.log("ℹ️  Unhandled event:", event.event);
      }

      res.json({ success: true });
    } catch (err) {
      console.error("❌ Webhook error:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── GET /plans ───────────────────────────────────────────────────────────────
/**
 * Returns available plans for the frontend.
 */
app.get("/plans", (req, res) => {
  const publicPlans = Object.entries(PLANS).map(([key, plan]) => ({
    plan_type: key,
    label: plan.label,
    amount: plan.amount / 100,           // in ₹
    trial_fee: plan.trialFee / 100,      // in ₹
    start_after_hours: plan.startAfter / 3600,
  }));
  res.json({ success: true, plans: publicPlans });
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    time: new Date().toISOString(),
    plans: Object.keys(PLANS),
  });
});

// ─── 404 Fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found." });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error." });
});

module.exports = app;
