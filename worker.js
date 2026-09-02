import {
  configure,
  checkPNRStatus,
  trackTrain,
  searchTrainBetweenStations,
  stationsByName,
} from "railkit";

/* =========================================================
   INDIA DATE / TIME HELPERS
   ========================================================= */

function getIndiaNow() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
    })
  );
}

function getIndiaDate() {
  const now = getIndiaNow();

  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();

  return `${day}-${month}-${year}`;
}

/* =========================================================
   SEARCH TRAIN SESSION
   ========================================================= */

const searchSessions = new Map();

/* =========================================================
   STATION CODE VALIDATION
   ========================================================= */

function isValidStationCode(code) {
  return /^[A-Z]{2,5}$/.test(
    String(code || "").trim().toUpperCase()
  );
}

/* =========================================================
   DATE VALIDATION
   ========================================================= */

function isValidJourneyDate(dateText) {
  const text = String(dateText || "").trim();

  if (!/^\d{2}-\d{2}-\d{4}$/.test(text)) {
    return false;
  }

  const parts = text.split("-");

  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const year = Number(parts[2]);

  const date = new Date(
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

/* =========================================================
   SEARCH TRAIN KEYBOARD
   ========================================================= */

function searchTrainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "❌ Cancel",
          callback_data: "main_menu",
        },
      ],
    ],
  };
}

/* =========================================================
   START TRAIN SEARCH
   ========================================================= */

async function startTrainSearch(env, chatId, messageId) {
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
    `🔍 SEARCH TRAINS

Find trains between two railway stations.

📍 Step 1 of 3

Send the FROM station code.

Example:
NDLS

Delhi → NDLS`,
    searchTrainKeyboard()
  );
}

/* =========================================================
   EXTRACT TRAINS FROM RAILKIT RESPONSE
   ========================================================= */

function extractTrainList(result) {
  /*
   RailKit response can vary depending on the
   API response wrapper.

   We safely check all expected locations.
  */

  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result?.data)) {
    return result.data;
  }

  if (Array.isArray(result?.data?.trains)) {
    return result.data.trains;
  }

  if (Array.isArray(result?.trains)) {
    return result.trains;
  }

  if (Array.isArray(result?.data?.data)) {
    return result.data.data;
  }

  return [];
}

/* =========================================================
   TRAIN FIELD HELPERS
   ========================================================= */

function getTrainNumber(train) {
  return (
    train?.train_no ??
    train?.trainNumber ??
    train?.train_number ??
    train?.number ??
    train?.trainCode ??
    "-"
  );
}

function getTrainName(train) {
  return (
    train?.train_name ??
    train?.trainName ??
    train?.name ??
    "Unknown Train"
  );
}

function getFromTime(train) {
  return (
    train?.from_time ??
    train?.fromTime ??
    train?.departureTime ??
    train?.departure_time ??
    train?.startTime ??
    "-"
  );
}

function getToTime(train) {
  return (
    train?.to_time ??
    train?.toTime ??
    train?.arrivalTime ??
    train?.arrival_time ??
    train?.endTime ??
    "-"
  );
}

function getTravelTime(train) {
  return (
    train?.travel_time ??
    train?.travelTime ??
    train?.duration ??
    train?.journeyTime ??
    "-"
  );
}

/* =========================================================
   PROCESS TRAIN SEARCH INPUT
   ========================================================= */

