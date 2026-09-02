import {
  configure,
  checkPNRStatus,
  trackTrain,
  searchTrainBetweenStations,
} from "railkit";


/* =========================
   TELEGRAM HELPERS
========================= */

async function sendTelegram(
  env,
  chatId,
  text,
  replyMarkup = null
) {
  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage";

  const body = {
    chat_id: String(chatId),
    text: String(text),
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await response.text();

  console.log(
    "Telegram response:",
    result
  );

  if (!response.ok) {
    throw new Error(
      "Telegram API error " +
        response.status +
        ": " +
        result
    );
  }

  return result;
}


async function editTelegramMessage(
  env,
  chatId,
  messageId,
  text,
  replyMarkup = null
) {
  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/editMessageText";

  const body = {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text: String(text),
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await response.text();

  if (!response.ok) {
    throw new Error(
      "Telegram editMessageText error " +
        response.status +
        ": " +
        result
    );
  }

  return result;
}


async function answerCallbackQuery(
  env,
  callbackQueryId
) {
  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/answerCallbackQuery";

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      callback_query_id:
        callbackQueryId,
    }),
  });
}


/* =========================
   VALIDATION
========================= */

function isValidPNR(pnr) {
  return /^\d{10}$/.test(pnr);
}


function isValidTrainNumber(
  trainNumber
) {
  return /^\d{5}$/.test(trainNumber);
}


function getCommand(text) {
  const parts =
    text.trim().split(/\s+/);

  return {
    command:
      (parts[0] || "").toLowerCase(),

    argument:
      parts[1] || "",
  };
}


/* =========================
   INDIA DATE / TIME HELPERS
========================= */

function getIndiaNow() {
  return new Date(
    new Date().toLocaleString(
      "en-US",
      {
        timeZone: "Asia/Kolkata",
      }
    )
  );
}


function getIndiaDate() {
  const now =
    getIndiaNow();

  const day =
    String(
      now.getDate()
    ).padStart(2, "0");

  const month =
    String(
      now.getMonth() + 1
    ).padStart(2, "0");

  const year =
    now.getFullYear();

  return `${day}-${month}-${year}`;
}


function parseTimeToMinutes(
  timeValue
) {
  if (!timeValue) {
    return null;
  }

  const text =
    String(timeValue).trim();

  if (!text) {
    return null;
  }

  const match =
    text.match(
      /(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return null;
  }

  const hours =
    Number(match[1]);

  const minutes =
    Number(match[2]);

  if (
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return (
    hours * 60 +
    minutes
  );
}


function parseDelayMinutes(
  delayValue
) {
  if (
    delayValue === null ||
    delayValue === undefined
  ) {
    return 0;
  }

  const text =
    String(delayValue);

  const match =
    text.match(/-?\d+/);

  if (!match) {
    return 0;
  }

  return (
    Number(match[0]) || 0
  );
}


function getCurrentIndiaMinutes() {
  const now =
    getIndiaNow();

  return (
    now.getHours() * 60 +
    now.getMinutes() +
    now.getSeconds() / 60
  );
}


/* =========================
   SEARCH TRAIN HELPERS
========================= */

const searchSessions =
  new Map();


function isValidStationCode(
  code
) {
  return /^[A-Z]{2,5}$/.test(
    String(code || "")
      .trim()
      .toUpperCase()
  );
}


function isValidJourneyDate(
  dateText
) {
  const text =
    String(dateText || "")
      .trim();

  if (
    !/^\d{2}-\d{2}-\d{4}$/.test(
      text
    )
  ) {
    return false;
  }

  const parts =
    text.split("-");

  const day =
    Number(parts[0]);

  const month =
    Number(parts[1]);

  const year =
    Number(parts[2]);

  const date =
    new Date(
      year,
      month - 1,
      day
    );

  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}


function searchTrainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "❌ Cancel",
          callback_data:
            "main_menu",
        },
      ],
    ],
  };
}


async function startTrainSearch(
  env,
  chatId,
  messageId
) {
  searchSessions.set(
    String(chatId),
    {
      step: "from",
      from: "",
      to: "",
      date: "",
    }
  );

  await editTelegramMessage(
    env,
    chatId,
    messageId,

    `🔍 SEARCH TRAINS\n\n` +
      `Find trains between two railway stations.\n\n` +
      `📍 Step 1 of 3\n\n` +
      `Send the FROM station code.\n\n` +
      `Example:\n` +
      `NDLS\n\n` +
      `Delhi → NDLS`,

    searchTrainKeyboard()
  );
}


