# Veshannastro VAPI Booking API

Backend for the Vesha voice agent. Receives bookings from the VAPI workflow's
`api-request` node, saves to Neon Postgres, creates a Razorpay payment link,
sends WhatsApp confirmation, and logs to Google Sheets.

## Deploy on Render (5 min)

1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect repo
3. Build command: `npm install` | Start command: `npm start`
4. Add env vars from `.env.example` (DATABASE_URL is required; use your existing Neon DB)
5. Done — your endpoint is `https://<your-service>.onrender.com/api/vapi-booking`

## Wire to VAPI

In the workflow JSON, set:
```
"url": "https://<your-service>.onrender.com/api/vapi-booking"
```

## Razorpay webhook (mark payments as paid)

Razorpay dashboard → Webhooks → add:
`https://<your-service>.onrender.com/api/razorpay-webhook`
Event: `payment_link.paid` — paste the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.

## Test locally
```bash
curl -X POST http://localhost:3000/api/vapi-booking \
  -H "Content-Type: application/json" \
  -d '{"client_name":"Test User","service":"kundli","whatsapp":"9876543210","preferred_date":"20 June","preferred_time":"3 PM"}'
```

## View bookings
`GET /api/bookings?key=YOUR_ADMIN_KEY`
