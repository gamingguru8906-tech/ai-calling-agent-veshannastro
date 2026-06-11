/**
 * Maayannastro — VAPI Booking Backend
 * Endpoint: POST /api/vapi-booking
 *
 * What it does on each booking:
 *   1. Saves booking to Neon Postgres
 *   2. Logs to Google Sheets (optional, via Apps Script webhook)
 *   3. Creates a Razorpay Payment Link
 *   4. Sends WhatsApp confirmation + payment link (AiSensy or Twilio)
 *
 * Deploy on Render. Set env vars listed in .env.example
 */

const express = require("express");
const { Pool } = require("pg");
const Razorpay = require("razorpay");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Neon Postgres URL
  ssl: { rejectUnauthorized: false },
});

const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
    : null;

// Service pricing (paise). Update to match your live site.
// Free email via Gmail SMTP (App Password required, 500/day free)
const mailer =
  process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      })
    : null;

async function sendEmail(to, subject, html) {
  if (!mailer || !to) return false;
  try {
    await mailer.sendMail({
      from: `"Veshannastro" <${process.env.GMAIL_USER}>`,
      to, subject, html,
    });
    return true;
  } catch (e) {
    console.error("Email failed:", e.message);
    return false;
  }
}

function bookingEmailHtml(b, svcLabel, payUrl) {
  return `
  <div style="font-family:Georgia,serif;max-width:560px;margin:auto;background:#0d0b1e;color:#e8d9b0;padding:32px;border-radius:12px">
    <h1 style="color:#d4af37;font-size:22px;margin-top:0">🙏 Namaste ${b.client_name}!</h1>
    <p>Your <b style="color:#d4af37">${svcLabel}</b> with Veshannastro is reserved.</p>
    <table style="width:100%;color:#e8d9b0;font-size:14px">
      ${b.preferred_date && b.preferred_date !== "NA" ? `<tr><td>📅 Session</td><td>${b.preferred_date} at ${b.preferred_time}</td></tr>` : ""}
      <tr><td>🔮 Service</td><td>${svcLabel}</td></tr>
      <tr><td>📱 WhatsApp</td><td>+${b.whatsapp}</td></tr>
    </table>
    ${payUrl ? `<p style="text-align:center;margin:28px 0">
      <a href="${payUrl}" style="background:#d4af37;color:#0d0b1e;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold">Complete Payment to Confirm ✨</a>
    </p><p style="font-size:12px;color:#9b8a5e">Your slot is confirmed the moment payment is complete. UPI, cards and net banking accepted.</p>` : ""}
    <p style="font-size:12px;color:#9b8a5e;border-top:1px solid #2a2547;padding-top:16px">Veshannastro · Vedic Astrology & Numerology · <a href="https://veshannastro.co.in" style="color:#d4af37">veshannastro.co.in</a></p>
  </div>`;
}

function paidEmailHtml(b, svcLabel) {
  return `
  <div style="font-family:Georgia,serif;max-width:560px;margin:auto;background:#0d0b1e;color:#e8d9b0;padding:32px;border-radius:12px">
    <h1 style="color:#d4af37;font-size:22px;margin-top:0">✅ Payment Received — Order Confirmed!</h1>
    <p>Thank you ${b.client_name}! Your <b style="color:#d4af37">${svcLabel}</b> is now fully confirmed.</p>
    ${b.preferred_date && b.preferred_date !== "NA"
      ? `<p>📅 <b>${b.preferred_date} at ${b.preferred_time}</b> — your Zoom link will be shared on WhatsApp before the session.</p>`
      : `<p>Your report/voice reply is being prepared — written reports arrive within 2-3 hours, voice replies within 24 hours.</p>`}
    <p>You will receive after your consultation: detailed PDF report, session recording, and an itemised invoice.</p>
    <p style="font-size:12px;color:#9b8a5e;border-top:1px solid #2a2547;padding-top:16px">Veshannastro · <a href="https://veshannastro.co.in" style="color:#d4af37">veshannastro.co.in</a></p>
  </div>`;
}

// Live pricing from veshannastro.co.in (25% OFF rates, in paise)
const SERVICE_PRICING = {
  kundli: { label: "Vedic Kundli Consultation (40-min Zoom + PDF report)", amount: 224900 },
  one_question: { label: "One Question Voice Reply (WhatsApp)", amount: 20200 },
  numerology: { label: "Numerology Session", amount: 82400 },
  name_numerology_report: { label: "Name Numerology Report", amount: 25000 },
  mobile_numerology_report: { label: "Mobile Number Analysis Report", amount: 25000 },
  complete_numerology_report: { label: "Complete Numerology Report (Full Blueprint)", amount: 99900 },
  business_name_report: { label: "Business Name Report", amount: 49900 },
  baby_name_report: { label: "Baby Name Report", amount: 25000 },
  palm_reading: { label: "Palmistry Report", amount: 14900 },
  palm_voice: { label: "Palmistry Voice Consultation (report + 10-min voice)", amount: 37400 },
};

