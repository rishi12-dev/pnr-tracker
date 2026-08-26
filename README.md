# PNR Tracker — Telegram + RailKit

This version uses the official RailKit Node.js SDK for PNR status. RailKit documents
`checkPNRStatus(pnr)` as the PNR method and requires a RailKit API key. The Python
Telegram bot calls a small Node.js bridge so you can keep the existing Telegram bot.

## Install

1. Install Python 3.11+ and Node.js 18+.
2. In this folder:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
npm install
```

3. Copy `.env.example` to `.env` and fill:

```env
TELEGRAM_BOT_TOKEN=your_telegram_token
PNR_API_KEY=your_railkit_key
CHECK_INTERVAL_HOURS=2
DATABASE_PATH=pnr_tracker.db
```

4. Run:

```powershell
python app.py
```

5. In Telegram, open your bot and send `/start`.
6. Add a PNR:

```text
/add 1234567890
```

The first successful check saves a baseline. After that, the bot checks every 2 hours
and sends a Telegram alert when the current passenger status changes.

## Commands

`/start`
`/add 1234567890`
`/list`
`/status 1234567890`
`/remove 1234567890`
`/check`

## Important

The PC must remain on and connected to the internet for the 2-hour scheduler to run.
For 24/7 tracking, deploy this folder to an always-on VPS/cloud machine.