async function processTrainSearchInput(
  env,
  chatId,
  text
) {
  const session = searchSessions.get(
    String(chatId)
  );

  if (!session) {
    return false;
  }

  const cleanText = String(text || "").trim();

  if (!cleanText) {
    return true;
  }

  /* -------------------------------------------------------
     STEP 1 - FROM
     ------------------------------------------------------- */

  if (session.step === "from") {
    const from = cleanText.toUpperCase();

    if (!isValidStationCode(from)) {
      await sendTelegram(
        env,
        chatId,
        `❌ Invalid station code.

Please send a valid railway station code.

Example:
NDLS`
      );

      return true;
    }

    session.from = from;
    session.step = "to";

    searchSessions.set(
      String(chatId),
      session
    );

    await sendTelegram(
      env,
      chatId,
      `📍 FROM: ${from}

📍 Step 2 of 3

Now send the TO station code.

Example:
BCT`
    );

    return true;
  }

  /* -------------------------------------------------------
     STEP 2 - TO
     ------------------------------------------------------- */

  if (session.step === "to") {
    const to = cleanText.toUpperCase();

    if (!isValidStationCode(to)) {
      await sendTelegram(
        env,
        chatId,
        `❌ Invalid station code.

Please send a valid railway station code.

Example:
BCT`
      );

      return true;
    }

    if (to === session.from) {
      await sendTelegram(
        env,
        chatId,
        `❌ FROM and TO stations cannot be the same.

Please send a different destination station code.`
      );

      return true;
    }

    session.to = to;
    session.step = "date";

    searchSessions.set(
      String(chatId),
      session
    );

    await sendTelegram(
      env,
      chatId,
      `📍 FROM: ${session.from}
📍 TO: ${session.to}

📅 Step 3 of 3

Send journey date in this format:

DD-MM-YYYY

Example:
15-09-2026`
    );

    return true;
  }

  /* -------------------------------------------------------
     STEP 3 - DATE
     ------------------------------------------------------- */

  if (session.step === "date") {
    const date = cleanText;

    if (!isValidJourneyDate(date)) {
      await sendTelegram(
        env,
        chatId,
        `❌ Invalid date.

Please use DD-MM-YYYY format.

Example:
15-09-2026`
      );

      return true;
    }

    session.date = date;

    /*
     IMPORTANT:
     Keep the session until the API request finishes.
     This makes error handling safer.
    */

    await sendTelegram(
      env,
      chatId,
      `🔎 Searching trains...

📍 ${session.from} → ${session.to}
📅 ${session.date}`
    );

    try {
      /* ---------------------------------------------------
         CONFIGURE RAILKIT
         --------------------------------------------------- */

      configure(
        env.RAILKIT_API_KEY
      );

      /* ---------------------------------------------------
         CALL RAILKIT
         --------------------------------------------------- */

      const result =
        await searchTrainBetweenStations(
          session.from,
          session.to,
          session.date
        );

      /*
       DEBUG LOG

       This is intentionally kept so if RailKit changes
       its response structure, we can see the actual API
       response in Cloudflare logs.
      */

      console.log(
        "TRAIN SEARCH RAW RESPONSE:",
        JSON.stringify(result)
      );

      /* ---------------------------------------------------
         HANDLE RAILKIT ERROR RESPONSE
         --------------------------------------------------- */

      if (
        result &&
        typeof result === "object" &&
        result.success === false
      ) {
        const apiMessage =
          result.message ||
          result.error ||
          result.errorMessage ||
          "RailKit returned an unsuccessful response.";

        console.error(
          "TRAIN SEARCH API ERROR:",
          JSON.stringify(result)
        );

        await sendTelegram(
          env,
          chatId,
          `❌ TRAIN SEARCH FAILED

📍 ${session.from} → ${session.to}
📅 ${session.date}

RailKit Error:
${apiMessage}`
        );

        searchSessions.delete(
          String(chatId)
        );

        return true;
      }

      /* ---------------------------------------------------
         EXTRACT TRAIN LIST
         --------------------------------------------------- */

      const trains =
        extractTrainList(result);

      /* ---------------------------------------------------
         NO TRAINS
         --------------------------------------------------- */

      if (trains.length === 0) {
        console.warn(
          "NO TRAINS EXTRACTED:",
          JSON.stringify(result)
        );

        await sendTelegram(
          env,
          chatId,
          `🚆 NO TRAINS FOUND

📍 ${session.from} → ${session.to}
📅 ${session.date}

No trains were found for this search.

Please check:
• Station codes
• Journey date
• Direct train availability`
        );

        searchSessions.delete(
          String(chatId)
        );

        return true;
      }

      /* ---------------------------------------------------
         BUILD RESULT MESSAGE
         --------------------------------------------------- */

      let message =
        `🚆 TRAINS FOUND\n\n` +
        `📍 ${session.from} → ${session.to}\n` +
        `📅 ${session.date}\n\n`;

      const limitedTrains =
        trains.slice(0, 10);

      limitedTrains.forEach(
        (train, index) => {
          const trainNo =
            getTrainNumber(train);

          const trainName =
            getTrainName(train);

          const fromTime =
            getFromTime(train);

          const toTime =
            getToTime(train);

          const travelTime =
            getTravelTime(train);

          message +=
            `${index + 1}. 🚂 ${trainNo} ${trainName}\n` +
            `   🕐 ${fromTime} → ${toTime}\n` +
            `   ⏱️ ${travelTime}\n\n`;
        }
      );

      if (trains.length > 10) {
        message +=
          `Showing first 10 of ${trains.length} trains.`;
      }

      /* ---------------------------------------------------
         SEND RESULTS
         --------------------------------------------------- */

      await sendTelegram(
        env,
        chatId,
        message
      );

      /* ---------------------------------------------------
         CLEAR SESSION
         --------------------------------------------------- */

      searchSessions.delete(
        String(chatId)
      );

    } catch (error) {
      console.error(
        "RailKit Search Train error:",
        error
      );

      await sendTelegram(
        env,
        chatId,
        `❌ TRAIN SEARCH FAILED

📍 ${session.from} → ${session.to}
📅 ${session.date}

Please try again later.

Error:
${error?.message || "Unknown error"}`
      );

      searchSessions.delete(
        String(chatId)
      );
    }

    return true;
  }

  return true;
}
/* =========================================================
   MAIN MENU KEYBOARD
   ========================================================= */

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "🎫 PNR Status",
          callback_data: "pnr_status",
        },
        {
          text: "🚂 Train Status",
          callback_data: "train_status",
        },
      ],
      [
        {
          text: "🔍 Search Trains",
          callback_data: "search_menu",
        },
        {
          text: "💺 Availability",
          callback_data: "availability",
        },
      ],
      [
        {
          text: "💰 Fare Enquiry",
          callback_data: "fare_enquiry",
        },
        {
          text: "🚉 Station Info",
          callback_data: "station_info",
        },
      ],
      [
        {
          text: "🔔 My Alerts",
          callback_data: "my_alerts",
        },
        {
          text: "📋 My PNRs",
          callback_data: "my_pnrs",
        },
      ],
      [
        {
          text: "ℹ️ Help",
          callback_data: "help",
        },
      ],
    ],
  };
}

