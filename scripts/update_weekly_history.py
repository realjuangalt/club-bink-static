#!/usr/bin/env python3
"""
Update data/btcusd-weekly-price-historical.json with recent BTC/USD prices.

Usage (from repo root):

  python scripts/update_weekly_history.py

What it does:
- Reads the existing weekly history JSON file
- Fetches up to 365 days of recent daily BTC/USD prices from CoinGecko's
  public market_chart endpoint (no API key)
- Converts that daily series to an approximate weekly series
- Appends only dates that come after the last date already in the file
- Writes the merged result back to the same JSON file
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import urllib.request
import urllib.error


ROOT = Path(__file__).resolve().parents[1]
WEEKLY_FILE = ROOT / "data" / "btcusd-weekly-price-historical.json"


def iso_to_date(s: str) -> dt.date:
  return dt.date.fromisoformat(s)


def fetch_coingecko_daily(days: int = 365) -> list[dict]:
  """
  Fetch recent daily BTC/USD prices from CoinGecko's public API.

  Endpoint docs:
    https://www.coingecko.com/api/documentations/v3
  """
  safe_days = max(1, min(int(days), 365))
  url = (
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart"
    f"?vs_currency=usd&days={safe_days}&interval=daily"
  )
  print(f"[info] Fetching {safe_days} days of daily BTC/USD data from CoinGecko…")
  try:
    with urllib.request.urlopen(url) as resp:
      if resp.status != 200:
        raise RuntimeError(f"CoinGecko HTTP {resp.status}")
      data = json.loads(resp.read().decode("utf-8"))
  except urllib.error.HTTPError as e:
    raise RuntimeError(f"HTTP error from CoinGecko: {e}") from e
  except urllib.error.URLError as e:
    raise RuntimeError(f"Network error fetching from CoinGecko: {e}") from e

  prices = data.get("prices")
  if not isinstance(prices, list):
    raise RuntimeError("Unexpected CoinGecko response structure (no 'prices' list)")

  # prices: [[timestamp_ms, price], ...]
  out: list[dict] = []
  for ts_ms, price in prices:
    d = dt.datetime.utcfromtimestamp(ts_ms / 1000.0).date()
    out.append({"date": d.isoformat(), "price": float(price)})
  return out


def downsample_to_weekly(daily_series: list[dict]) -> list[dict]:
  """
  Turn a dense daily (or more frequent) series into an approximate weekly series
  by taking one point every 7 distinct dates, similar to the JS helper.
  """
  if not daily_series:
    return []

  # Ensure sorted by date
  sorted_daily = sorted(daily_series, key=lambda p: p["date"])

  deduped: list[dict] = []
  last_date: str | None = None
  for p in sorted_daily:
    date = p.get("date")
    price = p.get("price")
    if date and price is not None and date != last_date:
      deduped.append({"date": date, "price": float(price)})
      last_date = date

  weekly: list[dict] = []
  for i in range(0, len(deduped), 7):
    weekly.append(deduped[i])
  return weekly


def main() -> int:
  if not WEEKLY_FILE.exists():
    print(f"[error] Weekly history file not found: {WEEKLY_FILE}", file=sys.stderr)
    return 1

  print(f"[info] Loading existing weekly history from {WEEKLY_FILE}…")
  existing = json.loads(WEEKLY_FILE.read_text(encoding="utf-8"))
  if not isinstance(existing, list) or not existing:
    print("[error] Existing weekly history is empty or invalid.", file=sys.stderr)
    return 1

  # Find the last recorded date
  existing_sorted = sorted(existing, key=lambda p: p["date"])
  last_existing = existing_sorted[-1]
  last_date_str: str = last_existing["date"]
  last_date = iso_to_date(last_date_str)
  print(f"[info] Last existing weekly entry: {last_date_str} (price {last_existing['price']})")

  # Fetch daily data and keep only dates after last_date
  daily = fetch_coingecko_daily(365)
  new_daily = [p for p in daily if iso_to_date(p["date"]) > last_date]
  if not new_daily:
    print("[info] No new days found after last recorded date; nothing to update.")
    return 0

  print(f"[info] Fetched {len(daily)} daily points; {len(new_daily)} are newer than {last_date_str}.")

  weekly_updates = downsample_to_weekly(new_daily)
  if not weekly_updates:
    print("[info] After weekly downsampling, there are no new weekly points to add.")
    return 0

  print(f"[info] Adding {len(weekly_updates)} new weekly entries.")

  merged = existing_sorted + weekly_updates

  WEEKLY_FILE.write_text(json.dumps(merged, indent=2), encoding="utf-8")
  print(f"[info] Updated weekly history written back to {WEEKLY_FILE}.")
  print("[done] Review the file, then commit and push when ready.")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())