async function processTrainSearchInput(
  env,
  chatId,
  text
) {
  const session =
    searchSessions.get(
      String(chatId)
    );

  if (!session) {
    return false;
  }

  const cleanText =
    String(text || "")
      .trim();

  if (!cleanText) {
    return true;
  }


  /* =========================
     STEP 1 - FROM
  ========================= */

  if (
    session.step === "from"
  ) {
    const from =
      cleanText
        .toUpperCase();

    if (
      !isValidStationCode(from)
    ) {
      await sendTelegram(
        env,
        chatId,

        `❌ Invalid station code.\n\n` +
          `Please send a valid railway station code.\n\n` +
          `Example:\n` +
          `NDLS`
      );

      return true;
    }

    session.from =
      from;

    session.step =
      "to";

    searchSessions.set(
      String(chatId),
      session
    );

    await sendTelegram(
      env,
      chatId,

      `📍 FROM: ${from}\n\n` +
        `📍 Step 2 of 3\n\n` +
        `Now send the TO station code.\n\n` +
        `Example:\n` +
        `BCT`
    );

    return true;
  }


  /* =========================
     STEP 2 - TO
  ========================= */

  if (
    session.step === "to"
  ) {
    const to =
      cleanText
        .toUpperCase();

    if (
      !isValidStationCode(to)
    ) {
      await sendTelegram(
        env,
        chatId,

        `❌ Invalid station code.\n\n` +
          `Please send a valid railway station code.\n\n` +
          `Example:\n` +
          `BCT`
      );

      return true;
    }

    if (
      to === session.from
    ) {
      await sendTelegram(
        env,
        chatId,

        `❌ FROM and TO stations cannot be the same.\n\n` +
          `Please send a different destination station code.`
      );

      return true;
    }

    session.to =
      to;

    session.step =
      "date";

    searchSessions.set(
      String(chatId),
      session
    );

    await sendTelegram(
      env,
      chatId,

      `📍 FROM: ${session.from}\n` +
        `📍 TO: ${session.to}\n\n` +
        `📅 Step 3 of 3\n\n` +
        `Send journey date in this format:\n\n` +
        `DD-MM-YYYY\n\n` +
        `Example:\n` +
        `15-09-2026`
    );

    return true;
  }


  /* =========================
     STEP 3 - DATE
  ========================= */

  if (
    session.step === "date"
  ) {
    const date =
      cleanText;

    if (
      !isValidJourneyDate(
        date
      )
    ) {
      await sendTelegram(
        env,
        chatId,

        `❌ Invalid date.\n\n` +
          `Please use DD-MM-YYYY format.\n\n` +
          `Example:\n` +
          `15-09-2026`
      );

      return true;
    }

    session.date =
      date;

    searchSessions.delete(
      String(chatId)
    );

    await sendTelegram(
      env,
      chatId,

      `🔎 Searching trains...\n\n` +
        `📍 ${session.from} → ${session.to}\n` +
        `📅 ${session.date}`
    );

    try {
      configure(
        env.RAILKIT_API_KEY
      );

      const result =
        await searchTrainBetweenStations(
          session.from,
          session.to,
          session.date
        );

      const trains =
        Array.isArray(
          result?.data
        )
          ? result.data
          : Array.isArray(result)
            ? result
            : [];

      if (
        trains.length === 0
      ) {
        await sendTelegram(
          env,
          chatId,

          `🚆 NO TRAINS FOUND\n\n` +
            `📍 ${session.from} → ${session.to}\n` +
            `📅 ${session.date}\n\n` +
            `No direct trains were found for this search.`
        );

        return true;
      }

      let message =
        `🚆 TRAINS FOUND\n\n` +
        `📍 ${session.from} → ${session.to}\n` +
        `📅 ${session.date}\n\n`;

      const limitedTrains =
        trains.slice(0, 10);

      limitedTrains.forEach(
        (train, index) => {
          const trainNo =
            train?.train_no ||
            train?.trainNumber ||
            train?.number ||
            "-";

          const trainName =
            train?.train_name ||
            train?.trainName ||
            train?.name ||
            "Unknown Train";

          const fromTime =
            train?.from_time ||
            train?.fromTime ||
            "-";

          const toTime =
            train?.to_time ||
            train?.toTime ||
            "-";

          const travelTime =
            train?.travel_time ||
            train?.travelTime ||
            "-";

          message +=
            `${index + 1}. 🚂 ${trainNo} ${trainName}\n` +
            `   🕐 ${fromTime} → ${toTime}\n` +
            `   ⏱️ ${travelTime}\n\n`;
        }
      );

      if (
        trains.length > 10
      ) {
        message +=
          `Showing first 10 of ${trains.length} trains.`;
      }

      await sendTelegram(
        env,
        chatId,
        message
      );

    } catch (error) {
      console.error(
        "RailKit Search Train error:",
        error
      );

      await sendTelegram(
        env,
        chatId,

        `❌ TRAIN SEARCH FAILED\n\n` +
          `📍 ${session.from} → ${session.to}\n` +
          `📅 ${session.date}\n\n` +
          `Please try again later.\n\n` +
          `Error: ${
            error.message ||
            "Unknown error"
          }`
      );
    }

    return true;
  }

  return true;
}


/* =========================
   USER
========================= */

async function saveUser(
  env,
  chatId,
  username
) {
  await env.DB.prepare(`
    INSERT INTO users (
      telegram_id,
      username
    )
    VALUES (?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET
      username = excluded.username
  `)
    .bind(
      chatId,
      username || ""
    )
    .run();
}


