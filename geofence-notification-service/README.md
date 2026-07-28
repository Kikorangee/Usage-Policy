# Geofence Policy Notification Service

This Node service is the server-side component of the MyGeotab Geofence Policy Monitor. It validates add-in registrations, polls real Geotab `ExceptionEvent` records, applies per-policy/per-vehicle cooldowns, and sends SMTP email. It does not use mock fleet data.

## Configure

1. Install Node.js 20 or later.
2. Run `npm install`.
3. Enter the SMTP and Geotab service-account values in `service-config.json`, or set the environment variables listed below.
4. Run `npm run check-config`. It must report `Configuration is valid`.
5. Run `npm start`.
6. Publish the service through HTTPS and paste `https://your-host/api/policies/register` into the add-in.

Environment variables override the JSON file:

- `PORT`
- `PUBLIC_BASE_URL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`
- `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_ADDRESS`, `SMTP_FROM_NAME`, `SMTP_REPLY_TO`
- `GEOTAB_SERVER`, `GEOTAB_DATABASE`, `GEOTAB_USERNAME`, `GEOTAB_PASSWORD`
- `MAPTILER_API_KEY`, `MAPTILER_MAP_ID`

The Geotab account must be a dedicated service account that can read ExceptionEvent, Device, User, LogRecord, Zone, and reverse-geocode addresses. Do not put its password or SMTP password in the add-in.

`GET /health` reports service state without exposing secrets. Registrations are stored in `data/policies.json`; delivery/cooldown state is stored in `data/deliveries.json`.

Map images use MapTiler Static Maps. The supplied MapTiler account must have Static Maps access and its allowed origins/IP restrictions must permit this server. If the image request fails, the alert is still sent with its location link.