// ---------- DB init ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vapi_bookings (
      id SERIAL PRIMARY KEY,
      client_name TEXT NOT NULL,
      service TEXT NOT NULL,
      dob TEXT,
      birth_time TEXT,
      birth_city TEXT,
      whatsapp TEXT NOT NULL,
      email TEXT,
      preferred_date TEXT,
      preferred_time TEXT,
      source TEXT DEFAULT 'voice_agent',
      payment_link TEXT,
      payment_status TEXT DEFAULT 'pending',
      razorpay_link_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log("✅ DB ready");
}

// ---------- Helpers ----------
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits; // assume India
  return digits;
}

async function createPaymentLink(booking) {
  if (!razorpay) return null;
  const svc = SERVICE_PRICING[booking.service];
  if (!svc) return null;

  const link = await razorpay.paymentLink.create({
    amount: svc.amount,
    currency: "INR",
    accept_partial: false,
    description: `${svc.label} — Maayannastro`,
    customer: {
      name: booking.client_name,
      contact: "+" + booking.whatsapp,
      email: booking.email || undefined,
    },
    notify: { sms: true, email: !!booking.email },
    reminder_enable: true,
    notes: {
      service: booking.service,
      preferred_date: booking.preferred_date || "",
      preferred_time: booking.preferred_time || "",
      source: "vapi_voice_agent",
    },
    callback_url: "https://veshannastro.co.in/payment-success",
    callback_method: "get",
  });
  return link;
}

async function sendWhatsApp(booking, paymentUrl) {
  const phone = booking.whatsapp;
  const svc = SERVICE_PRICING[booking.service]?.label || booking.service;

  const message =
    `🙏 Namaste ${booking.client_name}!\n\n` +
    `Your *${svc}* session with Maayannastro is reserved:\n` +
    `📅 ${booking.preferred_date} at ${booking.preferred_time}\n\n` +
    (paymentUrl
      ? `To confirm, please complete payment here:\n${paymentUrl}\n\n`
      : "") +
    `Our astrologer will connect with you at the scheduled time.\n` +
    `🌐 veshannastro.co.in`;

  // Option A: AiSensy
  if (process.env.AISENSY_API_KEY) {
    const res = await fetch("https://backend.aisensy.com/campaign/t1/api/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: process.env.AISENSY_API_KEY,
        campaignName: process.env.AISENSY_CAMPAIGN || "vapi_booking_confirm",
        destination: phone,
        userName: booking.client_name,
        templateParams: [
          booking.client_name,
          svc,
          `${booking.preferred_date} ${booking.preferred_time}`,
          paymentUrl || "veshannastro.co.in",
        ],
      }),
    });
    return res.ok;
  }

  // Option B: Twilio WhatsApp
  if (process.env.TWILIO_SID && process.env.TWILIO_AUTH) {
    const auth = Buffer.from(
      `${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH}`
    ).toString("base64");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: process.env.TWILIO_WHATSAPP_FROM, // e.g. whatsapp:+14155238886
          To: `whatsapp:+${phone}`,
          Body: message,
        }),
      }
    );
    return res.ok;
  }

  console.log("⚠️ No WhatsApp provider configured. Message would be:\n", message);
  return false;
}

async function logToGoogleSheets(booking, paymentUrl) {
  // Uses a Google Apps Script Web App URL (same pattern as your booking system)
  if (!process.env.GSHEET_WEBHOOK_URL) return;
  try {
    await fetch(process.env.GSHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "new_booking",
        timestamp: new Date().toISOString(),
        ...booking,
        payment_link: paymentUrl || "",
        payment_status: "pending",
      }),
    });
  } catch (e) {
    console.error("Sheets logging failed:", e.message);
  }
}

// ---------- Routes ----------
app.get("/", (_, res) => res.json({ status: "Maaya booking API live 🌟" }));

