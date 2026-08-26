import os
import json
import subprocess
import requests
from pathlib import Path

TELEGRAM_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
RAILKIT_KEY = os.environ["PNR_API_KEY"]

STATUS_FILE = Path("pnr_status.json")

# Your PNR and Telegram Chat ID
PNRS = [
    "4863173213"
]

CHAT_ID = "1392686700"


def load_status():
    if not STATUS_FILE.exists():
        return {}

    try:
        return json.loads(
            STATUS_FILE.read_text(encoding="utf-8")
        )
    except Exception:
        return {}


def save_status(data):
    STATUS_FILE.write_text(
        json.dumps(
            data,
            indent=2,
            ensure_ascii=False
        ),
        encoding="utf-8"
    )


def check_pnr(pnr):
    env = os.environ.copy()
    env["RAILKIT_API_KEY"] = RAILKIT_KEY

    result = subprocess.run(
        ["node", "pnr_client.mjs", pnr],
        env=env,
        capture_output=True,
        text=True,
        timeout=60
    )

    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip() or "RailKit request failed"
        )

    data = json.loads(result.stdout)

    if not data.get("success"):
        raise RuntimeError(
            data.get("error", "PNR check failed")
        )

    return data["data"]


def send_telegram(message):
    url = (
        f"https://api.telegram.org/"
        f"bot{TELEGRAM_TOKEN}/sendMessage"
    )

    response = requests.post(
        url,
        json={
            "chat_id": CHAT_ID,
            "text": message
        },
        timeout=30
    )

    response.raise_for_status()


previous = load_status()

for pnr in PNRS:

    try:
        data = check_pnr(pnr)

        passengers = data.get("passengers") or []

        statuses = []

        for passenger in passengers:
            current = passenger.get("current") or {}

            status = (
                current.get("details")
                or current.get("status")
                or "-"
            )

            statuses.append(status)

        current_status = " | ".join(statuses) or "-"

        old_status = previous.get(pnr)

        print(f"PNR: {pnr}")
        print(f"Previous: {old_status}")
        print(f"Current: {current_status}")

        # First check: save the status as baseline
        if old_status is None:

            previous[pnr] = current_status

            # Send first status so we know the bot works
            train = data.get("train") or {}
            journey = data.get("journey") or {}

            message = (
                "🚆 PNR TRACKING STARTED\n\n"
                f"PNR: {pnr}\n"
                f"Train: {train.get('number', '-')}"
                f" {train.get('name', '')}\n"
                f"Journey: {journey.get('dateOfJourney', '-')}\n\n"
                f"Current Status: {current_status}\n"
            )

            send_telegram(message)

        # Status changed
        elif old_status != current_status:

            train = data.get("train") or {}
            journey = data.get("journey") or {}

            message = (
                "🔔 PNR STATUS CHANGED\n\n"
                f"PNR: {pnr}\n"
                f"Train: {train.get('number', '-')}"
                f" {train.get('name', '')}\n"
                f"Journey: {journey.get('dateOfJourney', '-')}\n\n"
                f"Previous: {old_status}\n"
                f"Current: {current_status}\n"
            )

            send_telegram(message)

            previous[pnr] = current_status

    except Exception as e:
        print(f"❌ Error checking {pnr}: {e}")


save_status(previous)
