"""Build public/data/airports.json from OurAirports (public domain).

Usage:
  curl -O https://davidmegginson.github.io/ourairports-data/airports.csv
  curl -O https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv
  python3 scripts/build-airports.py airports.csv airport-frequencies.csv public/data/airports.json

Keeps large and medium airports that have scheduled flights or an IATA code,
with their tower/approach/ATIS frequencies.
Each airport: [icao, iata, name, city, country, lat, lon, [[type, MHz], ...]]
"""
import csv
import json
import sys

airports_csv, freqs_csv, out_path = sys.argv[1:4]

FREQ_TYPES = {"TWR", "APP", "ATIS", "GND", "DEP", "CTAF", "AFIS", "D-ATIS", "CLD", "DEL"}

airports = {}
with open(airports_csv, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        if row["type"] not in ("large_airport", "medium_airport"):
            continue
        if row["scheduled_service"] != "yes" and not row["iata_code"]:
            continue
        ident = row["ident"]
        airports[ident] = [
            row["icao_code"] or ident,
            row["iata_code"],
            row["name"],
            row["municipality"],
            row["iso_country"],
            round(float(row["latitude_deg"]), 4),
            round(float(row["longitude_deg"]), 4),
            [],
        ]

with open(freqs_csv, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        ap = airports.get(row["airport_ident"])
        kind = row["type"].upper()
        if not ap or kind not in FREQ_TYPES or not row["frequency_mhz"]:
            continue
        mhz = float(row["frequency_mhz"])
        if [kind, mhz] not in ap[7]:
            ap[7].append([kind, mhz])

# Most useful first, at most 2 of each kind and 8 in total.
PRIORITY = ["TWR", "APP", "DEP", "GND", "ATIS", "D-ATIS", "CTAF", "AFIS", "DEL", "CLD"]
for ap in airports.values():
    ap[7].sort(key=lambda fr: PRIORITY.index(fr[0]))
    kept, counts = [], {}
    for kind, mhz in ap[7]:
        if counts.get(kind, 0) < 2 and len(kept) < 8:
            kept.append([kind, mhz])
            counts[kind] = counts.get(kind, 0) + 1
    ap[7] = kept

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(list(airports.values()), f, ensure_ascii=False, separators=(",", ":"))

print(f"{len(airports)} airports written to {out_path}")
