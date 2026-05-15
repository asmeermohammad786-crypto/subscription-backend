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

app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, phone } = req.body;

    if (!plan_id) {
      return res.json({ success: false, error: "plan_id missing" });
    }

    // 3 din baad start hoga
    const threeDaysLater = Math.floor(Date.now() / 1000) + (3 * 24 * 60 * 60);

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 1,
      total_count: plan_id === "plan_SdVs0uO9gIHYDk" ? 240 : 520,
      start_at: threeDaysLater,
      addons: [{
        item: {
          amount: 1000,
          currency: "INR",
          name: "Trial Fee"
        }
      }],
      notify_info: { notify_phone: phone },
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