async function getUserCount(env) {
  const result =
    await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM users
    `)
      .first();

  return Number(
    result?.total || 0
  );
}


/* =========================
   PHASE 1 UI
========================= */

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🎫 PNR Status",
          callback_data:
            "pnr_menu",
        },
        {
          text: "🚂 Train Status",
          callback_data:
            "train_menu",
        },
      ],

      [
        {
          text: "🔍 Search Trains",
          callback_data:
            "search_menu",
        },
        {
          text: "💺 Availability",
          callback_data:
            "availability_menu",
        },
      ],

      [
        {
          text: "💰 Fare Enquiry",
          callback_data:
            "fare_menu",
        },
        {
          text: "🚉 Station Info",
          callback_data:
            "station_menu",
        },
      ],

      [
        {
          text: "🔔 My Alerts",
          callback_data:
            "alerts_menu",
        },
        {
          text: "📋 My PNRs",
          callback_data:
            "pnr_list",
        },
      ],

      [
        {
          text: "ℹ️ Help",
          callback_data:
            "help_menu",
        },
      ],
    ],
  };
}


function backButton() {
  return {
    inline_keyboard: [
      [
        {
          text:
            "⬅️ Back to Main Menu",
          callback_data:
            "main_menu",
        },
      ],
    ],
  };
}


function pnrMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ Add PNR",
          callback_data:
            "pnr_add",
        },
        {
          text: "🔎 Check PNR",
          callback_data:
            "pnr_check",
        },
      ],

      [
        {
          text: "📋 My PNRs",
          callback_data:
            "pnr_list",
        },
        {
          text: "🗑️ Remove PNR",
          callback_data:
            "pnr_remove",
        },
      ],

      [
        {
          text: "⬅️ Back",
          callback_data:
            "main_menu",
        },
      ],
    ],
  };
}


function trainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text:
            "📍 Live Train Status",
          callback_data:
            "train_live",
        },
      ],

      [
        {
          text: "⬅️ Back",
          callback_data:
            "main_menu",
        },
      ],
    ],
  };
}


/* =========================
   MAIN MENU
========================= */

async function showMainMenu(
  env,
  chatId,
  messageId = null
) {
  const userCount =
    await getUserCount(env);

  const text =
    `🚆 RAILWAY ASSISTANT\n\n` +
    `Your smart railway companion 🇮🇳\n\n` +
    `👥 ${userCount.toLocaleString("en-IN")} passengers are using this bot\n\n` +
    `What would you like to do?`;

  if (messageId) {
    await editTelegramMessage(
      env,
      chatId,
      messageId,
      text,
      mainMenuKeyboard()
    );
  } else {
    await sendTelegram(
      env,
      chatId,
      text,
      mainMenuKeyboard()
    );
  }
}


/* =========================
   PNR MENU
========================= */

async function showPNRMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,

    `🎫 PNR STATUS\n\n` +
      `Manage and check your railway PNR.\n\n` +
      `Choose an option below:`,

    pnrMenuKeyboard()
  );
}


/* =========================
   TRAIN MENU
========================= */

async function showTrainMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,

    `🚂 TRAIN STATUS\n\n` +
      `Check live running status of any train.\n\n` +
      `Choose an option below:`,

    trainMenuKeyboard()
  );
}


/* =========================
   COMING SOON
========================= */

async function showComingSoon(
  env,
  chatId,
  messageId,
  title
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,

    `${title}\n\n` +
      `🚧 This feature is coming soon.\n\n` +
      `We're building the next-generation Railway Assistant for you. 🚆`,

    backButton()
  );
}


/* =========================
   HELP
========================= */

async function showHelpMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,

    `ℹ️ HELP\n\n` +

      `🎫 PNR Status\n` +
      `Check your live PNR status.\n\n` +

      `🚂 Train Status\n` +
      `Track a train's live movement.\n\n` +

      `🔍 Search Trains\n` +
      `Find trains between two stations.\n\n` +

      `🔔 My Alerts\n` +
      `Manage your train arrival alerts.\n\n` +

      `📋 My PNRs\n` +
      `View your saved PNRs.\n\n` +

      `Existing commands:\n\n` +

      `/add 1234567890\n` +
      `/check 1234567890\n` +
      `/train 12522\n` +
      `/alert 12522\n` +
      `/list\n` +
      `/remove 1234567890\n` +
      `/cancelalert`,

    backButton()
  );
}


/* =========================
   PNR ADD
========================= */

async function handleAdd(
  env,
  chatId,
  pnr
) {
  if (!isValidPNR(pnr)) {
    await sendTelegram(
      env,
      chatId,

      "❌ Invalid PNR.\n\n" +
        "PNR must contain exactly 10 digits."
    );

    return;
  }

  await env.DB.prepare(`
    INSERT INTO pnrs (
      telegram_id,
      pnr
    )
    VALUES (?, ?)
    ON CONFLICT(telegram_id, pnr)
    DO NOTHING
  `)
    .bind(
      chatId,
      pnr
    )
    .run();

  await sendTelegram(
    env,
    chatId,

    `✅ PNR ${pnr} added successfully.\n\n` +
      `Now use:\n\n` +
      `/check ${pnr}\n\n` +
      `to check the live status.`
  );
}


/* =========================
   PNR LIST
========================= */

async function handleList(
  env,
  chatId
) {
  const result =
    await env.DB.prepare(`
      SELECT
        pnr,
        last_status
      FROM pnrs
      WHERE telegram_id = ?
      ORDER BY created_at DESC
    `)
      .bind(chatId)
      .all();

  if (
    !result.results ||
    result.results.length === 0
  ) {
    await sendTelegram(
      env,
      chatId,

      "📭 You haven't added any PNR yet."
    );

    return;
  }

  let message =
    "📋 Your saved PNRs:\n\n";

  for (
    const row of result.results
  ) {
    message +=
      `🎫 ${row.pnr}\n`;

    message +=
      `Status: ${
        row.last_status ||
        "Not checked yet"
      }\n\n`;
  }

  await sendTelegram(
    env,
    chatId,
    message
  );
}


/* =========================
   PNR LIST UI
========================= */

