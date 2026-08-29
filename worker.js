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


async function saveUser(env, chatId, username) {
  await env.DB.prepare(`
    INSERT INTO users (telegram_id, username)
    VALUES (?, ?)
    ON CONFLICT(telegram_id)
    DO UPDATE SET username = excluded.username
  `)
    .bind(chatId, username || "")
    .run();
}


async function handleStart(env, chatId) {
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

/list
📋 Show your saved PNRs

/remove 1234567890
🗑️ Remove a PNR

You can add multiple PNRs.`
  );
}


async function handleAdd(env, chatId, pnr) {
  if (!isValidPNR(pnr)) {
    await sendTelegram(
      env,
      chatId,
      "❌ Invalid PNR.\n\nPNR must contain exactly 10 digits."
    );
    return;
  }

  await env.DB.prepare(`
    INSERT INTO pnrs (telegram_id, pnr)
    VALUES (?, ?)
    ON CONFLICT(telegram_id, pnr)
    DO NOTHING
  `)
    .bind(chatId, pnr)
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


async function handleList(env, chatId) {
  const result = await env.DB.prepare(`
    SELECT pnr, last_status
    FROM pnrs
    WHERE telegram_id = ?
    ORDER BY created_at DESC
  `)
    .bind(chatId)
    .all();

  if (!result.results || result.results.length === 0) {
    await sendTelegram(
      env,
      chatId,
      "📭 You haven't added any PNR yet."
    );
    return;
  }

  let message = "📋 Your saved PNRs:\n\n";

  for (const row of result.results) {
    message += `🎫 ${row.pnr}\n`;
    message += `Status: ${
      row.last_status || "Not checked yet"
    }\n\n`;
  }

  await sendTelegram(
    env,
    chatId,
    message
  );
}


async function handleRemove(env, chatId, pnr) {
  if (!isValidPNR(pnr)) {
    await sendTelegram(
      env,
      chatId,
      "❌ Please enter a valid 10-digit PNR."
    );
    return;
  }

  const result = await env.DB.prepare(`
    DELETE FROM pnrs
    WHERE telegram_id = ? AND pnr = ?
  `)
    .bind(chatId, pnr)
    .run();

  if (result.meta.changes === 0) {
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


async function handleCheck(env, chatId, pnr) {
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
    configure(env.RAILKIT_API_KEY);

    const result =
      await checkPNRStatus(pnr);

    const data =
      result?.data || result || {};

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
          passenger?.current || {};

        passengerText +=
          `\nPassenger ${index + 1}: ` +
          `${current.details || current.status || "-"}\n`;
      }
    );

    const message =
      `🚆 PNR STATUS\n\n` +
      `PNR: ${pnr}\n` +
      `Train: ${train.number || "-"} ${
        train.name || ""
      }\n` +
      `Journey Date: ${
        journey.dateOfJourney || "-"
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
            passenger?.current?.details ||
            passenger?.current?.status ||
            "-"
        )
        .join(" | ") || "-";

    await env.DB.prepare(`
      UPDATE pnrs
      SET last_status = ?,
          train_number = ?,
          train_name = ?,
          journey_date = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE telegram_id = ? AND pnr = ?
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
        error.message || "Unknown error"
      }`
    );
  }
}


async function handleTrain(
  env,
  chatId,
  trainNumber
) {
  if (!isValidTrainNumber(trainNumber)) {
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
    configure(env.RAILKIT_API_KEY);

    // Current date in DD-MM-YYYY format
    const now = new Date();

    const day =
      String(now.getUTCDate())
        .padStart(2, "0");

    const month =
      String(now.getUTCMonth() + 1)
        .padStart(2, "0");

    const year =
      now.getUTCFullYear();

    const journeyDate =
      `${day}-${month}-${year}`;

    console.log(
      "RailKit train date:",
      journeyDate
    );

    const result =
      await trackTrain(
        trainNumber,
        journeyDate
      );

    console.log(
      "RailKit train response:",
      JSON.stringify(result)
    );

    const data =
      result?.data || result || {};

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
      Array.isArray(data.timeline)
        ? data.timeline
        : [];

    const currentIndex =
      timeline.findIndex(
        (station) =>
          station?.status === "current"
      );

    const currentStation =
      currentIndex >= 0
        ? timeline[currentIndex]
        : null;

    const nextStation =
      currentIndex >= 0
        ? timeline
            .slice(currentIndex + 1)
            .find(
              (station) =>
                station?.status === "upcoming"
            )
        : null;

    let message =
      `🚆 LIVE TRAIN STATUS\n\n` +
      `Train: ${trainNo} ${trainName}\n\n` +
      `📅 Journey Date: ${journeyDate}\n` +
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

      if (nextStation.stationCode) {
        message +=
          ` (${nextStation.stationCode})`;
      }

      message += "\n";
    }

    if (currentStation) {
      const arrival =
        currentStation.arrival || {};

      const departure =
        currentStation.departure || {};

      if (
        arrival.actual ||
        arrival.scheduled
      ) {
        message +=
          `\n🕐 Arrival: ${
            arrival.actual ||
            arrival.scheduled ||
            "-"
          }`;
      }

      if (
        departure.actual ||
        departure.scheduled
      ) {
        message +=
          `\n🚉 Departure: ${
            departure.actual ||
            departure.scheduled ||
            "-"
          }`;
      }
    }

    message +=
      `\n\n🕐 Last Update: ${lastUpdate}`;

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


export default {

  async fetch(
    request,
    env
  ) {

    if (request.method !== "POST") {
      return new Response(
        "🚆 PNR Tracker Bot is running.",
        {
          status: 200
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
          status: 200
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
          status: 500
        }
      );
    }
  },
};
