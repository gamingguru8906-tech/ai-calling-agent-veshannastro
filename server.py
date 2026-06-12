"""
server.py — Veshannastro on-site astrology chat backend.

Endpoints (all called by the embedded widget):
  POST /api/start          -> opens a session, returns greeting
  POST /api/message        -> handles the birth-detail wizard + Q&A + paywall
  POST /api/create-order   -> creates a Razorpay order to unlock one question
  POST /api/verify-payment -> verifies payment, credits one question
  GET  /api/leads          -> (admin) list captured leads
  GET  /widget.js          -> serves the embeddable widget script
  GET  /                   -> a demo page so you can preview the widget

The visitor's browser stores only a random session_id. Everything else
(name, birth details, chat, free/paid counts) lives in the database on
this server. Card/UPI details never touch this server — Razorpay handles them.
"""

import os
import hmac
import hashlib

from fastapi import FastAPI, Request, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

import astrology
import ai
import database as db

load_dotenv()

FREE_LIMIT      = int(os.getenv("FREE_QUESTIONS", "3"))
PRICE_PER_Q     = int(os.getenv("PRICE_PER_QUESTION_INR", "19"))   # rupees
ADMIN_KEY       = os.getenv("ADMIN_KEY", "change-me")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS",
                            "https://veshannastro.co.in").split(",")

RAZORPAY_KEY_ID     = os.getenv("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET", "")

# Where the two call-to-action buttons send people.
FULL_CONSULTATION_URL = os.getenv("FULL_CONSULTATION_URL",
                                  os.getenv("BOOKING_URL", "https://veshannastro.co.in"))
# One-question call link — set this in Render when you have it.
ONE_QUESTION_URL = os.getenv("ONE_QUESTION_URL",
                             os.getenv("BOOKING_URL", "https://veshannastro.co.in"))

def _cta_buttons():
    return [
        {"label": "🔮 Book a Full Consultation", "url": FULL_CONSULTATION_URL},
        {"label": "💬 Ask One Question (Call)", "url": ONE_QUESTION_URL},
    ]

app = FastAPI(title="Veshannastro Chat")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)
db.init_db()

HERE = os.path.dirname(os.path.abspath(__file__))


# --- request models --------------------------------------------------------

class StartReq(BaseModel):
    session_id: str

class MessageReq(BaseModel):
    session_id: str
    message: str

class OrderReq(BaseModel):
    session_id: str

class VerifyReq(BaseModel):
    session_id: str
    razorpay_payment_id: str
    razorpay_order_id: str
    razorpay_signature: str

class SetupReq(BaseModel):
    session_id: str
    name: str
    dob: str            # "YYYY-MM-DD" from the date picker
    tob: str            # "HH:MM" (24h) or "h:MM AM/PM"
    latitude: float
    longitude: float
    timezone: str
    place: str          # human-readable label, e.g. "Raipur, Chhattisgarh, India"


# --- wizard + chat ---------------------------------------------------------

def _reply(text, **extra):
    return {"reply": text, **extra}


@app.post("/api/start")
def start(req: StartReq):
    """Tells the widget whether to show the setup FORM or go straight to chat."""
    row = db.get_or_create(req.session_id)
    if row["stage"] == "ready":
        free_left = max(0, FREE_LIMIT - row["free_used"])
        return _reply(
            f"🙏 Welcome back, {row['name']}! Ask me anything about your day, "
            "love, career, or money.",
            stage="ready", show_form=False, free_remaining=free_left,
            paid_credits=row["paid_credits"],
        )
    return _reply(
        "🙏 Namaste, I'm Vesha from Veshannastro. Fill in your birth details "
        f"below and I'll read your Vedic chart — your first {FREE_LIMIT} "
        "questions are free.",
        stage="setup", show_form=True,
    )


@app.post("/api/setup")
def setup(req: SetupReq):
    """Receives the form (with coordinates from the browser) and builds the chart."""
    try:
        chart = astrology.calculate_chart_from_coords(
            req.dob, req.tob, req.latitude, req.longitude, req.timezone, req.place)
    except Exception as e:
        return _reply(f"I couldn't compute the chart ({e}). Please check the "
                      "date and time and try again.", ok=False)

    db.update(req.session_id, name=req.name, dob=req.dob, tob=req.tob,
              place=req.place, stage="ready", chart_summary=chart.full_summary())

    # Overview block shown right after the chart image (like Astro Lok style)
    overview = chart.overview_block()

    return _reply(
        f"Here is your birth chart.",
        ok=True, stage="ready", free_remaining=FREE_LIMIT,
        chart_data=chart.chart_data(),
        overview=overview,
        ask_prompt=f"Ask me anything about your chart — career, relationships, "
                   f"the year ahead, your dasha, and more."
    )


