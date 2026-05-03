const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const razorpay = new Razorpay({
  key_id: "rzp_live_Sfc2FyAXBZfg01",
  key_secret: process.env.RAZORPAY_SECRET
});

app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, phone } = req.body;

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 1,
      total_count: 9999,
      notify_info: { notify_phone: phone },
      notes: { phone }
    });

    res.json({
      success: true,
      subscription_id: subscription.id
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = app; 