/* =========================================================
   BACK BUTTON
   ========================================================= */

function backToMainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "⬅️ Back to Main Menu",
          callback_data: "main_menu",
        },
      ],
    ],
  };
}

/* =========================================================
   SHOW MAIN MENU
   ========================================================= */

async function showMainMenu(
  env,
  chatId,
  messageId = null,
  username = ""
) {
  let userCount = 0;

  try {
    userCount = await getUserCount(env);
  } catch (error) {
    console.error(
      "User count error:",
      error
    );
  }

  const message =
    `🚆 *RAILWAY ASSISTANT*\n\n` +
    `Welcome${username ? `, ${username}` : ""}! 👋\n\n` +
    `Your smart Indian Railways assistant.\n\n` +
    `Choose an option below 👇\n\n` +
    `👥 Active Users: *${userCount}*`;

  if (messageId) {
    await editTelegramMessage(
      env,
      chatId,
      messageId,
      message,
      mainMenuKeyboard()
    );
  } else {
    await sendTelegram(
      env,
      chatId,
      message,
      mainMenuKeyboard()
    );
  }
}

/* =========================================================
   PNR MENU
   ========================================================= */

async function showPNRMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `🎫 *PNR STATUS*

Check your railway PNR status instantly.

Please send your 10-digit PNR number.

Example:
1234567890`,
    backToMainKeyboard()
  );
}

/* =========================================================
   TRAIN STATUS MENU
   ========================================================= */

async function showTrainStatusMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `🚂 *TRAIN STATUS*

Track a running train in real time.

Please send the train number.

Example:
12301`,
    backToMainKeyboard()
  );
}

/* =========================================================
   AVAILABILITY MENU
   ========================================================= */

async function showAvailabilityMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `💺 *SEAT AVAILABILITY*

Check seat availability for a train.

This feature will let you enter:

🚂 Train Number
📍 From Station
📍 To Station
📅 Journey Date
💺 Class
🎟️ Quota`,
    backToMainKeyboard()
  );
}

/* =========================================================
   FARE MENU
   ========================================================= */

async function showFareMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `💰 *FARE ENQUIRY*

Check railway fare between two stations.

Required information:

🚂 Train Number
📍 From Station
📍 To Station
📅 Journey Date
💺 Travel Class
🎟️ Quota`,
    backToMainKeyboard()
  );
}

