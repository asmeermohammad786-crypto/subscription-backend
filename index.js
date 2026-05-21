const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_live_SkJZAnmCm3jnMA",
  key_secret: process.env.RAZORPAY_SECRET
});

const PLANS = {
  '299': {
    id: 'plan_SrSddVrdCygFY9',
    startAfter: 36000,      // 10 hours
    totalCount: 240         // 20 years monthly
  },
  '499': {
    id: 'plan_SdVs0uO9gIHYDk',
    startAfter: 2592000,    // 1 month
    totalCount: 240         // 20 years monthly
  }
};

// Create Subscription
app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, plan_type, email, name } = req.body;

    if (!plan_type || !PLANS[plan_type]) {
      return res.json({ success: false, error: "Invalid plan" });
    }

    const plan = PLANS[plan_type];
    const startAt = Math.floor(Date.now() / 1000) + plan.startAfter;

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.id,
      customer_notify: 1,
      total_count: plan.totalCount,
      start_at: startAt,
      addons: [{
        item: {
          amount: 1000,
          currency: "INR",
          name: "Trial Fee"
        }
      }],
      notes: { email, name, plan_type }
    });

    res.json({ success: true, subscription_id: subscription.id });

  } catch (err) {
    console.error("Create subscription error:", err);
    res.status(500).json({
      success: false,
      error: err.message || err.error?.description || "Something went wrong"
    });
  }
});

// Verify Payment Signature
app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    const body = razorpay_payment_id + "|" + razorpay_subscription_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature === razorpay_signature) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: "Signature mismatch" });
    }
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Webhook Handler
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(req.body.toString());
    console.log("Webhook event:", event.event);

    // Handle events
    switch (event.event) {
      case "subscription.activated":
        console.log("Subscription activated:", event.payload.subscription.entity.id);
        break;
      case "subscription.halted":
        console.log("Subscription halted:", event.payload.subscription.entity.id);
        // Add notification logic here
        break;
      case "subscription.charged":
        console.log("Payment charged:", event.payload.payment.entity.id);
        break;
      case "payment.failed":
        console.log("Payment failed:", event.payload.payment.entity.id);
        break;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", time: new Date().toISOString() });
});

module.exports = app;