@app.post("/api/message")
def message(req: MessageReq):
    row = db.get_or_create(req.session_id)
    text = req.message.strip()

    if row["stage"] != "ready" or not row["chart_summary"]:
        return _reply("Let's set up your birth details first 🌟",
                      stage="setup", show_form=True)

    # Enforce the paywall (free quota renews every 48h, handled in the DB).
    allowed, free_remaining, used_paid = db.consume_question(
        req.session_id, FREE_LIMIT)

    if not allowed:
        eta = db.renewal_eta_hours(req.session_id)
        return _reply(
            f"🙏 You've used all {FREE_LIMIT} of your free questions. They'll "
            f"renew automatically in about {eta} hours. For guidance right now, "
            "you can book a full consultation or a one-question call with me:",
            stage="ready", locked=True, free_remaining=0,
            buttons=_cta_buttons(),
        )

    reading = ai.generate_reading(row["chart_summary"], text,
                                  db.get_history(req.session_id))
    db.append_history(req.session_id, "user", text)
    db.append_history(req.session_id, "assistant", reading)

    # On the LAST free question only, add the upsell + the two buttons.
    if free_remaining == 0 and not used_paid:
        reading += ("\n\n✨ That was your last free question for now. For deeper "
                    "guidance — your Dashas, exact timings, and remedies — "
                    "choose an option below.")
        return _reply(reading, stage="ready", locked=False, free_remaining=0,
                      buttons=_cta_buttons())

    return _reply(reading, stage="ready", locked=False,
                  free_remaining=free_remaining)


# --- payments (Razorpay) ---------------------------------------------------

@app.post("/api/create-order")
def create_order(req: OrderReq):
    if not (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET):
        raise HTTPException(500, "Razorpay keys not configured on server.")
    import razorpay
    client = razorpay.Client(auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET))
    order = client.order.create({
        "amount": PRICE_PER_Q * 100,          # Razorpay works in paise
        "currency": "INR",
        "notes": {"session_id": req.session_id, "product": "astro_question"},
    })
    return {"order_id": order["id"], "amount": order["amount"],
            "currency": "INR", "key_id": RAZORPAY_KEY_ID,
            "price_inr": PRICE_PER_Q}


@app.post("/api/verify-payment")
def verify_payment(req: VerifyReq):
    """Verify Razorpay's signature server-side before crediting anything."""
    body = f"{req.razorpay_order_id}|{req.razorpay_payment_id}"
    expected = hmac.new(
        RAZORPAY_KEY_SECRET.encode(), body.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, req.razorpay_signature):
        raise HTTPException(400, "Payment verification failed.")
    db.credit_question(req.session_id, PRICE_PER_Q)
    return {"ok": True, "message": "Payment verified. You can ask now 🌟"}


# --- admin -----------------------------------------------------------------

@app.get("/api/leads")
def leads(x_admin_key: str = Header(default="")):
    if not hmac.compare_digest(x_admin_key, ADMIN_KEY):
        raise HTTPException(403, "Forbidden")
    return {"leads": db.list_leads()}


# --- static: widget + demo -------------------------------------------------

@app.get("/widget.js")
def widget_js():
    return FileResponse(os.path.join(HERE, "widget.js"),
                        media_type="application/javascript")

@app.get("/vapi-bundle.js")
def vapi_bundle():
    """Self-hosted VAPI Web SDK bundle for the Talk-to-Maaya button."""
    return FileResponse(os.path.join(HERE, "vapi-bundle.js"),
                        media_type="application/javascript",
                        headers={"Cache-Control": "public, max-age=86400"})

@app.get("/")
def demo():
    return FileResponse(os.path.join(HERE, "demo.html"))

@app.get("/healthz")
def healthz():
    """Hit this every few minutes (UptimeRobot) to keep the free host awake.
    It also touches the database so a free auto-suspending Postgres stays warm."""
    try:
        db.ping()
        return {"ok": True}
    except Exception:
        return {"ok": False}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))   # hosts like Render set $PORT
    uvicorn.run(app, host="0.0.0.0", port=port)