/* =========================================================
   STATION INFO MENU
   ========================================================= */

async function showStationInfoMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `🚉 *STATION INFO*

Get railway station information.

Send a station code or station name.

Examples:

NDLS

or

New Delhi`,
    backToMainKeyboard()
  );
}

/* =========================================================
   ALERTS MENU
   ========================================================= */

async function showAlertsMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `🔔 *MY ALERTS*

Your railway alerts will appear here.

Coming features:

• 🚂 Train running alerts
• 🎫 PNR status alerts
• 💺 Seat availability alerts
• 📅 Journey reminders`,
    backToMainKeyboard()
  );
}

/* =========================================================
   SAVED PNR MENU
   ========================================================= */

async function showMyPNRsMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `📋 *MY PNRS*

Your saved PNRs will appear here.

You will be able to:

• Save PNR
• Check PNR
• Remove PNR
• Get automatic status updates`,
    backToMainKeyboard()
  );
}

/* =========================================================
   HELP MENU
   ========================================================= */

async function showHelpMenu(
  env,
  chatId,
  messageId
) {
  await editTelegramMessage(
    env,
    chatId,
    messageId,
    `ℹ️ *RAILWAY ASSISTANT HELP*

Available services:

🎫 PNR Status
🚂 Train Status
🔍 Search Trains
💺 Seat Availability
💰 Fare Enquiry
🚉 Station Information
🔔 Railway Alerts
📋 Saved PNRs

You can also use slash commands
supported by the bot.

Need help?
Choose an option from the menu.`,
    backToMainKeyboard()
  );
}

/* =========================================================
   CALLBACK QUERY HANDLER
   ========================================================= */