async function showPNRListUI(
  env,
  chatId,
  messageId
) {
  const result =
    await env.DB.prepare(`
      SELECT
        pnr,
        last_status
      FROM pnrs
      WHERE telegram_id = ?
      ORDER BY created_at DESC
    `)
      .bind(chatId)
      .all();

  let text =
    `📋 MY PNRs\n\n`;

  if (
    !result.results ||
    result.results.length === 0
  ) {
    text +=
      `📭 You haven't added any PNR yet.\n\n` +
      `Use /add 1234567890 to add one.`;

    await editTelegramMessage(
      env,
      chatId,
      messageId,
      text,
      backButton()
    );

    return;
  }

  for (
    const row of result.results
  ) {
    text +=
      `🎫 ${row.pnr}\n` +
      `Status: ${
        row.last_status ||
        "Not checked yet"
      }\n\n`;
  }

  await editTelegramMessage(
    env,
    chatId,
    messageId,
    text,
    backButton()
  );
}


/* =========================
   PNR REMOVE
========================= */

async function handleRemove(
  env,
  chatId,
  pnr
) {
  if (!isValidPNR(pnr)) {
    await sendTelegram(
      env,
      chatId,

      "❌ Please enter a valid 10-digit PNR."
    );

    return;
  }

  const result =
    await env.DB.prepare(`
      DELETE FROM pnrs
      WHERE telegram_id = ?
      AND pnr = ?
    `)
      .bind(
        chatId,
        pnr
      )
      .run();

  if (
    result.meta.changes === 0
  ) {
    await sendTelegram(
      env,
      chatId,

      `❌ PNR ${pnr} was not found in your list.`
    );

    return;
  }

  await sendTelegram(
    env,
    chatId,

    `🗑️ PNR ${pnr} removed successfully.`
  );
}


/* =========================
   PNR CHECK
========================= */

async function handleCheck(
  env,
  chatId,
  pnr
) {
  if (!isValidPNR(pnr)) {
    await sendTelegram(
      env,
      chatId,

      "❌ Please enter a valid 10-digit PNR."
    );

    return;
  }

  await sendTelegram(
    env,
    chatId,

    `🔎 Checking PNR ${pnr}...`
  );

  try {
    configure(
      env.RAILKIT_API_KEY
    );

    const result =
      await checkPNRStatus(pnr);

    const data =
      result?.data ||
      result ||
      {};

    const train =
      data.train || {};

    const journey =
      data.journey || {};

    const passengers =
      data.passengers || [];

    let passengerText =
      "";

    passengers.forEach(
      (passenger, index) => {

        const current =
          passenger?.current ||
          {};

        passengerText +=
          `\nPassenger ${index + 1}: ` +
          `${
            current.details ||
            current.status ||
            "-"
          }\n`;
      }
    );

    const message =
      `🚆 PNR STATUS\n\n` +

      `PNR: ${pnr}\n` +

      `Train: ${
        train.number || "-"
      } ${
        train.name || ""
      }\n` +

      `Journey Date: ${
        journey.dateOfJourney ||
        "-"
      }\n` +

      passengerText;

    await sendTelegram(
      env,
      chatId,
      message
    );

    const statusText =
      passengers
        .map(
          (passenger) =>
            passenger?.current
              ?.details ||
            passenger?.current
              ?.status ||
            "-"
        )
        .join(" | ") ||
      "-";

    await env.DB.prepare(`
      UPDATE pnrs
      SET
        last_status = ?,
        train_number = ?,
        train_name = ?,
        journey_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
      AND pnr = ?
    `)
      .bind(
        statusText,
        train.number || "",
        train.name || "",
        journey.dateOfJourney ||
          "",
        chatId,
        pnr
      )
      .run();

  } catch (error) {

    console.error(
      "RailKit PNR error:",
      error
    );

    await sendTelegram(
      env,
      chatId,

      `❌ PNR check failed.\n\n` +
        `Please try again later.\n\n` +
        `Error: ${
          error.message ||
          "Unknown error"
        }`
    );
  }
}
/* =========================
   TRAIN STATUS
========================= */

async function getTrainStatus(
  env,
  trainNumber
) {
  configure(
    env.RAILKIT_API_KEY
  );

  const journeyDate =
    getIndiaDate();

  const result =
    await trackTrain(
      trainNumber,
      journeyDate
    );

  if (!result?.success) {
    throw new Error(
      result?.error ||
        "Train status unavailable"
    );
  }

  return result.data || {};
}


