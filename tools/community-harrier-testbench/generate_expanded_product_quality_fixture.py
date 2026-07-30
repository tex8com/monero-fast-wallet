#!/usr/bin/env python3
"""Generate an expanded, reproducible long-listing search-quality fixture."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from transformers import AutoTokenizer

from generate_android_long_product_fixture import (
    MAX_INPUT_TOKENS,
    MODEL_ID,
    MODEL_REVISION,
    MODEL_SHA256,
    QUERY_INSTRUCTION,
    TOKENIZER_SHA256,
    normalize_query,
    product,
    product_embedding_inputs,
    sha256_file,
)

QUERY_PROFILES = {
    "production-v2": (
        "community-query-v2",
        QUERY_INSTRUCTION,
    ),
    "legacy-monero-ablation-v1": (
        "community-query-v1",
        "Instruct: Given a Monero community search query, retrieve relevant "
        "public profiles, posts, services, products, news, and clearly labeled "
        "advertisements\nQuery: ",
    ),
    "neutral-community-ablation-v1": (
        "community-query-neutral-ablation-v1",
        "Instruct: Given a community search query, retrieve relevant public "
        "profiles, posts, services, products, news, and clearly labeled "
        "advertisements\nQuery: ",
    ),
    "product-specific-ablation-v1": (
        "product-query-ablation-v1",
        "Instruct: Given a product search query, retrieve the most relevant "
        "product listings\nQuery: ",
    ),
}


def listing(
    product_id: str,
    title: str,
    filler: str,
    bullets: list[str],
    description: str,
    tail: str,
) -> dict[str, object]:
    if len(bullets) != 5:
        raise RuntimeError(f"{product_id} must have five bullets")
    return product(
        product_id,
        title,
        filler,
        [(value, filler) for value in bullets],
        description,
        filler,
        tail,
    )


PRODUCTS = [
    listing(
        "privacy-wallet",
        "Open-Source Monero Wallet mit biometrischem Schutz lokaler Schlüsselverwaltung und einfacher Wiederherstellung",
        "Monero Wallet Privatsphäre lokale Schlüssel sichere Zahlung Wiederherstellung ohne Cloud",
        [
            "Biometrische Entsperrung und Gerätesperre schützen den Zugriff ohne den Wallet-Schlüssel an einen Server zu übertragen",
            "Eingehende Zahlungen erscheinen mit verständlichem Status und lokal geprüften Bestätigungen",
            "Open-Source-Code und reproduzierbare Builds ermöglichen unabhängige Sicherheitsprüfungen",
            "Seed-Backup und fester Wallet-Index vereinfachen Neuinstallation und Gerätewechsel",
            "Ledger-Unterstützung bestätigt ausgehende Transaktionen physisch auf dem Hardwaregerät",
        ],
        "Die mobile Wallet verarbeitet Suche Kontostand und Transaktionen lokal und erklärt Monero ohne unnötige Fachbegriffe",
        "Polarstern-Wiederherstellung öffnet das identische Unterkonto nach einer vollständigen Neuinstallation",
    ),
    listing(
        "password-manager",
        "Lokaler Passwortmanager mit Ende-zu-Ende verschlüsseltem Tresor Passkeys und sicherer Gerätefreigabe",
        "Passwort Tresor Passkey Zugangsdaten Verschlüsselung Autofill Gerätefreigabe Sicherheit",
        [
            "Der verschlüsselte Tresor speichert Logins Notizen und Wiederherstellungscodes geschützt auf dem Gerät",
            "Passkeys und starke zufällige Passwörter lassen sich ohne wiederverwendete Geheimnisse erstellen",
            "Autofill füllt Anmeldedaten nur für die exakt geprüfte App oder Webdomain aus",
            "Ein Notfallzugang kann zeitverzögert und jederzeit widerrufbar für eine Vertrauensperson vorbereitet werden",
            "Der Export erzeugt ein verschlüsseltes Backup statt einer ungeschützten Klartextdatei",
        ],
        "Der Passwortmanager richtet sich an Familien und kleine Teams die Zugangsdaten einfach aber ohne Werbetracking verwalten möchten",
        "Bernstein-Tresor warnt wenn eine ähnlich geschriebene Phishing-Domain das automatische Ausfüllen anfordert",
    ),
    listing(
        "secure-messenger",
        "Privater Messenger mit Ende-zu-Ende verschlüsselten Nachrichten Gruppenanrufen und anonymen Benutzernamen",
        "Messenger Chat Nachricht Ende zu Ende Verschlüsselung Gruppe Anruf Privatsphäre",
        [
            "Nachrichten Bilder und Dateien werden ausschließlich für die Geräte der Gesprächsteilnehmer verschlüsselt",
            "Anonyme Benutzernamen ermöglichen Kontakt ohne öffentliche Telefonnummer oder E-Mail-Adresse",
            "Sicherheitsnummern und QR-Abgleich helfen beim Erkennen eines ausgetauschten Geräteschlüssels",
            "Verschwindende Nachrichten löschen lokale Kopien nach einer gemeinsam gewählten Zeitspanne",
            "Verschlüsselte Gruppenanrufe unterstützen Bildschirmfreigabe ohne serverseitige Gesprächsaufzeichnung",
        ],
        "Der Messenger verbindet einfache Alltagskommunikation mit nachvollziehbarer Kryptografie und speichert keine lesbaren Chatverläufe beim Betreiber",
        "Nebelbrücken-Modus stellt nach einem Gerätewechsel nur bestätigte Kontakte ohne alte Nachrichteninhalte wieder her",
    ),
    listing(
        "hardware-security-key",
        "USB NFC Sicherheitsschlüssel für Passkeys Zwei-Faktor-Anmeldung und phishingresistenten Kontozugang",
        "Sicherheitsschlüssel USB NFC Passkey FIDO Zwei Faktor Hardware Anmeldung Konto",
        [
            "FIDO2 und WebAuthn bestätigen Anmeldungen für die echte Domain und blockieren nachgebaute Login-Seiten",
            "USB-C NFC und ein beiliegender Adapter unterstützen Smartphone Tablet und Desktop",
            "Die Berührungstaste verlangt eine bewusste physische Bestätigung für jeden sensiblen Vorgang",
            "Zwei getrennte Schlüssel lassen sich als tägliches Gerät und versiegelte Ersatzkopie registrieren",
            "Das robuste wasserfeste Gehäuse besitzt keine Batterie und funktioniert vollständig offline",
        ],
        "Der Hardware-Schlüssel schützt E-Mail Cloud Administrationskonten und Passwortmanager vor gestohlenen Kennwörtern und Fernangriffen",
        "Kobalt-Berührungscode signalisiert durch ein kurzes weißes Licht die erfolgreiche lokale Benutzerbestätigung",
    ),
    listing(
        "garden-robot",
        "Autonomer Gartenroboter mit leisem Elektroantrieb lokaler Navigation und intelligenter Rasenpflege",
        "Gartenroboter Rasenmäher Garten Pflanzen Sensor Navigation Bewässerung leise",
        [
            "Kamerafreie Sensoren erkennen Wege Beete Rasenkanten Tiere und niedrige Hindernisse",
            "Der leise Elektromotor plant Mähzeiten passend zu Wetter Ruhezeiten und Rasenwachstum",
            "Bodenfeuchte und Temperatur steuern eine sparsame Bewässerung empfindlicher Pflanzen",
            "Austauschbare Messer Räder und Akkus vereinfachen Wartung und verlängern die Lebensdauer",
            "Karten Zeitpläne und Sensordaten bleiben ohne Cloud im eigenen lokalen Netzwerk",
        ],
        "Der Gartenhelfer automatisiert wiederkehrende Pflegearbeiten für Rasen und Beete und bleibt über eine lokale App kontrollierbar",
        "Moosgarten-Spezialmodus schont empfindliche Schattenflächen in den ersten Stunden nach starkem Regen",
    ),
    listing(
        "robot-vacuum",
        "Flacher Saugroboter mit Wischfunktion Lasernavigation automatischer Absaugstation und lokaler Raumkarte",
        "Saugroboter Staubsauger Wischen Boden Reinigung Raumkarte Laser Absaugstation",
        [
            "Lasernavigation erstellt präzise Raumkarten auch bei Dunkelheit und umfährt Möbel Treppen und Kabel",
            "Teppicherkennung erhöht automatisch die Saugleistung und hebt das feuchte Wischpad an",
            "Die Absaugstation leert den Staubbehälter und erinnert an Filter Bürsten und Frischwasser",
            "Sperrzonen und Reinigungsreihenfolge lassen sich für einzelne Zimmer lokal festlegen",
            "Alle Karten bleiben auf dem Gerät und funktionieren ohne Herstellerkonto oder Internetzugang",
        ],
        "Der kompakte Haushaltsroboter reinigt Hartboden Teppich und Tierhaare nach einem leisen Zeitplan und erreicht niedrige Möbel",
        "Korallenrand-Erkennung reduziert die Bürstendrehzahl neben zerbrechlichen Bodenvasen und Futternäpfen",
    ),
    listing(
        "coffee-grinder",
        "Präzise elektrische Kaffeemühle mit Edelstahlmahlwerk für Espresso Filterkaffee und French Press",
        "Kaffeemühle Mahlwerk Kaffee Bohnen Espresso Filter Mahlgrad Aroma Dosierung",
        [
            "Die stufenlose Mahlgradeinstellung reicht von feinem Espresso bis zu grober French Press",
            "Das langsam laufende Edelstahlmahlwerk reduziert Wärme und bewahrt florale Kaffeearomen",
            "Zeitgesteuerte Dosierung liefert wiederholbare Portionen für eine oder mehrere Tassen",
            "Abnehmbare Bauteile ermöglichen Reinigung ohne Spezialwerkzeug und alte Kaffeereste",
            "Das kompakte gedämpfte Gehäuse eignet sich für kleine Küchen und frühe Morgenstunden",
        ],
        "Die Mühle kombiniert gleichmäßige Partikel reproduzierbare Einstellungen und einen reparierbaren Aufbau für frisch geröstete Bohnen",
        "Bernstein-Röstprofil bewahrt florale Noten besonders heller äthiopischer Bohnen beim langsamen Mahlen",
    ),
    listing(
        "espresso-machine",
        "Kompakte Espressomaschine mit PID Temperatursteuerung Dampflanze und programmierbarer Preinfusion",
        "Espressomaschine Siebträger Kaffee PID Temperatur Dampf Milch Preinfusion",
        [
            "Die PID-Regelung hält die Brühtemperatur für helle und dunkle Röstungen präzise konstant",
            "Programmierbare Preinfusion befeuchtet das Kaffeemehl sanft und reduziert ungleichmäßige Extraktion",
            "Eine kräftige Dampflanze erzeugt feinporigen Milchschaum für Cappuccino und Flat White",
            "Manometer Timer und gut sichtbarer Wasserstand unterstützen wiederholbare Bezüge",
            "Brühgruppe Duschsieb und Tropfschale sind leicht zugänglich und ohne Spezialmittel zu reinigen",
        ],
        "Der kleine Siebträger bietet Kontrolle wie ein professionelles Gerät und passt dennoch in schmale Küchen oder Büros",
        "Rubin-Vorbrühkurve startet neun Sekunden mit niedrigem Druck bevor die vollständige Extraktion beginnt",
    ),
    listing(
        "travel-backpack",
        "Wetterfester Reiserucksack mit ergonomischem Tragesystem modularen Fächern und sicherem Laptopfach",
        "Reiserucksack Handgepäck Reise Laptop Fach wetterfest ergonomisch Organisation",
        [
            "Das gepolsterte Laptopfach lässt sich bei Sicherheitskontrollen separat und schnell öffnen",
            "Schultergurte Hüftgurt und belüfteter Rücken verteilen Gewicht auf langen Wegen",
            "Wetterfestes Recyclingmaterial widersteht Regen Abrieb Bahnreisen und häufigem Alltagseinsatz",
            "Modulare Innentaschen ordnen Kleidung Kabel Kamera Dokumente und Reiseutensilien",
            "Verdeckte Reißverschlüsse und ein körpernahes Wertsachenfach erschweren Taschendiebstahl",
        ],
        "Der Rucksack ist für mehrtägige Reisen Pendelwege und flexible Arbeit ausgelegt und bleibt bei Flugreisen handgepäcktauglich",
        "Nordlicht-Fach hält Reisepass und Notfallgeld getrennt von Ladegeräten Kabeln und allen Elektronikfächern",
    ),
    listing(
        "laptop-messenger-bag",
        "Schlanke Laptop Umhängetasche mit stoßfestem Notebookfach Organizer und abnehmbarem Schultergurt",
        "Laptop Tasche Umhängetasche Notebook Büro Schultergurt Organizer Schutz",
        [
            "Das gepolsterte Notebookfach schützt Computer bis fünfzehn Zoll vor Stößen und Kratzern",
            "Ein weiches Tabletfach und kleine Organizer halten Ladegerät Stifte Karten und Kopfhörer getrennt",
            "Der abnehmbare Schultergurt besitzt eine rutschfeste Polsterung für tägliche Arbeitswege",
            "Eine rückseitige Schlaufe befestigt die Tasche sicher am Griff eines Rollkoffers",
            "Das wasserabweisende Außenmaterial schützt Elektronik bei kurzem Regen in der Stadt",
        ],
        "Die leichte Businesstasche transportiert Notebook Tablet und wenige Dokumente ohne das Volumen eines Reiserucksacks",
        "Schiefer-Fach bewahrt Zugangskarte und Büroschlüssel getrennt vom magnetisch geschützten Tabletbereich auf",
    ),
    listing(
        "solar-power-bank",
        "Robuste Solar Powerbank mit großer Akkukapazität USB-C Schnellladen und faltbarem Outdoor Solarpanel",
        "Solar Powerbank Akku USB-C Ladegerät Outdoor Panel Energie Smartphone Reise",
        [
            "USB-C Power Delivery lädt Smartphone Kamera und kleines Notebook mit geregelter Leistung",
            "Das faltbare Solarpanel füllt den Akku auf Wanderungen unabhängig von einer Steckdose nach",
            "Eine genaue Prozentanzeige ersetzt unklare vierstufige Leuchtdioden für den Ladestand",
            "Wasserfestes Gehäuse und geschützte Anschlüsse widerstehen Staub Regen und Stößen",
            "Eine sparsame Notfallleuchte bietet weißes Dauerlicht und ein gut sichtbares Blinksignal",
        ],
        "Der mobile Energiespeicher versorgt Elektronik beim Camping auf Reisen und während kurzer Stromausfälle ohne Einweg-Batterien",
        "Sonnenpfad-Regler pausiert die Ladung bei Überhitzung und setzt sie nach sicherer Abkühlung automatisch fort",
    ),
    listing(
        "noise-canceling-headphones",
        "Kabelloser Over-Ear Kopfhörer mit adaptiver Geräuschunterdrückung Transparenzmodus und langer Akkulaufzeit",
        "Kopfhörer Bluetooth Noise Cancelling Geräuschunterdrückung Musik Akku Reise",
        [
            "Adaptive Mikrofone reduzieren Motoren Stimmen und gleichmäßigen Bürolärm ohne starken Ohrdruck",
            "Der Transparenzmodus mischt Durchsagen Gespräche und Verkehrsgeräusche natürlich zur Musik",
            "Weiche austauschbare Polster und ein leichter Bügel bleiben auf langen Flügen bequem",
            "Mehrpunkt-Bluetooth wechselt automatisch zwischen Notebook Smartphone und eingehenden Anrufen",
            "Ein abnehmbares Kabel ermöglicht Musikwiedergabe wenn der Akku leer oder Funk verboten ist",
        ],
        "Der geschlossene Reisekopfhörer verbindet ausgewogenen Klang klare Telefonate und wirksame Ruhe in Bahn Flugzeug und Großraumbüro",
        "Fjord-Stimmenmodus hebt Gesprächsfrequenzen an ohne das tiefe Brummen eines Flugzeugmotors wieder einzublenden",
    ),
]


QUERY_SPECS = {
    "privacy-wallet": {
        "hardNegative": "password-manager",
        "queries": [
            ("core", "sichere Open-Source Monero Wallet mit biometrischem Schutz"),
            ("bullet", "Ledger Transaktionen über USB physisch am Gerät bestätigen"),
            ("description_tail", "Polarstern Wiederherstellung identisches Unterkonto nach Neuinstallation"),
            ("paraphrase", "private Kryptowährungs App ohne Cloud für XMR Zahlungen"),
            ("cross_language", "open source Monero wallet with local keys and biometric unlock"),
        ],
    },
    "password-manager": {
        "hardNegative": "privacy-wallet",
        "queries": [
            ("core", "verschlüsselter Passwortmanager mit Passkeys und Autofill"),
            ("bullet", "Notfallzugang für Vertrauensperson zeitverzögert widerrufbar"),
            ("description_tail", "Bernstein Tresor erkennt ähnlich geschriebene Phishing Domain"),
            ("paraphrase", "Zugangsdaten lokal speichern und starke Kennwörter erzeugen"),
            ("typo", "paswort tresor mit verschluseltem backup und passkeys"),
        ],
    },
    "secure-messenger": {
        "hardNegative": "privacy-wallet",
        "queries": [
            ("core", "privater Messenger mit Ende zu Ende verschlüsselten Chats"),
            ("bullet", "Kontakt ohne öffentliche Telefonnummer über anonymen Benutzernamen"),
            ("description_tail", "Nebelbrücken Modus stellt bestätigte Kontakte ohne Nachrichten wieder her"),
            ("paraphrase", "sicher chatten und verschwindende Nachrichten senden"),
            ("cross_language", "encrypted messenger with private group calls and disappearing messages"),
        ],
    },
    "hardware-security-key": {
        "hardNegative": "password-manager",
        "queries": [
            ("core", "USB NFC Sicherheitsschlüssel für phishingresistente Anmeldung"),
            ("bullet", "FIDO2 Schlüssel mit physischer Berührung für Passkeys"),
            ("description_tail", "Kobalt Berührungscode zeigt erfolgreiche lokale Bestätigung"),
            ("paraphrase", "Hardware Token als zweiter Faktor ohne Batterie"),
            ("typo", "sicherheits schlssel usb c nfc fur webauthn login"),
        ],
    },
    "garden-robot": {
        "hardNegative": "robot-vacuum",
        "queries": [
            ("core", "leiser autonomer Gartenroboter für Rasen und Beete"),
            ("bullet", "Mähroboter mit Bodenfeuchte Sensor und austauschbaren Messern"),
            ("description_tail", "Moosgarten Spezialmodus für Schattenflächen nach starkem Regen"),
            ("paraphrase", "automatische Rasenpflege ohne Cloud mit lokaler Karte"),
            ("cross_language", "quiet robotic lawn mower with local navigation and no cloud"),
        ],
    },
    "robot-vacuum": {
        "hardNegative": "garden-robot",
        "queries": [
            ("core", "Saugroboter mit Wischfunktion und automatischer Absaugstation"),
            ("bullet", "Staubsauger Roboter erkennt Teppiche und hebt feuchtes Wischpad"),
            ("description_tail", "Korallenrand Erkennung neben Bodenvasen und Futternäpfen"),
            ("paraphrase", "Wohnung automatisch saugen mit lokaler Raumkarte"),
            ("typo", "saug roboter lasernavigaton fur teppich und hartboden"),
        ],
    },
    "coffee-grinder": {
        "hardNegative": "espresso-machine",
        "queries": [
            ("core", "elektrische Kaffeemühle mit präzisem Edelstahlmahlwerk"),
            ("bullet", "Mahlgrad von Espresso bis French Press stufenlos einstellen"),
            ("description_tail", "Bernstein Röstprofil für florale Noten heller äthiopischer Bohnen"),
            ("paraphrase", "Kaffeebohnen aromaschonend und gleichmäßig mahlen"),
            ("cross_language", "quiet burr coffee grinder for espresso and filter coffee"),
        ],
    },
    "espresso-machine": {
        "hardNegative": "coffee-grinder",
        "queries": [
            ("core", "kompakte Espressomaschine mit PID und Dampflanze"),
            ("bullet", "Siebträger mit programmierbarer Preinfusion und Manometer"),
            ("description_tail", "Rubin Vorbrühkurve neun Sekunden mit niedrigem Druck"),
            ("paraphrase", "Cappuccino zubereiten mit feinporigem Milchschaum"),
            ("typo", "espressomaschiene pid temperatur und pre infuson"),
        ],
    },
    "travel-backpack": {
        "hardNegative": "laptop-messenger-bag",
        "queries": [
            ("core", "wetterfester Reiserucksack mit sicherem Laptopfach"),
            ("bullet", "Handgepäck Rucksack mit Hüftgurt und verdecktem Wertsachenfach"),
            ("description_tail", "Nordlicht Fach trennt Reisepass und Notfallgeld von Elektronik"),
            ("paraphrase", "ergonomischer Rucksack für mehrtägige Flugreise"),
            ("cross_language", "weatherproof carry on travel backpack with hidden valuables pocket"),
        ],
    },
    "laptop-messenger-bag": {
        "hardNegative": "travel-backpack",
        "queries": [
            ("core", "schlanke Laptop Umhängetasche mit gepolstertem Notebookfach"),
            ("bullet", "Businesstasche mit Rollkoffer Schlaufe und abnehmbarem Schultergurt"),
            ("description_tail", "Schiefer Fach für Zugangskarte getrennt vom Tabletbereich"),
            ("paraphrase", "leichte Bürotasche für Notebook Tablet und Dokumente"),
            ("typo", "laptoptasche mit schulter gurt und stosfestem fach"),
        ],
    },
    "solar-power-bank": {
        "hardNegative": "travel-backpack",
        "queries": [
            ("core", "robuste Solar Powerbank mit USB-C Schnellladen"),
            ("bullet", "Outdoor Akku mit faltbarem Solarpanel und genauer Prozentanzeige"),
            ("description_tail", "Sonnenpfad Regler pausiert Laden bei Überhitzung"),
            ("paraphrase", "Smartphone beim Camping ohne Steckdose aufladen"),
            ("cross_language", "water resistant solar battery pack for phone and small laptop"),
        ],
    },
    "noise-canceling-headphones": {
        "hardNegative": "secure-messenger",
        "queries": [
            ("core", "kabelloser Over Ear Kopfhörer mit Geräuschunterdrückung"),
            ("bullet", "Noise Cancelling Kopfhörer mit Transparenzmodus und Mehrpunkt Bluetooth"),
            ("description_tail", "Fjord Stimmenmodus ohne Flugzeugbrummen"),
            ("paraphrase", "bequeme Reisekopfhörer für lange Flüge und Bürolärm"),
            ("typo", "kopfhorer mit geräusch unterdruckung und langem akku"),
        ],
    },
}


def prepared_query(
    tokenizer: object,
    query_instruction: str,
    query_id: str,
    query_group_id: str,
    query_kind: str,
    text: str,
    polarity: str,
    evaluated_product_id: str,
    expected_product_id: str,
) -> dict[str, object]:
    normalized = normalize_query(text)
    complete = query_instruction + normalized
    full_input_ids = tokenizer(
        complete,
        truncation=False,
        add_special_tokens=True,
    )["input_ids"]
    input_ids = full_input_ids[:MAX_INPUT_TOKENS]
    if len(full_input_ids) > MAX_INPUT_TOKENS:
        input_ids[-1] = tokenizer.eos_token_id
    attention_mask = [1] * len(input_ids)
    padding = MAX_INPUT_TOKENS - len(input_ids)
    return {
        "id": query_id,
        "queryGroupId": query_group_id,
        "queryKind": query_kind,
        "kind": "query",
        "language": "en" if query_kind == "cross_language" else "de",
        "polarity": polarity,
        "evaluatedProductId": evaluated_product_id,
        "expectedTopProductId": expected_product_id,
        "fullInputTokens": len(full_input_ids),
        "retainedInputTokens": len(input_ids),
        "wasTruncated": len(full_input_ids) > MAX_INPUT_TOKENS,
        "inputIds": input_ids + [tokenizer.pad_token_id] * padding,
        "attentionMask": attention_mask + [0] * padding,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--query-profile",
        choices=sorted(QUERY_PROFILES),
        default="production-v2",
        help="Production prompt or one of the controlled test-only ablations.",
    )
    args = parser.parse_args()
    query_prompt_version, query_instruction = QUERY_PROFILES[
        args.query_profile
    ]

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

    cases: list[dict[str, object]] = []
    for item in PRODUCTS:
        full_input_ids = tokenizer(
            str(item["text"]),
            truncation=False,
            add_special_tokens=True,
        )["input_ids"]
        embedding_inputs = []
        for embedding_input in product_embedding_inputs(item):
            chunk_input_ids = tokenizer(
                str(embedding_input["text"]),
                truncation=False,
                add_special_tokens=True,
            )["input_ids"]
            input_ids = chunk_input_ids[:MAX_INPUT_TOKENS]
            if len(chunk_input_ids) > MAX_INPUT_TOKENS:
                input_ids[-1] = tokenizer.eos_token_id
            attention_mask = [1] * len(input_ids)
            padding = MAX_INPUT_TOKENS - len(input_ids)
            embedding_inputs.append(
                {
                    key: value
                    for key, value in embedding_input.items()
                    if key != "text"
                }
                | {
                    "fullInputTokens": len(chunk_input_ids),
                    "retainedInputTokens": len(input_ids),
                    "wasTruncated": len(chunk_input_ids) > MAX_INPUT_TOKENS,
                    "inputIds": input_ids + [tokenizer.pad_token_id] * padding,
                    "attentionMask": attention_mask + [0] * padding,
                }
            )
        cases.append(
            {
                key: value for key, value in item.items() if key != "text"
            }
            | {
                "fullInputTokens": len(full_input_ids),
                "retainedInputTokens": min(
                    len(full_input_ids), MAX_INPUT_TOKENS
                ),
                "wasTruncated": len(full_input_ids) > MAX_INPUT_TOKENS,
                "embeddingInputs": embedding_inputs,
            }
        )

    distinct_queries = 0
    for expected_product_id, spec in QUERY_SPECS.items():
        hard_negative_id = str(spec["hardNegative"])
        for query_kind, text in spec["queries"]:
            distinct_queries += 1
            group_id = f"{expected_product_id}-{query_kind}"
            cases.append(
                prepared_query(
                    tokenizer,
                    query_instruction,
                    f"positive-{group_id}",
                    group_id,
                    query_kind,
                    text,
                    "positive",
                    expected_product_id,
                    expected_product_id,
                )
            )
            cases.append(
                prepared_query(
                    tokenizer,
                    query_instruction,
                    f"negative-{group_id}-vs-{hard_negative_id}",
                    group_id,
                    query_kind,
                    text,
                    "negative",
                    hard_negative_id,
                    expected_product_id,
                )
            )

    output = {
        "schemaVersion": 2,
        "modelId": MODEL_ID,
        "sourceRevision": MODEL_REVISION,
        "sourceWeightsSha256": MODEL_SHA256,
        "tokenizerSha256": TOKENIZER_SHA256,
        "queryPromptVersion": query_prompt_version,
        "queryInstruction": query_instruction,
        "documentPromptVersion": "community-document-v1",
        "maxInputTokens": MAX_INPUT_TOKENS,
        "productCount": len(PRODUCTS),
        "distinctQueryCount": distinct_queries,
        "labeledPairCount": len(cases) - len(PRODUCTS),
        "cases": cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {len(PRODUCTS)} products, {distinct_queries} distinct queries "
        f"and {output['labeledPairCount']} labeled pairs to {args.output}"
    )


if __name__ == "__main__":
    main()
