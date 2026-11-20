# Real flight data

The travel demo uses real Google Flights results by default. It does **not**
invent prices.

## Source and limits

- Source: Google Flights via the open-source `fast-flights` Python package.
  No API key is required.
- Coverage: Google Flights itinerary prices. These are **not** Qunar/Ctrip/
  Fliggy/Tongcheng brand quotes, and they can differ from the OTA checkout page.
- The worker only supports one-way searches today. Round-trip duration is not
  sent to the provider.
- Requests come from the local IP. Google may rate-limit sustained use; keep
  one search per user turn.

## Runtime setup

The worker is `apps/ui-tars/resources/cyrvis/flight-worker.py`.

```powershell
python -m pip install --user fast-flights typing_extensions
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CYRVIS_FLIGHT_PROVIDER` | `live` | Set `demo` to use the deterministic mock (tests/offline only). |
| `CYRVIS_FLIGHT_PYTHON` | `python` | Python executable that has `fast-flights` installed. |
| `CYRVIS_FLIGHT_WORKER` | bundled path | Override the worker script path. |
| `CYRVIS_FLIGHT_PROXY` | - | Optional HTTP proxy for Google Flights requests. |

The app never silently falls back to mock prices. If the live search fails, it
says so and opens the Google Flights search page so the user can inspect live
prices.

## Paid / official upgrades

- **SerpApi Google Flights**: stable JSON, paid plan with a free quota.
- **GeckoAPI Trip.com PLP**: real Trip.com prices, paid scraping API.
- **Amadeus Self-Service**: official GDS fares, free test environment.
- **Duffel**: official booking API; Air China is available via Travelport,
  broader mainland coverage needs verification.
- **Ctrip/Trip.com agent APIs, Qunar/Fliggy/Tongcheng open platforms**: require
  an enterprise/agency contract; there is no public self-serve flight API.

Do not scrape five OTA sites for production: anti-bot controls, login
requirements and terms-of-service risk make that path fragile.

## Tests

`travel-flight.test.ts`, `flight-provider.test.ts` and `voice-brain.test.ts`
cover the mock path, live mapping/formatting, and the brain flow with an
injected live result. They do not call Google during CI.
