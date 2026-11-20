#!/usr/bin/env python3
"""Real one-way flight search worker for CYRVIS.

Uses fast-flights (Google Flights scraping, no API key). Reads one JSON
request from stdin and writes one JSON response to stdout. The Electron main
process owns timeouts, fallbacks and user-facing wording.
"""

import json
import os
import sys
from urllib.parse import quote


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def parse_time(pair):
    if not isinstance(pair, list) or not pair:
        return None
    hour = pair[0] if pair[0] is not None else 0
    minute = pair[1] if len(pair) > 1 and pair[1] is not None else 0
    try:
        return f"{int(hour):02d}:{int(minute):02d}"
    except (TypeError, ValueError):
        return None


def first_string(value):
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        for item in value:
            found = first_string(item)
            if found:
                return found
    return None


def segment_number(segment):
    if isinstance(segment, list) and len(segment) > 22:
        meta = segment[22]
        if isinstance(meta, list):
            if len(meta) > 1 and isinstance(meta[1], str):
                return meta[1]
    return None


def parse_offers(html, origin, destination, date, currency, language, return_date=None):
    from selectolax.lexbor import LexborHTMLParser

    parser = LexborHTMLParser(html)
    script = parser.css_first(r"script.ds\:1")
    if script is None:
        raise RuntimeError("google_flights_payload_missing")
    payload = json.loads(script.text().split("data:", 1)[1].rsplit(",", 1)[0])
    groups = payload[3][0] if len(payload) > 3 and payload[3] else []
    if not isinstance(groups, list):
        raise RuntimeError("google_flights_payload_changed")

    offers = []
    seen = set()
    for group in groups:
        if not isinstance(group, list) or not group:
            continue
        flight = group[0]
        if not isinstance(flight, list) or len(flight) < 3:
            continue
        segments = flight[2]
        if not isinstance(segments, list) or not segments:
            continue

        price_info = None
        if len(group) > 1 and isinstance(group[1], list) and group[1]:
            price_info = group[1][0]
        price = None
        if isinstance(price_info, list) and len(price_info) > 1:
            price = price_info[1]
        if not isinstance(price, (int, float)) or price <= 0:
            # Google often returns sold-out/unpriced rows; skip them instead of
            # crashing the whole comparison.
            continue

        first = segments[0]
        last = segments[-1]
        departure = parse_time(first[8] if len(first) > 8 else None)
        arrival = parse_time(last[10] if len(last) > 10 else None)
        airline_name = first_string(flight[1] if len(flight) > 1 else None)
        if not airline_name and len(first) > 22:
            airline_name = first_string(first[22][3] if len(first[22]) > 3 else None)
        airline_code = first_string(flight[0] if flight else None)
        flight_number = segment_number(first)
        stops = max(0, len(segments) - 1)
        duration = flight[9] if len(flight) > 9 and isinstance(flight[9], int) else None

        key = (airline_code, flight_number, departure, int(price))
        if key in seen:
            continue
        seen.add(key)
        offers.append(
            {
                "id": f"{airline_code or 'flight'}-{flight_number or 'na'}-{departure or 'na'}-{int(price)}",
                "price": int(price),
                "currency": currency,
                "airlineCode": airline_code or "",
                "airlineName": airline_name or airline_code or "航班",
                "from": origin,
                "to": destination,
                "date": date,
                "returnDate": return_date,
                "departure": departure,
                "arrival": arrival,
                "durationMinutes": duration,
                "stops": stops,
            }
        )

    offers.sort(key=lambda item: (item["price"], item["stops"], item["departure"] or ""))
    query = f"Flights from {origin} to {destination} on {date}"
    if return_date:
        query += f" returning {return_date}"
    search_url = (
        "https://www.google.com/travel/flights?q="
        + quote(query)
        + f"&curr={currency}&hl={language}"
    )
    return offers[:30], search_url


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception as error:  # noqa: BLE001 - report to the Electron host
        emit({"ok": False, "error": f"bad_request:{error}"})
        return

    origin = str(request.get("origin") or "").upper().strip()
    destination = str(request.get("destination") or "").upper().strip()
    date = str(request.get("date") or "").strip()
    return_date = str(request.get("returnDate") or "").strip() or None
    currency = str(request.get("currency") or "CNY").upper().strip()
    language = str(request.get("language") or "zh-CN").strip()
    adults = int(request.get("adults") or 1)
    if not origin or not destination or not date:
        emit({"ok": False, "error": "origin_destination_date_required"})
        return
    if not (len(origin) == 3 and len(destination) == 3):
        emit({"ok": False, "error": "iata_code_required"})
        return

    try:
        from fast_flights import (
            FlightQuery,
            Passengers,
            create_query,
            fetch_flights_html,
        )
    except Exception as error:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": "fast_flights_not_installed",
                "detail": str(error),
            }
        )
        return

    try:
        flights = [
            FlightQuery(
                date=date,
                from_airport=origin,
                to_airport=destination,
            )
        ]
        if return_date:
            flights.append(
                FlightQuery(
                    date=return_date,
                    from_airport=destination,
                    to_airport=origin,
                )
            )
        query = create_query(
            flights=flights,
            trip="round-trip" if return_date else "one-way",
            passengers=Passengers(adults=max(1, adults)),
            currency=currency,
            language=language,
        )
        proxy = os.environ.get("CYRVIS_FLIGHT_PROXY") or None
        html = fetch_flights_html(query, proxy=proxy)
        offers, search_url = parse_offers(
            html, origin, destination, date, currency, language, return_date
        )
        if not offers:
            emit(
                {
                    "ok": False,
                    "error": "no_priced_flights",
                    "searchUrl": search_url,
                }
            )
            return
        emit(
            {
                "ok": True,
                "source": "google_flights",
                "currency": currency,
                "searchUrl": search_url,
                "offers": offers,
            }
        )
    except Exception as error:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": "search_failed",
                "detail": f"{type(error).__name__}: {error}",
            }
        )


if __name__ == "__main__":
    main()
