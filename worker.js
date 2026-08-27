import { configure, checkPNRStatus } from "railkit";

async function sendTelegram(env, chatId, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: text,
      }),
    }
  );

  const result = await response.text();

  console.log("Telegram response:", result);

  if (!response.ok) {
    throw new Error(
      `Telegram API error ${response.status}: ${result}`
    );
  }

  return result;
}

function isValidPNR(pnr) {
  return /^\d{10}$/.test(pnr);
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
    message += `Status: ${row.last_status || "Not checked yet"}\n\n`;
  }

  await sendTelegram(env, chatId, message);
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

    const result = await checkPNRStatus(pnr);

    const data = result?.data || result;

    const train = data?.train || {};
    const journey = data?.journey || {};
    const passengers = data?.passengers || [];

    let passengerText = "";

    passengers.forEach((passenger, index) => {
      const current = passenger?.current || {};

      passengerText +=
        `\nPassenger ${index + 1}: ` +
        `${current.details || current.status || "-"}\n`;
    });

    const message =
      `🚆 PNR STATUS\n\n` +
      `PNR: ${pnr}\n` +
      `Train: ${train.number || "-"} ${train.name || ""}\n` +
      `Journey Date: ${journey.dateOfJourney || "-"}\n` +
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
    console.error("RailKit error:", error);

    await sendTelegram(
      env,
      chatId,
      `❌ PNR check failed.

Please try again later.

Error: ${error.message || "Unknown error"}`
    );
  }
}

async function handleUpdate(update, env) {
  const message = update?.message;

  if (!message?.chat) {
    return;
  }

  const chatId = String(message.chat.id);
  const username = message.from?.username || "";
  const text = message.text || "";

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

  async fetch(request, env) {

    if (request.method !== "POST") {
      return new Response(
        "🚆 PNR Tracker Bot is running.",
        {
          status: 200
        }
      );
    }

    try {

      const update = await request.json();

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
        `Worker error: ${error.message || "Unknown error"}`,
        {
          status: 500
        }
      );
    }
  },
};