async function handleTrain(
  env,
  chatId,
  trainNumber
) {
  if (
    !isValidTrainNumber(
      trainNumber
    )
  ) {
    await sendTelegram(
      env,
      chatId,

      `❌ Invalid train number.\n\n` +
        `Train number must contain exactly 5 digits.\n\n` +
        `Example:\n` +
        `/train 12522`
    );

    return;
  }

  await sendTelegram(
    env,
    chatId,

    `🔎 Checking live status of train ${trainNumber}...`
  );

  try {
    const data =
      await getTrainStatus(
        env,
        trainNumber
      );

    const trainNo =
      data.trainNo ||
      trainNumber;

    const trainName =
      data.trainName ||
      "Unknown Train";

    const statusNote =
      data.statusNote ||
      "Status unavailable";

    const lastUpdate =
      data.lastUpdate ||
      "-";

    const currentStationCode =
      data.currentStationCode ||
      "-";

    const timeline =
      Array.isArray(
        data.timeline
      )
        ? data.timeline
        : [];

    const currentIndex =
      timeline.findIndex(
        (station) =>
          station?.status ===
          "current"
      );

    const currentStation =
      currentIndex >= 0
        ? timeline[
            currentIndex
          ]
        : null;

    const nextStation =
      currentIndex >= 0
        ? timeline
            .slice(
              currentIndex + 1
            )
            .find(
              (station) =>
                station?.status ===
                "upcoming"
            )
        : timeline.find(
            (station) =>
              station?.status ===
              "upcoming"
          );

    let message =
      `🚆 LIVE TRAIN STATUS\n\n` +

      `Train: ${trainNo} ${trainName}\n\n` +

      `📍 Status: ${statusNote}\n` +

      `📌 Current Station: ${
        currentStation?.stationName ||
        currentStationCode ||
        "-"
      }\n` +

      `🔢 Station Code: ${
        currentStation?.stationCode ||
        currentStationCode ||
        "-"
      }\n`;

    if (nextStation) {
      message +=
        `➡️ Next Station: ${
          nextStation.stationName ||
          "-"
        }`;

      if (
        nextStation.stationCode
      ) {
        message +=
          ` (${nextStation.stationCode})`;
      }

      message += "\n";
    }

    message +=
      `\n🕐 Last Update: ${lastUpdate}`;

    await sendTelegram(
      env,
      chatId,
      message
    );

  } catch (error) {

    console.error(
      "RailKit Train error:",
      error
    );

    await sendTelegram(
      env,
      chatId,

      `❌ Train status check failed.\n\n` +
        `Train: ${trainNumber}\n\n` +
        `Error: ${
          error.message ||
          "Unknown error"
        }`
    );
  }
}


/* =========================
   ALERT - START
========================= */

async function handleAlert(
  env,
  chatId,
  trainNumber
) {
  if (
    !isValidTrainNumber(
      trainNumber
    )
  ) {
    await sendTelegram(
      env,
      chatId,

      `❌ Invalid train number.\n\n` +
        `Example:\n` +
        `/alert 12522`
    );

    return;
  }

  const existing =
    await env.DB.prepare(`
      SELECT id
      FROM train_alerts
      WHERE telegram_id = ?
      AND train_number = ?
      AND alert_sent = 0
      LIMIT 1
    `)
      .bind(
        chatId,
        trainNumber
      )
      .first();

  if (existing) {
    await sendTelegram(
      env,
      chatId,

      `⚠️ You already have an active alert for train ${trainNumber}.\n\n` +
        `Send /cancelalert if you want to cancel it.`
    );

    return;
  }

  await env.DB.prepare(`
    INSERT INTO train_alerts (
      telegram_id,
      train_number,
      destination,
      alert_minutes,
      alert_sent
    )
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(
      chatId,
      trainNumber,
      "PENDING",
      15,
      0
    )
    .run();

  await sendTelegram(
    env,
    chatId,

    `🚆 Train ${trainNumber} selected.\n\n` +
      `📍 Now send your destination station.\n\n` +
      `Example:\n` +
      `Kanpur Central\n\n` +
      `You can also send the station code:\n` +
      `CNB`
  );
}


/* =========================
   ALERT DESTINATION
========================= */

async function handleDestination(
  env,
  chatId,
  destination
) {
  const pending =
    await env.DB.prepare(`
      SELECT
        id,
        train_number
      FROM train_alerts
      WHERE telegram_id = ?
      AND destination = 'PENDING'
      AND alert_sent = 0
      ORDER BY id DESC
      LIMIT 1
    `)
      .bind(chatId)
      .first();

  if (!pending) {
    return false;
  }

  const cleanDestination =
    destination.trim();

  if (
    !cleanDestination ||
    cleanDestination.length < 2
  ) {
    await sendTelegram(
      env,
      chatId,

      "❌ Please send a valid destination station name or station code."
    );

    return true;
  }

  await sendTelegram(
    env,
    chatId,

    `🔎 Checking destination "${cleanDestination}" on train ${pending.train_number}...`
  );

  try {
    const data =
      await getTrainStatus(
        env,
        pending.train_number
      );

    const timeline =
      Array.isArray(
        data.timeline
      )
        ? data.timeline
        : [];

    const searchText =
      cleanDestination
        .toLowerCase();

    const station =
      timeline.find(
        (item) => {

          const name =
            String(
              item?.stationName ||
              ""
            ).toLowerCase();

          const code =
            String(
              item?.stationCode ||
              ""
            ).toLowerCase();

          return (
            name === searchText ||
            code === searchText
          );
        }
      );

    if (!station) {

      await sendTelegram(
        env,
        chatId,

        `❌ Destination "${cleanDestination}" was not found in train ${pending.train_number}'s route.\n\n` +
          `Please send the exact station name or station code.`
      );

      return true;
    }

    await env.DB.prepare(`
      UPDATE train_alerts
      SET destination = ?
      WHERE id = ?
    `)
      .bind(
        station.stationCode ||
          station.stationName,
        pending.id
      )
      .run();

    await sendTelegram(
      env,
      chatId,

      `✅ Alert set successfully!\n\n` +

        `🚆 Train: ${pending.train_number}\n` +

        `📍 Destination: ${
          station.stationName ||
          station.stationCode
        }\n` +

        `🔔 Alert: 15 minutes before arrival\n\n` +

        `I'll notify you when the train is approximately 15 minutes away from your destination.`
    );

  } catch (error) {

    console.error(
      "Alert destination error:",
      error
    );

    await sendTelegram(
      env,
      chatId,

      `❌ Couldn't verify the destination right now.\n\n` +

        `Please try again later.\n\n` +

        `Error: ${
          error.message ||
          "Unknown error"
        }`
    );
  }

  return true;
}


