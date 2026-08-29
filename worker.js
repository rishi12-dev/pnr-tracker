import {
  configure,
  checkPNRStatus,
  trackTrain,
} from "railkit";


async function sendTelegram(env, chatId, text) {
  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: String(chatId),
      text: String(text),
    }),
  });

  const result = await response.text();

  console.log("Telegram response:", result);

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


function isValidPNR(pnr) {
  return /^\d{10}$/.test(pnr);
}


function isValidTrainNumber(trainNumber) {
  return /^\d{5}$/.test(trainNumber);
}


function getCommand(text) {
  const parts = text.trim().split(/\s+/);

  return {
    command: (parts[0] || "").toLowerCase(),
    argument: parts[1] || "",
  };
}


/* =========================
   INDIA DATE / TIME HELPERS
========================= */

function getIndiaNow() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
    })
  );
}


function getIndiaDate() {
  const now = getIndiaNow();

  const day = String(
    now.getDate()
  ).padStart(2, "0");

  const month = String(
    now.getMonth() + 1
  ).padStart(2, "0");

  const year = now.getFullYear();

  return `${day}-${month}-${year}`;
}


function parseTimeToMinutes(timeValue) {
  if (!timeValue) {
    return null;
  }

  const text = String(timeValue).trim();

  if (!text) {
    return null;
  }

  const match = text.match(
    /(\d{1,2}):(\d{2})/
  );

  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

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


function parseDelayMinutes(delayValue) {
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

  return Number(match[0]) || 0;
}


function getCurrentIndiaMinutes() {
  const now = getIndiaNow();

  return (
    now.getHours() * 60 +
    now.getMinutes() +
    now.getSeconds() / 60
  );
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
    INSERT INTO users (telegram_id, username)
    VALUES (?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET username = excluded.username
  `)
    .bind(
      chatId,
      username || ""
    )
    .run();
}


/* =========================
   START
========================= */

async function handleStart(
  env,
  chatId
) {
  await sendTelegram(
    env,
    chatId,
    `🚆 Welcome to PNR Tracker!

Commands:

/add 1234567890
➕ Add a PNR

/check 1234567890
🔎 Check live PNR status

/train 12522
🚂 Check live train status

/alert 12522
🔔 Get alert 15 minutes before destination

/list
📋 Show your saved PNRs

/remove 1234567890
🗑️ Remove a PNR

/cancelalert
❌ Cancel pending destination setup

You can add multiple PNRs and train alerts.`
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
      "❌ Invalid PNR.\n\nPNR must contain exactly 10 digits."
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
    `✅ PNR ${pnr} added successfully.

Now use:

/check ${pnr}

to check the live status.`
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

    let passengerText = "";

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
        journey.dateOfJourney || "",
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
      `❌ PNR check failed.

Please try again later.

Error: ${
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
      `❌ Invalid train number.

Train number must contain exactly 5 digits.

Example:
/train 12522`
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
        ? timeline[currentIndex]
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
      `❌ Train status check failed.

Train: ${trainNumber}

Error: ${
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
      `❌ Invalid train number.

Example:
/alert 12522`
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
      `⚠️ You already have an active alert for train ${trainNumber}.

Send /cancelalert if you want to cancel it.`
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
    `🚆 Train ${trainNumber} selected.

📍 Now send your destination station.

Example:
Kanpur Central

You can also send the station code:
CNB`
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
        `❌ Destination "${cleanDestination}" was not found in train ${pending.train_number}'s route.

Please send the exact station name or station code.`
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
      `✅ Alert set successfully!

🚆 Train: ${pending.train_number}
📍 Destination: ${
        station.stationName ||
        station.stationCode
      }
🔔 Alert: 15 minutes before arrival

I'll notify you when the train is approximately 15 minutes away from your destination.`
    );

  } catch (error) {
    console.error(
      "Alert destination error:",
      error
    );

    await sendTelegram(
      env,
      chatId,
      `❌ Couldn't verify the destination right now.

Please try again later.

Error: ${
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

      // If train has already passed destination,
      // do not send an old alert.
      if (
        destination.status ===
        "passed"
      ) {
        await env.DB.prepare(`
          UPDATE train_alerts
          SET alert_sent = 1
          WHERE id = ?
        `)
          .bind(alert.id)
          .run();

        continue;
      }

      // If destination is current,
      // alert window has already passed.
      if (
        destination.status ===
        "current"
      ) {
        await env.DB.prepare(`
          UPDATE train_alerts
          SET alert_sent = 1
          WHERE id = ?
        `)
          .bind(alert.id)
          .run();

        await sendTelegram(
          env,
          alert.telegram_id,
          `🚆 ARRIVAL UPDATE

Your train ${alert.train_number} has reached ${destination.stationName || destination.stationCode}.

📍 Destination: ${
            destination.stationName ||
            destination.stationCode
          }`
        );

        continue;
      }

      if (
        destination.status !==
        "upcoming"
      ) {
        continue;
      }

      const arrival =
        destination.arrival || {};

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

      // Add station delay if available.
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

      // Handle midnight crossing.
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

      if (
        minutesUntil <=
          alert.alert_minutes &&
        minutesUntil >= 0
      ) {
        await sendTelegram(
          env,
          alert.telegram_id,
          `🔔 TRAIN ARRIVAL ALERT

🚆 Train: ${alert.train_number}
📍 Destination: ${
            destination.stationName ||
            destination.stationCode
          }

⏰ Your train is expected to reach your destination in approximately ${Math.max(
            0,
            Math.round(minutesUntil)
          )} minutes.

Please get ready to get down. 🚉`
        );

        await env.DB.prepare(`
          UPDATE train_alerts
          SET alert_sent = 1
          WHERE id = ?
        `)
          .bind(alert.id)
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
   MESSAGE HANDLER
========================= */

async function handleUpdate(
  update,
  env
) {
  const message =
    update?.message;

  if (!message?.chat) {
    return;
  }

  const chatId =
    String(message.chat.id);

  const username =
    message.from?.username || "";

  const text =
    message.text || "";

  await saveUser(
    env,
    chatId,
    username
  );

  /*
    If user has a pending destination,
    treat normal text as destination.
  */
  if (
    text &&
    !text.startsWith("/")
  ) {
    const handled =
      await handleDestination(
        env,
        chatId,
        text
      );

    if (handled) {
      return;
    }
  }

  const {
    command,
    argument
  } = getCommand(text);

  switch (command) {

    case "/start":
      await handleStart(
        env,
        chatId
      );
      break;

    case "/add":
      await handleAdd(
        env,
        chatId,
        argument
      );
      break;

    case "/check":
      await handleCheck(
        env,
        chatId,
        argument
      );
      break;

    case "/train":
      await handleTrain(
        env,
        chatId,
        argument
      );
      break;

    case "/alert":
      await handleAlert(
        env,
        chatId,
        argument
      );
      break;

    case "/cancelalert":
      await handleCancelAlert(
        env,
        chatId
      );
      break;

    case "/list":
      await handleList(
        env,
        chatId
      );
      break;

    case "/remove":
      await handleRemove(
        env,
        chatId,
        argument
      );
      break;

    default:
      await sendTelegram(
        env,
        chatId,
        "❓ Unknown command.\n\nSend /start to see available commands."
      );
  }
}


/* =========================
   WORKER
========================= */

export default {

  async fetch(
    request,
    env
  ) {
    if (
      request.method !== "POST"
    ) {
      return new Response(
        "🚆 PNR Tracker Bot is running.",
        {
          status: 200,
        }
      );
    }

    try {
      const update =
        await request.json();

      await handleUpdate(
        update,
        env
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
        `Worker error: ${
          error.message ||
          "Unknown error"
        }`,
        {
          status: 500,
        }
      );
    }
  },


  async scheduled(
    event,
    env,
    ctx
  ) {
    console.log(
      "Running train alert checker..."
    );

    ctx.waitUntil(
      checkTrainAlerts(env)
    );
  },

};
