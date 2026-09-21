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
  "plan_TeWkqaj3X32wuk": 240,  // Monthly Pro -> 20 years
  "plan_SrSddVrdCygFY9": 240,  // Monthly   -> 20 years
  "plan_TanS4m0D2qSrG1": 80,   // 3 Months  -> 20 years
  "plan_TanTRDITY0FhiH": 20,   // Yearly    -> 20 years
  "plan_Tc0uU5fR5yUBcc": 1     // One-Time  -> charges only once, then stops
};

// How many days after signup the subscription's first recurring charge
// should start. Anything not listed here uses DEFAULT_START_DELAY_DAYS.
const DEFAULT_START_DELAY_DAYS = 3;
const PLAN_START_DELAY_DAYS = {
  "plan_Tc0uU5fR5yUBcc": 15  // One-Time (₹40,000) -> starts 15 days later
};

// Plans that must always bill on a fixed day-of-month (IST), instead of a
// fixed number of days after signup. Razorpay repeats a monthly plan's
// charge on the same day-of-month as its start_at date, so pinning start_at
// to that day locks every future cycle to it too.
const PLAN_FIXED_BILLING_DAY = {
  "plan_TeWkqaj3X32wuk": 14 // Monthly Pro -> always charges on the 14th (IST)
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const FIXED_BILLING_HOUR_IST = 5; // 5:00 AM IST

// Returns the epoch seconds (UTC) for the next occurrence of `day` of the
// month, at FIXED_BILLING_HOUR_IST (IST). If today (IST) is already past
// `day`, rolls to next month.
function nextFixedBillingDayEpoch(day) {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  let year = nowIST.getUTCFullYear();
  let month = nowIST.getUTCMonth(); // 0-indexed
  const todayDate = nowIST.getUTCDate();

  if (todayDate >= day) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }

  const targetUTCms = Date.UTC(year, month, day, FIXED_BILLING_HOUR_IST, 0, 0) - IST_OFFSET_MS;
  return Math.floor(targetUTCms / 1000);
}

app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, phone, email } = req.body;

    if (!plan_id) {
      return res.json({ success: false, error: "plan_id missing" });
    }

    const total_count = PLAN_TOTAL_COUNTS[plan_id];
    if (!total_count) {
      return res.json({ success: false, error: "Unknown plan_id" });
    }

    const fixedDay = PLAN_FIXED_BILLING_DAY[plan_id];
    const startAt = fixedDay
      ? nextFixedBillingDayEpoch(fixedDay)
      : Math.floor(Date.now() / 1000) + ((PLAN_START_DELAY_DAYS[plan_id] || DEFAULT_START_DELAY_DAYS) * 24 * 60 * 60);

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 0, // Razorpay email/SMS notifications OFF
      total_count: total_count,
      start_at: startAt,
      addons: [{
        item: {
          amount: 1000, // ₹10 trial fee
          currency: "INR",
          name: "Trial Fee"
        }
      }],
      notes: { phone, email }
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
