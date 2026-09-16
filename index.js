const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const razorpay = new Razorpay({
  key_id: "rzp_live_SkJZAnmCm3jnMA",
  key_secret: process.env.RAZORPAY_SECRET
});

// Must stay in sync with the PLANS array in the frontend (index.html).
// total_count = roughly how many cycles equal ~20 years for each frequency.
const PLAN_TOTAL_COUNTS = {
  "plan_TanIpjsinfLLwo": 730,  // 10 Days   -> ~20 years
  "plan_SrSddVrdCygFY9": 240,  // Monthly   -> 20 years
  "plan_TanS4m0D2qSrG1": 80,   // 3 Months  -> 20 years
  "plan_TanTRDITY0FhiH": 20,   // Yearly    -> 20 years
  "plan_TcOuU5fR5yUBcc": 1     // One-Time  -> charges only once, then stops
};

app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, phone } = req.body;

    if (!plan_id) {
      return res.json({ success: false, error: "plan_id missing" });
    }

    const total_count = PLAN_TOTAL_COUNTS[plan_id];
    if (!total_count) {
      return res.json({ success: false, error: "Unknown plan_id" });
    }

    // 3 din baad subscription shuru hoga
    const threeDaysLater = Math.floor(Date.now() / 1000) + (3 * 24 * 60 * 60);

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 0, // Razorpay email/SMS notifications OFF
      total_count: total_count,
      start_at: threeDaysLater,
      addons: [{
        item: {
          amount: 1000, // ₹10 trial fee
          currency: "INR",
          name: "Trial Fee"
        }
      }],
      notes: { phone }
    });

    res.json({
      success: true,
      subscription_id: subscription.id
    });

  } catch (err) {
    console.error("Razorpay Error:", err);
    res.status(500).json({
      success: false,
      error: err.message || err.error?.description || JSON.stringify(err)
    });
  }
});

module.exports = app;