/* =========================
   CANCEL ALERT
========================= */

async function handleCancelAlert(
  env,
  chatId
) {
  const result =
    await env.DB.prepare(`
      DELETE FROM train_alerts
      WHERE telegram_id = ?
      AND alert_sent = 0
    `)
      .bind(chatId)
      .run();

  if (
    result.meta.changes === 0
  ) {
    await sendTelegram(
      env,
      chatId,

      "📭 You don't have any active train alert."
    );

    return;
  }

  await sendTelegram(
    env,
    chatId,

    "❌ Train alert cancelled successfully."
  );
}


/* =========================
   MY ALERTS UI
========================= */

async function showAlertsMenu(
  env,
  chatId,
  messageId
) {
  const result =
    await env.DB.prepare(`
      SELECT
        train_number,
        destination,
        alert_minutes
      FROM train_alerts
      WHERE telegram_id = ?
      AND alert_sent = 0
      AND destination != 'PENDING'
      ORDER BY id DESC
    `)
      .bind(chatId)
      .all();

  let text =
    `🔔 MY ALERTS\n\n`;

  if (
    !result.results ||
    result.results.length === 0
  ) {

    text +=
      `📭 You don't have any active train alerts.\n\n` +
      `Use /alert 12522 to create one.`;

    await editTelegramMessage(
      env,
      chatId,
      messageId,
      text,
      backButton()
    );

    return;
  }

  text +=
    `You have ${result.results.length} active alert(s):\n\n`;

  for (
    const alert of result.results
  ) {
    text +=
      `🚆 Train: ${alert.train_number}\n` +
      `📍 Destination: ${alert.destination}\n` +
      `🔔 Alert: ${alert.alert_minutes} minutes before arrival\n\n`;
  }

  text +=
    `Use the button below to cancel active alerts.`;

  await editTelegramMessage(
    env,
    chatId,
    messageId,
    text,

    {
      inline_keyboard: [

        [
          {
            text: "❌ Cancel Alerts",
            callback_data:
              "cancel_alerts",
          },
        ],

        [
          {
            text: "⬅️ Back",
            callback_data:
              "main_menu",
          },
        ],

      ],
    }
  );
}


/* =========================
   ALERT CHECKER
========================= */

async function checkTrainAlerts(
  env
) {
  const result =
    await env.DB.prepare(`
      SELECT
        id,
        telegram_id,
        train_number,
        destination,
        alert_minutes
      FROM train_alerts
      WHERE alert_sent = 0
      AND destination != 'PENDING'
    `)
      .all();

  if (
    !result.results ||
    result.results.length === 0
  ) {
    console.log(
      "No active train alerts."
    );

    return;
  }

  for (
    const alert of result.results
  ) {

    try {

      const data =
        await getTrainStatus(
          env,
          alert.train_number
        );

      const timeline =
        Array.isArray(
          data.timeline
        )
          ? data.timeline
          : [];

      const destinationText =
        String(
          alert.destination
        ).toLowerCase();

      const destination =
        timeline.find(
          (station) => {

            const code =
              String(
                station?.stationCode ||
                ""
              ).toLowerCase();

            const name =
              String(
                station?.stationName ||
                ""
              ).toLowerCase();

            return (
              code ===
                destinationText ||
              name ===
                destinationText
            );
          }
        );

      if (!destination) {

        console.log(
          "Destination not found:",
          alert.destination
        );

        continue;
      }


      /* =========================
         TRAIN PASSED DESTINATION
      ========================= */

      if (
        destination.status ===
        "passed"
      ) {

        await env.DB.prepare(`
          UPDATE train_alerts
          SET alert_sent = 1
          WHERE id = ?
        `)
          .bind(
            alert.id
          )
          .run();

        continue;
      }


      /* =========================
         TRAIN AT DESTINATION
      ========================= */

      if (
        destination.status ===
        "current"
      ) {

        await env.DB.prepare(`
          UPDATE train_alerts
          SET alert_sent = 1
          WHERE id = ?
        `)
          .bind(
            alert.id
          )
          .run();

        await sendTelegram(
          env,
          alert.telegram_id,

          `🚆 ARRIVAL UPDATE\n\n` +

            `Your train ${alert.train_number} has reached ${destination.stationName || destination.stationCode}.\n\n` +

            `📍 Destination: ${
              destination.stationName ||
              destination.stationCode
            }`
        );

        continue;
      }


      /* =========================
         ONLY UPCOMING STATIONS
      ========================= */

      if (
        destination.status !==
        "upcoming"
      ) {
        continue;
      }


      const arrival =
        destination.arrival ||
        {};


      let arrivalMinutes =
        parseTimeToMinutes(
          arrival.actual
        );


      if (
        arrivalMinutes === null
      ) {
        arrivalMinutes =
          parseTimeToMinutes(
            arrival.scheduled
          );
      }


      if (
        arrivalMinutes === null
      ) {

        console.log(
          "No arrival time for:",
          destination.stationName
        );

        continue;
      }


      /* =========================
         ADD DELAY
      ========================= */

      const delayMinutes =
        parseDelayMinutes(
          arrival.delay
        );

      arrivalMinutes +=
        delayMinutes;


      const nowMinutes =
        getCurrentIndiaMinutes();


      let minutesUntil =
        arrivalMinutes -
        nowMinutes;


      /* =========================
         MIDNIGHT CROSSING
      ========================= */

      if (
        minutesUntil < -720
      ) {
        minutesUntil +=
          24 * 60;
      }


      console.log(
        "Alert check:",
        alert.train_number,
        destination.stationName,
        "minutes:",
        minutesUntil
      );


      /* =========================
         SEND ALERT
      ========================= */

      if (
        minutesUntil <=
          alert.alert_minutes &&
        minutesUntil >= 0
      ) {

        await sendTelegram(
          env,
          alert.telegram_id,

          `🔔 TRAIN ARRIVAL ALERT\n\n` +

            `🚆 Train: ${alert.train_number}\n` +

            `📍 Destination: ${
              destination.stationName ||
              destination.stationCode
            }\n\n` +

            `⏰ Your train is expected to reach your destination in approximately ${Math.max(
              0,
              Math.round(
                minutesUntil
              )
            )} minutes.\n\n` +

            `Please get ready to get down. 🚉`
        );


        await env.DB.prepare(`
          UPDATE train_alerts
          SET alert_sent = 1
          WHERE id = ?
        `)
          .bind(
            alert.id
          )
          .run();


        console.log(
          "Alert sent:",
          alert.id
        );
      }

    } catch (error) {

      console.error(
        "Train alert error:",
        alert.id,
        error
      );
    }
  }
}


