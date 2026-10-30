const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
// keep raw body so webhook signature can be verified
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
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
  "plan_Tc0uU5fR5yUBcc": 1,    // One-Time  -> charges only once, then stops
  "plan_Tt9x60DcA9fUZ8": 240,  // Test Rs199 Monthly -> 20 years
  "plan_Tu8oaBwvbXwrAo": 240   // Account Services Rs299 Monthly -> 20 years
};

// How many days after signup the subscription's first recurring charge
// should start. Anything not listed here uses DEFAULT_START_DELAY_DAYS.
const DEFAULT_START_DELAY_DAYS = 3;
const PLAN_START_DELAY_DAYS = {
  "plan_Tt9x60DcA9fUZ8": 1,  // Test Rs199 -> first debit due after 1 day
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

function firstStartEpoch(plan_id) {
  const fixedDay = PLAN_FIXED_BILLING_DAY[plan_id];
  return fixedDay
    ? nextFixedBillingDayEpoch(fixedDay)
    : Math.floor(Date.now() / 1000) + ((PLAN_START_DELAY_DAYS[plan_id] || DEFAULT_START_DELAY_DAYS) * 24 * 60 * 60);
}

/* ===================== OLD SYSTEM (unchanged) ===================== */

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

    const startAt = firstStartEpoch(plan_id);

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

/* ============ NEW SYSTEM: mandate + own retry (every 5 days, max 300) ============ */

const RETRY_EVERY_DAYS = 5;
const MAX_RETRIES = 300;
const CRON_BATCH = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

let cachedClient = null;
async function getDb() {
  if (!cachedClient) {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    cachedClient = client;
  }
  return cachedClient.db("edu");
}

function mandateFrequency(plan) {
  if (plan.period === "yearly") return "yearly";
  if (plan.period === "monthly" && plan.interval === 3) return "quarterly";
  if (plan.period === "monthly" && plan.interval === 1) return "monthly";
  return "as_presented";
}

// add n months in IST keeping the original billing day (clamped to month end)
function addMonths(ms, n, anchorDay) {
  const d = new Date(ms + IST_OFFSET_MS);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + n;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, lastDay);
  return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), 0) - IST_OFFSET_MS;
}

function nextDueMs(m) {
  if (m.period === "yearly") return addMonths(m.due_at, 12 * m.interval, m.anchor_day);
  if (m.period === "monthly") return addMonths(m.due_at, m.interval, m.anchor_day);
  if (m.period === "weekly") return m.due_at + 7 * m.interval * DAY_MS;
  return m.due_at + m.interval * DAY_MS;
}

// Step 1: customer authorises a mandate (frontend opens Razorpay Checkout with the returned order_id)
app.post("/create-mandate", async (req, res) => {
  try {
    const { plan_id, phone, email, name, method } = req.body;
    if (!plan_id || !phone || !email) {
      return res.json({ success: false, error: "plan_id, phone and email required" });
    }
    const total_count = PLAN_TOTAL_COUNTS[plan_id];
    if (!total_count) {
      return res.json({ success: false, error: "Unknown plan_id" });
    }
    const payMethod = method === "card" ? "card" : "upi";

    const plan = await razorpay.plans.fetch(plan_id);
    const amount = plan.item.amount; // paise

    const customer = await razorpay.customers.create({
      name: name || email,
      email,
      contact: phone,
      fail_existing: "0"
    });

    const years = payMethod === "upi" ? 20 : 10;
    const order = await razorpay.orders.create({
      amount: 1000, // ₹10 authorisation payment
      currency: "INR",
      payment_capture: true,
      method: payMethod,
      customer_id: customer.id,
      receipt: "mandate_" + Date.now(),
      notes: { plan_id, phone, email },
      token: {
        max_amount: amount,
        expire_at: Math.floor(Date.now() / 1000) + years * 365 * 24 * 60 * 60,
        frequency: mandateFrequency(plan)
      }
    });

    const firstDueMs = firstStartEpoch(plan_id) * 1000;
    const db = await getDb();
    await db.collection("mandates").insertOne({
      auth_order_id: order.id,
      customer_id: customer.id,
      plan_id,
      phone,
      email,
      method: payMethod,
      amount,
      period: plan.period,
      interval: plan.interval,
      total_count,
      paid_count: 0,
      retry_count: 0,
      status: "pending",
      anchor_day: new Date(firstDueMs + IST_OFFSET_MS).getUTCDate(),
      due_at: firstDueMs,
      next_attempt_at: new Date(firstDueMs),
      created_at: new Date()
    });

    res.json({
      success: true,
      order_id: order.id,
      customer_id: customer.id,
      key_id: "rzp_live_SkJZAnmCm3jnMA",
      amount: 1000
    });
  } catch (err) {
    console.error("Mandate Error:", err);
    res.status(500).json({
      success: false,
      error: err.message || err.error?.description || JSON.stringify(err)
    });
  }
});