async function handleCallbackQuery(
  callbackQuery,
  env
) {
  const callbackId =
    callbackQuery?.id;

  const chatId =
    callbackQuery?.message?.chat?.id;

  const messageId =
    callbackQuery?.message?.message_id;

  const data =
    callbackQuery?.data || "";

  if (!chatId || !messageId) {
    return;
  }

  /* -------------------------------------------------------
     ANSWER CALLBACK
     ------------------------------------------------------- */

  try {
    await answerCallbackQuery(
      env,
      callbackId
    );
  } catch (error) {
    console.error(
      "Callback answer error:",
      error
    );
  }

  /* -------------------------------------------------------
     MAIN MENU
     ------------------------------------------------------- */

  if (data === "main_menu") {
    searchSessions.delete(
      String(chatId)
    );

    await showMainMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     SEARCH TRAINS
     ------------------------------------------------------- */

  if (data === "search_menu") {
    await startTrainSearch(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     PNR STATUS
     ------------------------------------------------------- */

  if (data === "pnr_status") {
    await showPNRMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     TRAIN STATUS
     ------------------------------------------------------- */

  if (data === "train_status") {
    await showTrainStatusMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     AVAILABILITY
     ------------------------------------------------------- */

  if (data === "availability") {
    await showAvailabilityMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     FARE ENQUIRY
     ------------------------------------------------------- */

  if (data === "fare_enquiry") {
    await showFareMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     STATION INFO
     ------------------------------------------------------- */

  if (data === "station_info") {
    await showStationInfoMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     MY ALERTS
     ------------------------------------------------------- */

  if (data === "my_alerts") {
    await showAlertsMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     MY PNRS
     ------------------------------------------------------- */

  if (data === "my_pnrs") {
    await showMyPNRsMenu(
      env,
      chatId,
      messageId
    );

    return;
  }

  /* -------------------------------------------------------
     HELP
     ------------------------------------------------------- */

  if (data === "help") {
    await showHelpMenu(
      env,
      chatId,
      messageId
    );

    return;
  }
}
/* =========================================================
   UPDATE HANDLER
   ========================================================= */

async function handleUpdate(update, env) {
  if (!update) {
    return;
  }

  /* -------------------------------------------------------
     CALLBACK QUERY
     ------------------------------------------------------- */

  if (update.callback_query) {
    const callback =
      update.callback_query;

    await handleCallbackQuery(
      callback,
      env
    );

    return;
  }

  /* -------------------------------------------------------
     NORMAL MESSAGE
     ------------------------------------------------------- */

  if (update.message) {
    const message =
      update.message;

    const chatId =
      message?.chat?.id;

    const text =
      message?.text || "";

    const username =
      message?.from?.username ||
      message?.from?.first_name ||
      "";

    if (!chatId) {
      return;
    }

    /* ---------------------------------------------------
       SAVE USER
       --------------------------------------------------- */

    try {
      await saveUser(
        env,
        chatId,
        username
      );
    } catch (error) {
      console.error(
        "Save user error:",
        error
      );
    }

    /* ---------------------------------------------------
       SEARCH TRAIN SESSION
       --------------------------------------------------- */

    const searchHandled =
      await processTrainSearchInput(
        env,
        chatId,
        text
      );

    if (searchHandled) {
      return;
    }

    /* ---------------------------------------------------
       IGNORE EMPTY MESSAGE
       --------------------------------------------------- */

    if (!text.trim()) {
      return;
    }

    const cleanText =
      text.trim();

    /* ---------------------------------------------------
       /START
       --------------------------------------------------- */

    if (
      cleanText === "/start" ||
      cleanText.startsWith("/start ")
    ) {
      await showMainMenu(
        env,
        chatId,
        null,
        username
      );

      return;
    }

    /* ---------------------------------------------------
       /MENU
       --------------------------------------------------- */

    if (
      cleanText === "/menu" ||
      cleanText === "/help"
    ) {
      await showMainMenu(
        env,
        chatId,
        null,
        username
      );

      return;
    }

    /* ---------------------------------------------------
       /PNR
       --------------------------------------------------- */

    if (
      cleanText.toLowerCase() === "/pnr"
    ) {
      await sendTelegram(
        env,
        chatId,
        `🎫 PNR STATUS

Please send your 10-digit PNR number.

Example:
1234567890`
      );

      return;
    }

    /* ---------------------------------------------------
       DIRECT PNR NUMBER
       --------------------------------------------------- */

    if (/^\d{10}$/.test(cleanText)) {
      try {
        configure(
          env.RAILKIT_API_KEY
        );

        await sendTelegram(
          env,
          chatId,
          `🔎 Checking PNR...

🎫 ${cleanText}`
        );

        const result =
          await checkPNRStatus(
            cleanText
          );

        console.log(
          "PNR RAW RESPONSE:",
          JSON.stringify(result)
        );

        await sendTelegram(
          env,
          chatId,
          formatPNRResult(
            result,
            cleanText
          )
        );
      } catch (error) {
        console.error(
          "PNR error:",
          error
        );

        await sendTelegram(
          env,
          chatId,
          `❌ PNR CHECK FAILED

Please try again later.

Error:
${error?.message || "Unknown error"}`
        );
      }

      return;
    }

    /* ---------------------------------------------------
       /TRAIN
       --------------------------------------------------- */

    if (
      cleanText.toLowerCase() === "/train"
    ) {
      await sendTelegram(
        env,
        chatId,
        `🚂 TRAIN STATUS

Please send the train number.

Example:
12301`
      );

      return;
    }

    /* ---------------------------------------------------
       DIRECT TRAIN NUMBER
       --------------------------------------------------- */

    if (/^\d{4,6}$/.test(cleanText)) {
      try {
        configure(
          env.RAILKIT_API_KEY
        );

        await sendTelegram(
          env,
          chatId,
          `🔎 Checking train status...

🚂 ${cleanText}`
        );

        const result =
          await trackTrain(
            cleanText,
            getIndiaDate()
          );

        console.log(
          "TRAIN STATUS RAW RESPONSE:",
          JSON.stringify(result)
        );

        await sendTelegram(
          env,
          chatId,
          formatTrainStatusResult(
            result,
            cleanText
          )
        );
      } catch (error) {
        console.error(
          "Train status error:",
          error
        );

        await sendTelegram(
          env,
          chatId,
          `❌ TRAIN STATUS FAILED

Please try again later.

Error:
${error?.message || "Unknown error"}`
        );
      }

      return;
    }

    /* ---------------------------------------------------
       UNKNOWN MESSAGE
       --------------------------------------------------- */

    await sendTelegram(
      env,
      chatId,
      `🤖 I didn't understand that.

Use /start to open the Railway Assistant menu.`,
      mainMenuKeyboard()
    );
  }
}

/* =========================================================
   PNR RESULT FORMATTER
   ========================================================= */

function formatPNRResult(
  result,
  pnr
) {
  if (!result) {
    return `🎫 PNR STATUS

PNR: ${pnr}

❌ No response received from RailKit.`;
  }

  if (
    result.success === false
  ) {
    return `🎫 PNR STATUS

PNR: ${pnr}

❌ Unable to fetch PNR status.

${
  result.message ||
  result.error ||
  "Please try again later."
}`;
  }

  const data =
    result?.data ||
    result;

  /*
   Try common RailKit field names.
  */

  const trainNumber =
    data?.train_no ||
    data?.trainNumber ||
    data?.train_number ||
    "-";

  const trainName =
    data?.train_name ||
    data?.trainName ||
    "-";

  const chartStatus =
    data?.chart_status ||
    data?.chartStatus ||
    "-";

  const passengerStatus =
    data?.passengers ||
    data?.passengerStatus ||
    data?.bookingStatus ||
    null;

  let message =
    `🎫 PNR STATUS\n\n` +
    `PNR: ${pnr}\n\n` +
    `🚂 Train: ${trainNumber} ${trainName}\n` +
    `📋 Chart: ${chartStatus}`;

  if (passengerStatus) {
    message +=
      `\n\n💺 Passenger Status:\n${JSON.stringify(
        passengerStatus
      )}`;
  }

  return message;
}

/* =========================================================
   TRAIN STATUS RESULT FORMATTER
   ========================================================= */

function formatTrainStatusResult(
  result,
  trainNumber
) {
  if (!result) {
    return `🚂 TRAIN STATUS

Train: ${trainNumber}

❌ No response received from RailKit.`;
  }

  if (
    result.success === false
  ) {
    return `🚂 TRAIN STATUS

Train: ${trainNumber}

❌ Unable to fetch train status.

${
  result.message ||
  result.error ||
  "Please try again later."
}`;
  }

  const data =
    result?.data ||
    result;

  const trainName =
    data?.train_name ||
    data?.trainName ||
    data?.name ||
    "Unknown Train";

  const currentStation =
    data?.current_station ||
    data?.currentStation ||
    data?.station_name ||
    data?.stationName ||
    "-";

  const status =
    data?.status ||
    data?.current_status ||
    data?.currentStatus ||
    "-";

  const delay =
    data?.delay ||
    data?.delayMinutes ||
    data?.lateBy ||
    "-";

  return (
    `🚂 TRAIN STATUS\n\n` +
    `Train: ${trainNumber}\n` +
    `Name: ${trainName}\n\n` +
    `📍 Current Station: ${currentStation}\n` +
    `📊 Status: ${status}\n` +
    `⏱️ Delay: ${delay}`
  );
}

/* =========================================================
   CLOUDFLARE WORKER ENTRY
   ========================================================= */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    /* ---------------------------------------------------
       GET REQUEST
       --------------------------------------------------- */

    if (
      request.method === "GET"
    ) {
      return new Response(
        "🚆 Railway Assistant is running!",
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",
          },
        }
      );
    }

    /* ---------------------------------------------------
       ONLY POST
       --------------------------------------------------- */

    if (
      request.method !== "POST"
    ) {
      return new Response(
        "Method Not Allowed",
        {
          status: 405,
        }
      );
    }

    /* ---------------------------------------------------
       READ TELEGRAM UPDATE
       --------------------------------------------------- */

    let update;

    try {
      update =
        await request.json();
    } catch (error) {
      console.error(
        "Invalid JSON:",
        error
      );

      return new Response(
        "Invalid JSON",
        {
          status: 400,
        }
      );
    }

    /* ---------------------------------------------------
       PROCESS UPDATE
       --------------------------------------------------- */

    try {
      /*
       waitUntil keeps the webhook response fast while
       allowing the Worker to finish processing the update.
      */

      ctx.waitUntil(
        handleUpdate(
          update,
          env
        ).catch((error) => {
          console.error(
            "Update processing error:",
            error
          );
        })
      );

      return new Response(
        "OK",
        {
          status: 200,
        }
      );
    } catch (error) {
      console.error(
        "Worker error:",
        error
      );

      return new Response(
        "Internal Server Error",
        {
          status: 500,
        }
      );
    }
  },
};
