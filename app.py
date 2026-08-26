import os
import sqlite3
import logging
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from apscheduler.schedulers.background import BackgroundScheduler
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
RAILKIT_KEY = os.getenv("PNR_API_KEY", "").strip()
DB_PATH = os.getenv("DATABASE_PATH", "pnr_tracker.db")
INTERVAL_HOURS = max(1, int(os.getenv("CHECK_INTERVAL_HOURS", "2")))
ROOT = Path(__file__).resolve().parent
NODE_HELPER = ROOT / "pnr_client.mjs"

if not TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN is missing in .env")
if not RAILKIT_KEY:
    raise RuntimeError("PNR_API_KEY is missing in .env")


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()
    con.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            chat_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS pnrs (
            pnr TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            last_status TEXT,
            last_raw TEXT,
            updated_at TEXT,
            PRIMARY KEY (pnr, chat_id)
        )
    """)
    con.commit()
    con.close()


def now():
    return datetime.now(timezone.utc).isoformat()


def register_chat(chat_id: str):
    con = db()
    con.execute(
        "INSERT OR IGNORE INTO chats(chat_id, created_at) VALUES (?, ?)",
        (chat_id, now()),
    )
    con.commit()
    con.close()


def fetch_pnr(pnr: str) -> dict:
    env = os.environ.copy()
    env["RAILKIT_API_KEY"] = RAILKIT_KEY

    proc = subprocess.run(
        ["node", str(NODE_HELPER), pnr],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
    )

    if proc.returncode != 0:
        msg = proc.stderr.strip() or proc.stdout.strip() or "RailKit request failed"
        raise RuntimeError(msg)

    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid response from RailKit helper: {proc.stdout[:500]}") from exc

    if not result.get("success"):
        raise RuntimeError(result.get("error", "RailKit returned an unsuccessful response"))

    d = result["data"]
    passengers = d.get("passengers") or []

    passenger_lines = []
    current_statuses = []
    booking_statuses = []
    for p in passengers:
        booking = p.get("booking") or {}
        current = p.get("current") or {}
        b = booking.get("details") or booking.get("status") or "-"
        c = current.get("details") or current.get("status") or "-"
        passenger_lines.append(
            f"{p.get('serialNumber', 'Passenger')}: {b} → {c}"
        )
        current_statuses.append(c)
        booking_statuses.append(b)

    normalized_current = " | ".join(current_statuses) if current_statuses else "-"
    normalized_booking = " | ".join(booking_statuses) if booking_statuses else "-"

    return {
        "pnr": str(d.get("pnr", pnr)),
        "train_number": str((d.get("train") or {}).get("number", "")),
        "train_name": str((d.get("train") or {}).get("name", "")),
        "from": str(((d.get("journey") or {}).get("source") or {}).get("name", "")),
        "to": str(((d.get("journey") or {}).get("destination") or {}).get("name", "")),
        "journey_date": str((d.get("journey") or {}).get("dateOfJourney", "")),
        "booking_status": normalized_booking,
        "current_status": normalized_current,
        "chart_status": str((d.get("chart") or {}).get("status", "")),
        "passenger_lines": passenger_lines,
        "raw": d,
    }


def get_pnrs(chat_id: Optional[str] = None):
    con = db()
    if chat_id:
        rows = con.execute(
            "SELECT * FROM pnrs WHERE chat_id=? ORDER BY pnr",
            (chat_id,),
        ).fetchall()
    else:
        rows = con.execute("SELECT * FROM pnrs").fetchall()
    con.close()
    return rows


def save_baseline(pnr, chat_id, data):
    con = db()
    con.execute(
        """UPDATE pnrs
           SET last_status=?, last_raw=?, updated_at=?
           WHERE pnr=? AND chat_id=?""",
        (
            data.get("current_status", ""),
            json.dumps(data.get("raw", {}), ensure_ascii=False),
            now(),
            pnr,
            chat_id,
        ),
    )
    con.commit()
    con.close()


def add_pnr(pnr, chat_id):
    con = db()
    con.execute(
        "INSERT OR IGNORE INTO pnrs(pnr, chat_id, updated_at) VALUES (?, ?, ?)",
        (pnr, chat_id, now()),
    )
    con.commit()
    con.close()


def remove_pnr(pnr, chat_id):
    con = db()
    cur = con.execute(
        "DELETE FROM pnrs WHERE pnr=? AND chat_id=?",
        (pnr, chat_id),
    )
    con.commit()
    con.close()
    return cur.rowcount > 0


def format_status(d: dict) -> str:
    passengers = "\n".join(d.get("passenger_lines") or []) or "-"
    return (
        "🚆 PNR STATUS\n\n"
        f"PNR: {d['pnr']}\n"
        f"Train: {d.get('train_number') or '-'} {d.get('train_name') or ''}\n"
        f"Journey: {d.get('journey_date') or '-'}\n"
        f"From: {d.get('from') or '-'}\n"
        f"To: {d.get('to') or '-'}\n\n"
        f"Passengers:\n{passengers}\n\n"
        f"Chart: {d.get('chart_status') or '-'}"
    )


async def send_text(bot, chat_id, text):
    await bot.send_message(chat_id=chat_id, text=text)


async def check_one(bot, pnr, chat_id, notify=True):
    try:
        data = fetch_pnr(pnr)
    except Exception as exc:
        logging.exception("PNR check failed: %s", pnr)
        if notify:
            await send_text(bot, chat_id, f"⚠️ PNR {pnr} check failed.\n{exc}")
        return False

    con = db()
    row = con.execute(
        "SELECT last_status FROM pnrs WHERE pnr=? AND chat_id=?",
        (pnr, chat_id),
    ).fetchone()
    old_status = row["last_status"] if row else None
    new_status = data.get("current_status", "")

    save_baseline(pnr, chat_id, data)

    if old_status is None:
        if notify:
            await send_text(bot, chat_id, "🚆 TRACKING STARTED\n\n" + format_status(data))
        return True

    if old_status != new_status and notify:
        await send_text(
            bot,
            chat_id,
            "🔔 PNR STATUS CHANGED\n\n"
            f"PNR: {data['pnr']}\n"
            f"Train: {data.get('train_number') or '-'} {data.get('train_name') or ''}\n"
            f"Journey: {data.get('journey_date') or '-'}\n\n"
            f"Previous: {old_status or '-'}\n"
            f"Current: {new_status or '-'}\n\n"
            + format_status(data),
        )

    return True


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    register_chat(chat_id)
    await update.message.reply_text(
        "✅ Chat registered.\n\n"
        "Commands:\n"
        "/add 1234567890\n"
        "/list\n"
        "/status 1234567890\n"
        "/remove 1234567890\n"
        "/check"
    )


async def add_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    register_chat(chat_id)
    if not context.args:
        await update.message.reply_text("Use: /add 1234567890")
        return
    pnr = context.args[0].strip()
    if len(pnr) != 10 or not pnr.isdigit():
        await update.message.reply_text("❌ PNR must be exactly 10 digits.")
        return
    add_pnr(pnr, chat_id)
    await update.message.reply_text(f"✅ Tracking started for PNR {pnr}. Checking now...")
    await check_one(context.bot, pnr, chat_id, notify=True)


async def list_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    rows = get_pnrs(chat_id)
    if not rows:
        await update.message.reply_text("No PNRs are being tracked.")
        return
    lines = ["🚆 TRACKED PNRs"]
    for r in rows:
        lines.append(f"{r['pnr']} — {r['last_status'] or 'Not checked yet'}")
    await update.message.reply_text("\n".join(lines))


async def status_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    if not context.args:
        await update.message.reply_text("Use: /status 1234567890")
        return
    pnr = context.args[0].strip()
    rows = [r for r in get_pnrs(chat_id) if r["pnr"] == pnr]
    if not rows:
        await update.message.reply_text("PNR is not being tracked. Use /add first.")
        return
    await update.message.reply_text("⏳ Checking PNR...")
    await check_one(context.bot, pnr, chat_id, notify=True)


async def remove_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    if not context.args:
        await update.message.reply_text("Use: /remove 1234567890")
        return
    pnr = context.args[0].strip()
    ok = remove_pnr(pnr, chat_id)
    await update.message.reply_text(f"✅ Removed {pnr}." if ok else "PNR was not found.")


async def check_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    rows = get_pnrs(chat_id)
    if not rows:
        await update.message.reply_text("No PNRs are being tracked.")
        return
    await update.message.reply_text("⏳ Checking all tracked PNRs...")
    for r in rows:
        await check_one(context.bot, r["pnr"], chat_id, notify=True)


async def scheduled_job(app: Application):
    rows = get_pnrs()
    logging.info("Scheduled PNR check: %d tracked records", len(rows))
    for r in rows:
        try:
            await check_one(app.bot, r["pnr"], r["chat_id"], notify=True)
        except Exception:
            logging.exception("Scheduled check failed for %s", r["pnr"])


def main():
    init_db()
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("add", add_cmd))
    app.add_handler(CommandHandler("list", list_cmd))
    app.add_handler(CommandHandler("status", status_cmd))
    app.add_handler(CommandHandler("remove", remove_cmd))
    app.add_handler(CommandHandler("check", check_cmd))

    scheduler = BackgroundScheduler()
    scheduler.add_job(
        lambda: app.create_task(scheduled_job(app)),
        "interval",
        hours=INTERVAL_HOURS,
        id="pnr-check",
        replace_existing=True,
    )
    scheduler.start()

    logging.info("PNR Tracker running. Interval=%s hours", INTERVAL_HOURS)
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