// Step 2: Razorpay tells us what happened
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", process.env.WEBHOOK_SECRET || "")
      .update(req.rawBody || "")
      .digest("hex");
    if (
      !signature ||
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return res.status(400).send("bad signature");
    }

    const event = req.body.event;
    const payment = req.body.payload && req.body.payload.payment && req.body.payload.payment.entity;
    const db = await getDb();
    const mandates = db.collection("mandates");

    if (event === "payment.captured" && payment) {
      // first (authorisation) payment -> mandate becomes active
      const auth = await mandates.updateOne(
        { auth_order_id: payment.order_id, status: "pending" },
        { $set: { status: "active", token_id: payment.token_id, activated_at: new Date() } }
      );
      if (auth.modifiedCount === 0) {
        // a recurring debit succeeded
        const m = await mandates.findOne({
          "last_debit.order_id": payment.order_id,
          "last_debit.status": "pending"
        });
        if (m) {
          const paid = m.paid_count + 1;
          const done = paid >= m.total_count;
          const nextDue = nextDueMs(m);
          await mandates.updateOne(
            { _id: m._id, "last_debit.order_id": payment.order_id, "last_debit.status": "pending" },
            {
              $set: {
                paid_count: paid,
                retry_count: 0,
                status: done ? "completed" : "active",
                due_at: nextDue,
                next_attempt_at: new Date(nextDue),
                "last_debit.status": "captured",
                "last_debit.payment_id": payment.id
              }
            }
          );
        }
      }
    }

    if (event === "payment.failed" && payment) {
      // a recurring debit failed -> retry again after 5 days
      await mandates.updateOne(
        { "last_debit.order_id": payment.order_id, "last_debit.status": "pending" },
        {
          $inc: { retry_count: 1 },
          $set: {
            "last_debit.status": "failed",
            "last_debit.reason": payment.error_description || payment.error_reason || "",
            next_attempt_at: new Date(Date.now() + RETRY_EVERY_DAYS * DAY_MS)
          }
        }
      );
    }

    if (event === "token.cancelled") {
      const tok = req.body.payload && req.body.payload.token && req.body.payload.token.entity;
      if (tok && tok.id) {
        await mandates.updateOne({ token_id: tok.id }, { $set: { status: "cancelled" } });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("error");
  }
});

async function chargeMandate(mandates, m) {
  let state;
  try {
    const token = await razorpay.customers.fetchToken(m.customer_id, m.token_id);
    state = token && token.recurring_details && token.recurring_details.status;
  } catch (e) {
    state = undefined;
  }
  if (state === "cancelled" || state === "rejected") {
    await mandates.updateOne({ _id: m._id }, { $set: { status: "cancelled" } });
    return;
  }
  if (state === "paused" || state === "initiated") return;

  const order = await razorpay.orders.create({
    amount: m.amount,
    currency: "INR",
    payment_capture: true,
    receipt: "debit_" + Date.now(),
    notes: { mandate_id: String(m._id), plan_id: m.plan_id }
  });

  await mandates.updateOne(
    { _id: m._id },
    {
      $set: {
        last_debit: { order_id: order.id, status: "pending", at: new Date() },
        next_attempt_at: new Date(Date.now() + RETRY_EVERY_DAYS * DAY_MS)
      }
    }
  );

  try {
    await razorpay.payments.createRecurringPayment({
      email: m.email,
      contact: m.phone,
      amount: m.amount,
      currency: "INR",
      order_id: order.id,
      customer_id: m.customer_id,
      token: m.token_id,
      recurring: "1",
      description: "Subscription"
    });
  } catch (err) {
    await mandates.updateOne(
      { _id: m._id },
      {
        $inc: { retry_count: 1 },
        $set: {
          "last_debit.status": "failed",
          "last_debit.reason": (err && (err.message || (err.error && err.error.description))) || "create failed"
        }
      }
    );
    throw err;
  }
}

// Step 3: Vercel Cron calls this once a day
app.get("/cron", async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== "Bearer " + process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const db = await getDb();
    const mandates = db.collection("mandates");
    const due = await mandates
      .find({
        status: "active",
        next_attempt_at: { $lte: new Date() },
        retry_count: { $lt: MAX_RETRIES }
      })
      .limit(CRON_BATCH)
      .toArray();

    const results = await Promise.allSettled(due.map((m) => chargeMandate(mandates, m)));
    res.json({
      picked: due.length,
      ok: results.filter((r) => r.status === "fulfilled").length,
      failed: results.filter((r) => r.status === "rejected").length
    });
  } catch (err) {
    console.error("Cron Error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