app.post("/api/vapi-booking", async (req, res) => {
  try {
    // Accept both shapes: direct JSON (workflow/curl) OR VAPI assistant tool-call
    let p = req.body || {};
    let toolCallId = null;
    if (p.message && Array.isArray(p.message.toolCalls) && p.message.toolCalls.length) {
      const tc = p.message.toolCalls[0];
      toolCallId = tc.id;
      let args = tc.function && tc.function.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = {}; } }
      p = args || {};
    } else if (p.message && p.message.functionCall) {
      // older function-call shape
      let args = p.message.functionCall.parameters;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch (e) { args = {}; } }
      p = args || {};
    }

    const client_name = p.client_name;
    const service = p.service;
    const dob = p.dob;
    const birth_time = p.birth_time;
    const birth_city = p.birth_city;
    const whatsapp = p.whatsapp || p.whatsapp_number;
    const email = p.email;
    const preferred_date = p.preferred_date;
    const preferred_time = p.preferred_time;
    const source = p.source || "voice_assistant";

    // Validation
    if (!client_name || !service || !whatsapp) {
      return res.status(400).json({
        success: false,
        error: "client_name, service and whatsapp are required",
      });
    }
    if (!SERVICE_PRICING[service]) {
      return res.status(400).json({
        success: false,
        error: `Unknown service '${service}'. Use: ${Object.keys(SERVICE_PRICING).join(", ")}`,
      });
    }

    const booking = {
      client_name: String(client_name).trim().slice(0, 100),
      service,
      dob: dob || null,
      birth_time: birth_time || null,
      birth_city: birth_city || null,
      whatsapp: normalizePhone(whatsapp),
      email: email || null,
      preferred_date: preferred_date || null,
      preferred_time: preferred_time || null,
      source: source || "voice_agent",
    };

    if (!booking.whatsapp || booking.whatsapp.length < 11) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid WhatsApp number" });
    }

    // 1. Razorpay payment link
    let paymentLink = null;
    try {
      paymentLink = await createPaymentLink(booking);
    } catch (e) {
      console.error("Razorpay link failed:", e.message);
    }

    // 2. Save to Postgres
    const insert = await pool.query(
      `INSERT INTO vapi_bookings
        (client_name, service, dob, birth_time, birth_city, whatsapp, email,
         preferred_date, preferred_time, source, payment_link, razorpay_link_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        booking.client_name,
        booking.service,
        booking.dob,
        booking.birth_time,
        booking.birth_city,
        booking.whatsapp,
        booking.email,
        booking.preferred_date,
        booking.preferred_time,
        booking.source,
        paymentLink?.short_url || null,
        paymentLink?.id || null,
      ]
    );

    // 3. WhatsApp + Sheets (fire-and-forget, don't block the voice agent)
    sendWhatsApp(booking, paymentLink?.short_url).catch(console.error);
    logToGoogleSheets({ booking_id: insert.rows[0].id, ...booking }, paymentLink?.short_url).catch(console.error);
    if (booking.email) {
      const svcLabel = SERVICE_PRICING[booking.service].label;
      sendEmail(
        booking.email,
        `🔮 Your ${svcLabel} is reserved — complete payment to confirm`,
        bookingEmailHtml(booking, svcLabel, paymentLink?.short_url)
      ).catch(console.error);
    }

    // 4. Respond to VAPI quickly
    const resultMsg = paymentLink?.short_url
      ? `Booking saved successfully. A Razorpay payment link has been sent to the caller's WhatsApp and email.`
      : `Booking saved successfully. The team will share a payment link shortly.`;
    // VAPI assistant tool-calls expect results[].result; include flat fields too for the workflow/curl path
    return res.json({
      results: toolCallId ? [{ toolCallId, result: resultMsg }] : undefined,
      success: true,
      booking_id: insert.rows[0].id,
      payment_link: paymentLink?.short_url || null,
      message: resultMsg,
    });
  } catch (err) {
    console.error("Booking error:", err);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
});

// Razorpay webhook → mark booking paid
app.post("/api/razorpay-webhook", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const crypto = require("crypto");
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (secret && signature) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");
      if (expected !== signature) return res.status(401).send("bad signature");
    }
    const event = JSON.parse(req.body.toString());
    if (event.event === "payment_link.paid") {
      const linkId = event.payload.payment_link.entity.id;
      const r = await pool.query(
        `UPDATE vapi_bookings SET payment_status='paid' WHERE razorpay_link_id=$1 RETURNING *`,
        [linkId]
      );
      console.log("💰 Payment received for link:", linkId);
      const b = r.rows[0];
      if (b && process.env.GSHEET_WEBHOOK_URL) {
        fetch(process.env.GSHEET_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "mark_paid", booking_id: b.id }),
        }).catch(console.error);
      }
      if (b && b.email) {
        const svcLabel = SERVICE_PRICING[b.service]?.label || b.service;
        sendEmail(b.email, `✅ Order Confirmed — ${svcLabel} | Veshannastro`, paidEmailHtml(b, svcLabel)).catch(console.error);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(500).send("error");
  }
});

// Admin: list bookings (protect with a simple key)
app.get("/api/bookings", async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: "unauthorized" });
  const r = await pool.query(
    "SELECT * FROM vapi_bookings ORDER BY created_at DESC LIMIT 100"
  );
  res.json(r.rows);
});

initDb().then(() =>
  app.listen(PORT, () => console.log(`🚀 Maaya booking API on :${PORT}`))
);
