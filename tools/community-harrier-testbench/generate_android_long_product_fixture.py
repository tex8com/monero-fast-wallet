#!/usr/bin/env python3
"""Generate exact-boundary synthetic product/search inputs for Android."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path

from transformers import AutoTokenizer

MODEL_ID = "microsoft/harrier-oss-v1-270m"
MODEL_REVISION = "31de22b673913c7d658c0f03f792d77c2dcf8ebd"
MODEL_SHA256 = "90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a"
TOKENIZER_SHA256 = "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e"
QUERY_INSTRUCTION = (
    "Instruct: Given a community search query, retrieve relevant "
    "public profiles, posts, services, products, news, and clearly labeled "
    "advertisements\nQuery: "
)
MAX_INPUT_TOKENS = 256
FIELD_LIMIT = 255
DESCRIPTION_LENGTH = 1800
DESCRIPTION_CHUNK_CHARACTERS = 650
DESCRIPTION_CHUNK_OVERLAP = 75


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_text(seed: str, filler: str, length: int) -> str:
    value = seed.strip()
    while len(value) < length:
        value += " " + filler.strip()
    value = value[:length]
    if value[-1].isspace():
        value = value[:-1] + "."
    if len(value) != length or value != value.strip():
        raise RuntimeError("fixture field length construction failed")
    return value


def long_description(seed: str, filler: str, tail: str) -> str:
    suffix = " " + tail.strip()
    if len(suffix) >= DESCRIPTION_LENGTH:
        raise RuntimeError("description tail is too long")
    body = exact_text(seed, filler, DESCRIPTION_LENGTH - len(suffix))
    value = body + suffix
    if len(value) != DESCRIPTION_LENGTH:
        raise RuntimeError("description length construction failed")
    return value


def product(
    product_id: str,
    title_seed: str,
    title_filler: str,
    bullet_specs: list[tuple[str, str]],
    description_seed: str,
    description_filler: str,
    description_tail: str,
) -> dict[str, object]:
    title = exact_text(title_seed, title_filler, FIELD_LIMIT)
    bullets = [
        exact_text(seed, filler, FIELD_LIMIT)
        for seed, filler in bullet_specs
    ]
    description = long_description(
        description_seed,
        description_filler,
        description_tail,
    )
    document = "\n".join(
        [
            f"Titel: {title}",
            *[
                f"Bulletpoint {index + 1}: {bullet}"
                for index, bullet in enumerate(bullets)
            ],
            f"Beschreibung: {description}",
        ]
    )
    return {
        "id": product_id,
        "kind": "document",
        "language": "de",
        "title": title,
        "bullets": bullets,
        "description": description,
        "text": document,
    }


def normalize_query(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).lower()
    normalized = " ".join(normalized.split())
    if not 1 <= len(normalized) <= 160:
        raise RuntimeError("query is outside the production length contract")
    return normalized


def description_chunks(value: str) -> list[str]:
    chunks: list[str] = []
    start = 0
    step = DESCRIPTION_CHUNK_CHARACTERS - DESCRIPTION_CHUNK_OVERLAP
    while start < len(value):
        end = min(start + DESCRIPTION_CHUNK_CHARACTERS, len(value))
        chunks.append(value[start:end])
        if end == len(value):
            break
        start += step
    if not chunks or chunks[-1][-1] != value[-1]:
        raise RuntimeError("description chunks do not cover the complete text")
    return chunks


def product_embedding_inputs(item: dict[str, object]) -> list[dict[str, object]]:
    bullets = [str(value) for value in item["bullets"]]
    inputs: list[dict[str, object]] = [
        {
            "source": "title",
            "ordinal": 0,
            "primary": True,
            "text": f"Titel: {item['title']}",
        }
    ]
    for ordinal, start in enumerate(range(0, len(bullets), 2)):
        grouped = "\n".join(
            f"Bulletpoint {index + 1}: {bullets[index]}"
            for index in range(start, min(start + 2, len(bullets)))
        )
        inputs.append(
            {
                "source": "bullet",
                "ordinal": ordinal,
                "primary": False,
                "text": grouped,
            }
        )
    for ordinal, chunk in enumerate(
        description_chunks(str(item["description"]))
    ):
        inputs.append(
            {
                "source": "description",
                "ordinal": ordinal,
                "primary": False,
                "text": f"Beschreibung: {chunk}",
            }
        )
    return inputs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if sha256_file(args.model_dir / "model.safetensors") != MODEL_SHA256:
        raise RuntimeError("source model SHA-256 mismatch")
    if sha256_file(args.model_dir / "tokenizer.json") != TOKENIZER_SHA256:
        raise RuntimeError("tokenizer SHA-256 mismatch")
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        cache_dir=args.model_cache,
        local_files_only=True,
        trust_remote_code=False,
    )
    if (
        tokenizer.padding_side != "right"
        or tokenizer.truncation_side != "right"
        or tokenizer.pad_token_id != 0
        or tokenizer.bos_token_id != 2
        or tokenizer.eos_token_id != 1
    ):
        raise RuntimeError("tokenizer contract changed")

    products = [
        product(
            "privacy-wallet",
            "Open-Source Monero Wallet für sichere mobile Zahlungen mit biometrischem Schutz und lokaler Schlüsselverwaltung",
            "private Wallet ohne Cloud mit einfacher Wiederherstellung und geprüfter Sicherheit",
            [
                (
                    "Biometrische Entsperrung schützt den lokalen Wallet-Zugang und hält geheime Schlüssel im sicheren Betriebssystemspeicher",
                    "lokale Verschlüsselung sichere Schlüssel keine Cloud",
                ),
                (
                    "Eingehende Monero-Zahlungen erscheinen verständlich mit Betrag Status Absendernotiz und klarer Bestätigung",
                    "private Zahlung Benachrichtigung verständliche Anzeige",
                ),
                (
                    "Open-Source-Code reproduzierbare Builds und nachvollziehbare Sicherheitsprüfungen schaffen Vertrauen",
                    "prüfbarer Quellcode transparente Sicherheit reproduzierbarer Build",
                ),
                (
                    "Wiederherstellung über Seed und festen Wallet-Index macht Neuinstallation und Gerätewechsel beherrschbar",
                    "Seed Backup Wiederherstellung Gerätewechsel ohne Konto",
                ),
                (
                    "Ledger-Hardware-Wallets lassen sich über USB sicher verbinden und Transaktionen werden erst nach Prüfung signiert",
                    "Ledger USB Hardware Wallet Monero Signatur physische Bestätigung",
                ),
            ],
            "Die Anwendung richtet sich an Menschen die Monero privat und ohne komplizierte Fachbegriffe verwenden möchten",
            "lokale Verarbeitung verständliche Bedienung sichere Zahlungen quelloffene Technik ohne Tracking",
            "Polarstern-Wiederherstellung funktioniert vollständig offline ohne Cloud-Konto",
        ),
        product(
            "garden-robot",
            "Autonomer Gartenroboter mit leisem Elektroantrieb präziser Navigation und intelligenter Pflanzenpflege",
            "smarter Mähroboter für Rasen Beete Sensoren Bewässerung und automatische Gartenarbeit",
            [
                (
                    "Kamerafreie Navigation erkennt Wege Rasenkanten Beete und Hindernisse mit lokalen Abstandssensoren",
                    "Garten Navigation Sensor Hindernis lokale Verarbeitung",
                ),
                (
                    "Leiser Elektromotor pflegt große Rasenflächen und plant Fahrten passend zu Ruhezeiten und Wetter",
                    "Rasenmäher leise automatische Planung Wetter Garten",
                ),
                (
                    "Bodenfeuchte und Temperatur helfen bei sparsamer Bewässerung ohne unnötigen Wasserverbrauch",
                    "Pflanzen Bewässerung Bodenfeuchte Temperatur Wasser sparen",
                ),
                (
                    "Austauschbare Messer Räder und Akkus verlängern die Lebensdauer und vereinfachen Reparaturen",
                    "reparierbar Ersatzteile Akku Messer Räder langlebig",
                ),
                (
                    "Lokale Steuerung funktioniert ohne Cloud und behält Karten Zeitpläne und Sensordaten im eigenen Netzwerk",
                    "offline Gartenroboter lokale Daten privates Netzwerk",
                ),
            ],
            "Dieser robuste Gartenhelfer automatisiert wiederkehrende Pflegearbeiten und bleibt dennoch vollständig kontrollierbar",
            "Rasen Garten Pflanzen Sensoren leise Navigation Bewässerung reparierbar ohne Cloud",
            "Moosgarten-Spezialmodus schützt empfindliche Schattenflächen nach starkem Regen",
        ),
        product(
            "coffee-grinder",
            "Präzise elektrische Kaffeemühle für Espresso Filterkaffee und gleichmäßiges aromaschonendes Mahlen",
            "Kaffeemühle Edelstahl Mahlwerk feine Einstellung leiser Motor frische Bohnen",
            [
                (
                    "Stufenlose Mahlgradeinstellung deckt feinen Espresso mittleren Handfilter und grobe French Press zuverlässig ab",
                    "Mahlgrad Espresso Filterkaffee French Press präzise",
                ),
                (
                    "Langsam laufendes Edelstahlmahlwerk reduziert Wärme und bewahrt feine Aromen frisch gerösteter Kaffeebohnen",
                    "Edelstahl Mahlwerk Aroma wenig Wärme frische Bohnen",
                ),
                (
                    "Zeitgesteuerte Dosierung liefert wiederholbare Portionen für einzelne Tassen oder mehrere Getränke",
                    "Timer Dosierung Portion Kaffee wiederholbar",
                ),
                (
                    "Abnehmbare Bauteile ermöglichen schnelle Reinigung ohne Spezialwerkzeug und vermeiden alte Kaffeereste",
                    "Reinigung abnehmbar hygienisch ohne Werkzeug",
                ),
                (
                    "Kompaktes Gehäuse und gedämpfter Motor eignen sich für kleine Küchen Büros und frühe Morgenstunden",
                    "leise kompakt Küche Büro Kaffeemühle",
                ),
            ],
            "Die Mühle verbindet reproduzierbare Einstellungen mit einfacher Reinigung und einem robusten reparierbaren Aufbau",
            "Espresso Filterkaffee Bohnen Mahlwerk Aroma Dosierung Reinigung leiser Motor",
            "Bernstein-Röstprofil bewahrt florale Noten besonders heller äthiopischer Bohnen",
        ),
        product(
            "travel-backpack",
            "Wetterfester Reiserucksack mit ergonomischem Tragesystem modularen Fächern und sicherem Laptopfach",
            "Handgepäck Rucksack Reise leicht robust wasserdicht Laptop Organisation",
            [
                (
                    "Gepolstertes Laptopfach schützt mobile Computer und lässt sich bei Sicherheitskontrollen schnell öffnen",
                    "Laptopfach Reise Schutz schneller Zugriff Handgepäck",
                ),
                (
                    "Verstellbare Schultergurte Hüftgurt und belüfteter Rücken verteilen Gewicht auch auf langen Wegen",
                    "ergonomisch Tragekomfort Schultergurt Hüftgurt Belüftung",
                ),
                (
                    "Wetterfestes Recyclingmaterial widersteht Regen Abrieb und häufigem Einsatz in Bahn Flugzeug und Alltag",
                    "wasserdicht robust Recyclingmaterial Reise Alltag",
                ),
                (
                    "Modulare Innentaschen ordnen Kleidung Kabel Dokumente Kamera und kleine Reiseutensilien übersichtlich",
                    "Organisation Fächer Kleidung Kabel Kamera Dokumente",
                ),
                (
                    "Verdeckte Reißverschlüsse und ein körpernahes Wertsachenfach erschweren unbemerkten Zugriff unterwegs",
                    "Diebstahlschutz Wertsachen sicher verdeckter Reißverschluss",
                ),
            ],
            "Der Rucksack ist für mehrtägige Reisen Pendelwege und flexible Arbeit ausgelegt und bleibt handgepäcktauglich",
            "Reise Handgepäck Laptop ergonomisch wetterfest modular leicht sicher langlebig",
            "Nordlicht-Fach hält Reisepass und Notfallgeld getrennt von allen Elektronikfächern",
        ),
    ]
    queries = [
        # Twelve positive query/listing pairs: three natural phrasings per
        # product. The evaluated product is also the expected vector-DB top hit.
        {
            "id": "positive-wallet-1",
            "kind": "query",
            "language": "de",
            "text": "sichere Open-Source Monero Wallet mit biometrischem Schutz",
            "polarity": "positive",
            "evaluatedProductId": "privacy-wallet",
            "expectedTopProductId": "privacy-wallet",
        },
        {
            "id": "positive-wallet-bullet-tail",
            "kind": "query",
            "language": "de",
            "text": "Ledger Hardware Wallet über USB mit physischer Bestätigung",
            "polarity": "positive",
            "evaluatedProductId": "privacy-wallet",
            "expectedTopProductId": "privacy-wallet",
        },
        {
            "id": "positive-wallet-description-tail",
            "kind": "query",
            "language": "de",
            "text": "Polarstern Wiederherstellung vollständig offline ohne Cloud Konto",
            "polarity": "positive",
            "evaluatedProductId": "privacy-wallet",
            "expectedTopProductId": "privacy-wallet",
        },
        {
            "id": "positive-garden-1",
            "kind": "query",
            "language": "de",
            "text": "leiser autonomer Gartenroboter für den Rasen",
            "polarity": "positive",
            "evaluatedProductId": "garden-robot",
            "expectedTopProductId": "garden-robot",
        },
        {
            "id": "positive-garden-bullet-tail",
            "kind": "query",
            "language": "de",
            "text": "reparierbarer Gartenhelfer mit austauschbaren Messern Rädern und Akkus",
            "polarity": "positive",
            "evaluatedProductId": "garden-robot",
            "expectedTopProductId": "garden-robot",
        },
        {
            "id": "positive-garden-description-tail",
            "kind": "query",
            "language": "de",
            "text": "Moosgarten Spezialmodus für empfindliche Schattenflächen nach Regen",
            "polarity": "positive",
            "evaluatedProductId": "garden-robot",
            "expectedTopProductId": "garden-robot",
        },
        {
            "id": "positive-coffee-1",
            "kind": "query",
            "language": "de",
            "text": "präzise elektrische Kaffeemühle für Espresso",
            "polarity": "positive",
            "evaluatedProductId": "coffee-grinder",
            "expectedTopProductId": "coffee-grinder",
        },
        {
            "id": "positive-coffee-bullet-tail",
            "kind": "query",
            "language": "de",
            "text": "Kaffeemühle mit abnehmbaren Teilen zur Reinigung ohne Spezialwerkzeug",
            "polarity": "positive",
            "evaluatedProductId": "coffee-grinder",
            "expectedTopProductId": "coffee-grinder",
        },
        {
            "id": "positive-coffee-description-tail",
            "kind": "query",
            "language": "de",
            "text": "Bernstein Röstprofil für florale Noten heller äthiopischer Bohnen",
            "polarity": "positive",
            "evaluatedProductId": "coffee-grinder",
            "expectedTopProductId": "coffee-grinder",
        },
        {
            "id": "positive-backpack-1",
            "kind": "query",
            "language": "de",
            "text": "wetterfester Reiserucksack mit sicherem Laptopfach",
            "polarity": "positive",
            "evaluatedProductId": "travel-backpack",
            "expectedTopProductId": "travel-backpack",
        },
        {
            "id": "positive-backpack-bullet-tail",
            "kind": "query",
            "language": "de",
            "text": "Rucksack mit verdeckten Reißverschlüssen und sicherem Wertsachenfach",
            "polarity": "positive",
            "evaluatedProductId": "travel-backpack",
            "expectedTopProductId": "travel-backpack",
        },
        {
            "id": "positive-backpack-description-tail",
            "kind": "query",
            "language": "de",
            "text": "Nordlicht Fach trennt Reisepass und Notfallgeld von Elektronik",
            "polarity": "positive",
            "evaluatedProductId": "travel-backpack",
            "expectedTopProductId": "travel-backpack",
        },
        # Eight deliberately mismatched query/listing pairs. The query still
        # has one unambiguous correct product in the database, while
        # evaluatedProductId names the product that must *not* be preferred.
        {
            "id": "negative-wallet-vs-garden",
            "kind": "query",
            "language": "de",
            "text": "autonomer Rasenmäher mit Bodenfeuchtesensor",
            "polarity": "negative",
            "evaluatedProductId": "privacy-wallet",
            "expectedTopProductId": "garden-robot",
        },
        {
            "id": "negative-wallet-vs-coffee",
            "kind": "query",
            "language": "de",
            "text": "aromaschonende Espressomühle mit Edelstahlmahlwerk",
            "polarity": "negative",
            "evaluatedProductId": "privacy-wallet",
            "expectedTopProductId": "coffee-grinder",
        },
        {
            "id": "negative-garden-vs-wallet",
            "kind": "query",
            "language": "de",
            "text": "private Monero App mit sicherem Seed Backup",
            "polarity": "negative",
            "evaluatedProductId": "garden-robot",
            "expectedTopProductId": "privacy-wallet",
        },
        {
            "id": "negative-garden-vs-backpack",
            "kind": "query",
            "language": "de",
            "text": "wetterfestes Handgepäck mit gepolstertem Laptopfach",
            "polarity": "negative",
            "evaluatedProductId": "garden-robot",
            "expectedTopProductId": "travel-backpack",
        },
        {
            "id": "negative-coffee-vs-wallet",
            "kind": "query",
            "language": "de",
            "text": "biometrisch geschützte Open-Source Wallet für Monero",
            "polarity": "negative",
            "evaluatedProductId": "coffee-grinder",
            "expectedTopProductId": "privacy-wallet",
        },
        {
            "id": "negative-coffee-vs-garden",
            "kind": "query",
            "language": "de",
            "text": "leiser Roboter zur automatischen Rasenpflege",
            "polarity": "negative",
            "evaluatedProductId": "coffee-grinder",
            "expectedTopProductId": "garden-robot",
        },
        {
            "id": "negative-backpack-vs-coffee",
            "kind": "query",
            "language": "de",
            "text": "Kaffeemühle mit Timer für Espresso und Filterkaffee",
            "polarity": "negative",
            "evaluatedProductId": "travel-backpack",
            "expectedTopProductId": "coffee-grinder",
        },
        {
            "id": "negative-backpack-vs-wallet",
            "kind": "query",
            "language": "de",
            "text": "Monero Wallet ohne Cloud mit lokaler Schlüsselverwaltung",
            "polarity": "negative",
            "evaluatedProductId": "travel-backpack",
            "expectedTopProductId": "privacy-wallet",
        },
    ]

    cases = products + queries
    prepared_cases: list[dict[str, object]] = []
    for case in cases:
        raw_text = str(case["text"]).strip()
        if case["kind"] == "document":
            full_input_ids = tokenizer(
                raw_text,
                truncation=False,
                add_special_tokens=True,
            )["input_ids"]
            prepared = {
                key: value
                for key, value in case.items()
                if key != "text"
            }
            prepared_inputs = []
            for embedding_input in product_embedding_inputs(case):
                prepared_text = str(embedding_input["text"]).strip()
                chunk_input_ids = tokenizer(
                    prepared_text,
                    truncation=False,
                    add_special_tokens=True,
                )["input_ids"]
                input_ids = chunk_input_ids[:MAX_INPUT_TOKENS]
                if len(chunk_input_ids) > MAX_INPUT_TOKENS:
                    input_ids[-1] = tokenizer.eos_token_id
                prepared_inputs.append(
                    {
                        "source": embedding_input["source"],
                        "ordinal": embedding_input["ordinal"],
                        "primary": embedding_input["primary"],
                        "fullInputTokens": len(chunk_input_ids),
                        "retainedInputTokens": len(input_ids),
                        "wasTruncated": len(chunk_input_ids)
                        > MAX_INPUT_TOKENS,
                        "inputIds": input_ids,
                        "preparedTextSha256": hashlib.sha256(
                            prepared_text.encode("utf-8")
                        ).hexdigest(),
                    }
                )
            prepared.update(
                {
                    "fullInputTokens": len(full_input_ids),
                    "retainedInputTokens": min(
                        len(full_input_ids),
                        MAX_INPUT_TOKENS,
                    ),
                    "wasTruncated": len(full_input_ids)
                    > MAX_INPUT_TOKENS,
                    "embeddingInputs": prepared_inputs,
                }
            )
            prepared_cases.append(prepared)
            continue

        prepared_text = raw_text
        if case["kind"] == "query":
            prepared_text = QUERY_INSTRUCTION + normalize_query(raw_text)
        full_input_ids = tokenizer(
            prepared_text,
            truncation=False,
            add_special_tokens=True,
        )["input_ids"]
        input_ids = full_input_ids[:MAX_INPUT_TOKENS]
        if len(full_input_ids) > MAX_INPUT_TOKENS:
            input_ids[-1] = tokenizer.eos_token_id
        prepared = {
            key: value
            for key, value in case.items()
            if key != "text"
        }
        prepared.update(
            {
                "fullInputTokens": len(full_input_ids),
                "inputIds": input_ids,
                "preparedTextSha256": hashlib.sha256(
                    prepared_text.encode("utf-8")
                ).hexdigest(),
                "retainedInputTokens": len(input_ids),
                "wasTruncated": len(full_input_ids) > MAX_INPUT_TOKENS,
            }
        )
        prepared_cases.append(prepared)

    for item in prepared_cases:
        if item["kind"] == "document":
            if len(str(item["title"])) != FIELD_LIMIT:
                raise RuntimeError("product title is not exactly 255 characters")
            if any(
                len(str(value)) != FIELD_LIMIT
                for value in item["bullets"]
            ):
                raise RuntimeError("product bullet is not exactly 255 characters")
            if len(str(item["description"])) <= FIELD_LIMIT:
                raise RuntimeError("product description is not longer than 255")
            embedding_inputs = item["embeddingInputs"]
            if (
                len(embedding_inputs) != 7
                or sum(
                    1 for value in embedding_inputs if value["primary"]
                )
                != 1
                or any(value["wasTruncated"] for value in embedding_inputs)
            ):
                raise RuntimeError(
                    "product chunk plan must contain seven complete embeddings"
                )

    payload = {
        "schemaVersion": 1,
        "artifactTarget": "xnnpack_a8w8",
        "modelId": MODEL_ID,
        "sourceRevision": MODEL_REVISION,
        "sourceWeightsSha256": MODEL_SHA256,
        "tokenizerSha256": TOKENIZER_SHA256,
        "queryInstruction": QUERY_INSTRUCTION,
        "maxInputTokens": MAX_INPUT_TOKENS,
        "fieldContract": {
            "titleCharacters": FIELD_LIMIT,
            "bulletCharacters": FIELD_LIMIT,
            "bulletsPerProduct": 5,
            "descriptionCharacters": DESCRIPTION_LENGTH,
            "descriptionChunkCharacters": DESCRIPTION_CHUNK_CHARACTERS,
            "descriptionChunkOverlap": DESCRIPTION_CHUNK_OVERLAP,
        },
        "cases": prepared_cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        "generated "
        f"{len(products)} products and {len(queries)} queries at {args.output}"
    )


if __name__ == "__main__":
    main()