/* =========================
   CALLBACK QUERY HANDLER
========================= */

async function handleCallbackQuery(
  callbackQuery,
  env
) {
  const data =
    callbackQuery?.data ||
    "";

  const message =
    callbackQuery?.message;

  if (!message?.chat) {
    return;
  }

  const chatId =
    String(
      message.chat.id
    );

  const messageId =
    message.message_id;

  const username =
    callbackQuery?.from
      ?.username || "";


  await saveUser(
    env,
    chatId,
    username
  );


  await answerCallbackQuery(
    env,
    callbackQuery.id
  );


  switch (data) {

    /* =========================
       MAIN MENU
    ========================= */

    case "main_menu":

      searchSessions.delete(
        String(chatId)
      );

      await showMainMenu(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       PNR MENU
    ========================= */

    case "pnr_menu":

      await showPNRMenu(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       ADD PNR
    ========================= */

    case "pnr_add":

      await editTelegramMessage(
        env,
        chatId,
        messageId,

        `➕ ADD PNR\n\n` +
          `Send your 10-digit PNR using:\n\n` +
          `/add 1234567890`,

        backButton()
      );

      break;


    /* =========================
       CHECK PNR
    ========================= */

    case "pnr_check":

      await editTelegramMessage(
        env,
        chatId,
        messageId,

        `🔎 CHECK PNR\n\n` +
          `Send your PNR using:\n\n` +
          `/check 1234567890`,

        backButton()
      );

      break;


    /* =========================
       REMOVE PNR
    ========================= */

    case "pnr_remove":

      await editTelegramMessage(
        env,
        chatId,
        messageId,

        `🗑️ REMOVE PNR\n\n` +
          `Send the PNR you want to remove:\n\n` +
          `/remove 1234567890`,

        backButton()
      );

      break;


    /* =========================
       MY PNR
    ========================= */

    case "pnr_list":

      await showPNRListUI(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       TRAIN MENU
    ========================= */

    case "train_menu":

      await showTrainMenu(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       LIVE TRAIN
    ========================= */

    case "train_live":

      await editTelegramMessage(
        env,
        chatId,
        messageId,

        `📍 LIVE TRAIN STATUS\n\n` +
          `Send the 5-digit train number:\n\n` +
          `/train 12522`,

        backButton()
      );

      break;


    /* =========================
       ALERTS
    ========================= */

    case "alerts_menu":

      await showAlertsMenu(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       CANCEL ALERTS
    ========================= */

    case "cancel_alerts":

      await handleCancelAlert(
        env,
        chatId
      );


      await showAlertsMenu(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       HELP
    ========================= */

    case "help_menu":

      await showHelpMenu(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       SEARCH TRAINS
    ========================= */

    case "search_menu":

      await startTrainSearch(
        env,
        chatId,
        messageId
      );

      break;


    /* =========================
       FUTURE FEATURES
    ========================= */

    case "availability_menu":

      await showComingSoon(
        env,
        chatId,
        messageId,
        "💺 AVAILABILITY"
      );

      break;


    case "fare_menu":

      await showComingSoon(
        env,
        chatId,
        messageId,
        "💰 FARE ENQUIRY"
      );

      break;


    case "station_menu":

      await showComingSoon(
        env,
        chatId,
        messageId,
        "🚉 STATION INFO"
      );

      break;


    default:

      await showMainMenu(
        env,
        chatId,
        messageId
      );
  }
}
/* ========================= START ========================= */

async function handleStart(env, chatId, messageId = null) {
  const count = await getUserCount(env);

  const text =
    `🚆 *Railway Assistant*\n\n` +
    `Welcome! 👋\n` +
    `Your smart Railway assistant is ready.\n\n` +
    `📊 Active users: *${count}*\n\n` +
    `Choose an option below:`;

  const markup = {
    inline_keyboard: [
      [
        { text: "🎫 PNR Status", callback_data: "pnr_menu" },
        { text: "🚂 Train Status", callback_data: "train_menu" }
      ],
      [
        { text: "🔍 Search Trains", callback_data: "search_menu" },
        { text: "💺 Availability", callback_data: "availability_menu" }
      ],
      [
        { text: "💰 Fare Enquiry", callback_data: "fare_menu" },
        { text: "🚉 Station Info", callback_data: "station_menu" }
      ],
      [
        { text: "🔔 My Alerts", callback_data: "alerts_menu" },
        { text: "📋 My PNRs", callback_data: "pnr_list" }
      ],
      [
        { text: "ℹ️ Help", callback_data: "help_menu" }
      ]
    ]
  };

  if (messageId) {
    await editTelegramMessage(
      env,
      chatId,
      messageId,
      text,
      markup
    );
  } else {
    await sendTelegram(
      env,
      chatId,
      text,
      markup
    );
  }
}


/* ========================= UPDATE HANDLER ========================= */

async function handleUpdate(env, update) {
  if (!update) return;

  /*
   * =========================
   * CALLBACK QUERY
   * =========================
   */

  if (update.callback_query) {
    const callback = update.callback_query;

    const chatId =
      callback.message?.chat?.id ??
      callback.from?.id;

    const messageId =
      callback.message?.message_id;

    const data = callback.data || "";

    if (!chatId) return;

    await answerCallbackQuery(
      env,
      callback.id
    );

    await saveUser(
      env,
      chatId,
      callback.from?.username || "",
      callback.from?.first_name || ""
    );

    await handleCallbackQuery(
      env,
      chatId,
      messageId,
      data
    );

    return;
  }


  /*
   * =========================
   * NORMAL MESSAGE
   * =========================
   */

  const message = update.message;

  if (!message) return;

  const chatId = message.chat?.id;

  if (!chatId) return;

  const text = (message.text || "").trim();

  await saveUser(
    env,
    chatId,
    message.from?.username || "",
    message.from?.first_name || ""
  );


  /*
   * =========================
   * SEARCH TRAIN INPUT
   * =========================
   *
   * IMPORTANT:
   * Search session ko command handling
   * se pehle check karna hai.
   */

  if (text && !text.startsWith("/")) {
    const handled = await processTrainSearchInput(
      env,
      chatId,
      text
    );

    if (handled) {
      return;
    }
  }


  /*
   * =========================
   * COMMANDS
   * =========================
   */

  if (text.startsWith("/start")) {
    await handleStart(
      env,
      chatId
    );
    return;
  }


  if (text.startsWith("/add")) {
    const pnr = text
      .replace(/^\/add/i, "")
      .trim();

    if (!pnr) {
      await sendTelegram(
        env,
        chatId,
        "❌ Please provide a valid PNR.\n\nExample:\n`/add 1234567890`"
      );
      return;
    }

    await addPNR(
      env,
      chatId,
      pnr
    );

    return;
  }


  if (text.startsWith("/check")) {
    await checkSavedPNRs(
      env,
      chatId
    );

    return;
  }


  if (text.startsWith("/train")) {
    const trainNumber = text
      .replace(/^\/train/i, "")
      .trim();

    if (!trainNumber) {
      await sendTelegram(
        env,
        chatId,
        "❌ Please provide a train number.\n\nExample:\n`/train 12301`"
      );
      return;
    }

    await showTrainStatus(
      env,
      chatId,
      trainNumber
    );

    return;
  }


  if (text.startsWith("/alert")) {
    await handleAlertCommand(
      env,
      chatId,
      text
    );

    return;
  }


  if (text.startsWith("/cancelalert")) {
    await cancelAlerts(
      env,
      chatId
    );

    return;
  }


  if (text.startsWith("/list")) {
    await listPNRs(
      env,
      chatId
    );

    return;
  }


  if (text.startsWith("/remove")) {
    const pnr = text
      .replace(/^\/remove/i, "")
      .trim();

    if (!pnr) {
      await sendTelegram(
        env,
        chatId,
        "❌ Please provide the PNR to remove.\n\nExample:\n`/remove 1234567890`"
      );
      return;
    }

    await removePNR(
      env,
      chatId,
      pnr
    );

    return;
  }


  /*
   * =========================
   * ALERT DESTINATION INPUT
   * =========================
   */

  if (text) {
    const handledDestination =
      await handleDestination(
        env,
        chatId,
        text
      );

    if (handledDestination) {
      return;
    }
  }


  /*
   * =========================
   * DEFAULT
   * =========================
   */

  await sendTelegram(
    env,
    chatId,
    "Use the menu below to continue 👇",
    {
      inline_keyboard: [
        [
          {
            text: "🏠 Main Menu",
            callback_data: "main_menu"
          }
        ]
      ]
    }
  );
}


/* ========================= WORKER ========================= */

export default {

  async fetch(request, env) {
    try {

      /*
       * =========================
       * TELEGRAM WEBHOOK
       * =========================
       */

      if (request.method !== "POST") {
        return new Response(
          "Railway Assistant is running 🚆",
          {
            status: 200
          }
        );
      }

      const update = await request.json();

      await handleUpdate(
        env,
        update
      );

      return new Response(
        "OK",
        {
          status: 200
        }
      );

    } catch (error) {

      console.error(
        "Webhook error:",
        error
      );

      return new Response(
        "Internal Server Error",
        {
          status: 500
        }
      );
    }
  },


  /*
   * =========================
   * CRON
   * =========================
   */

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runAlertCron(env)
    );

  }

};
