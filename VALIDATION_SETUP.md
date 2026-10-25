# Customer service validation API

This Vercel project hosts the server-side GoHighLevel email check and Twilio Verify calls used by the DREAMSILK customer service form.

## Route

POST /api/validation with one of these JSON bodies:

- { "action": "email", "email": "name@example.com" }
- { "action": "phone-send", "phone": "+447700900123" }
- { "action": "phone-check", "phone": "+447700900123", "code": "123456" }

Only https://dreamsilk.io and https://www.dreamsilk.io origins are accepted. Provider credentials stay in server environment variables and are never returned from the route.

## Environment variables

Set these in Vercel for Preview and Production. Credential values should use Secret visibility. GHL_LOCATION_ID is an identifier and may remain Config.

- GHL_PIT_TOKEN
- GHL_LOCATION_ID
- TWILIO_ACCOUNT_SID
- TWILIO_API_KEY
- TWILIO_API_SECRET
- TWILIO_VERIFY_SERVICE_SID

TWILIO_AUTH_TOKEN is not used; Twilio API key and secret are used for Basic authentication. ROYAL_MAIL_ADDRESS_VALIDATION_API is not part of this email and phone flow.

## Required Twilio protection

The SMS route sends hashed IP and phone keys as Twilio Verify Service Rate Limits named ip and phone. Create both Rate Limits on the Verify Service and configure buckets before enabling the route. Suggested limits:

- ip: 5 requests per hour
- phone: 5 requests per hour and 1 request per 30 seconds

Restrict the Verify Service to the destination countries DREAMSILK serves. The route fails closed if Twilio rejects the rate-limit keys or the SMS request.

## Shopify form behavior

The storefront checks email deliverability once at submit. It follows fail-open behavior when email verification is unavailable or unprocessed. If a customer provides a phone number, the normal browser flow sends an SMS code and waits for approval before submitting the Shopify contact form.

A native Shopify contact form can still be posted directly outside the browser flow, so this provides phone verification in the normal storefront experience rather than server-enforced access control.
