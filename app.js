import "dotenv/config";
import bolt from "@slack/bolt";
import { GoogleGenerativeAI } from "@google/generative-ai";

const { App } = bolt;

// ── Config ──────────────────────────────────────────────────────────
const JAKE_USER_ID = process.env.JAKE_USER_ID;
const PORT = parseInt(process.env.PORT || "3000", 10);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

// ── Pessimism Levels ────────────────────────────────────────────────
const LEVELS = [
  { min: 0, max: 15, label: "Suspiciously Cheerful", emoji: "☀️", bar: "🟩" },
  { min: 15, max: 30, label: "Cautiously Hopeful", emoji: "🌤️", bar: "🟩" },
  { min: 30, max: 45, label: "Mildly Skeptical", emoji: "😐", bar: "🟨" },
  { min: 45, max: 60, label: "Classic Jake", emoji: "😒", bar: "🟧" },
  { min: 60, max: 75, label: "Doom & Gloom", emoji: "🌧️", bar: "🟥" },
  { min: 75, max: 90, label: "Apocalypse Incoming", emoji: "🌪️", bar: "🟥" },
  { min: 90, max: 100, label: "THE END IS NIGH", emoji: "💀", bar: "⬛" },
];

function getLevel(score) {
  return LEVELS.find((l) => score >= l.min && score <= l.max) || LEVELS[3];
}

function buildMeterBar(score) {
  const filled = Math.round(score / 5);
  const empty = 20 - filled;
  const level = getLevel(score);
  return level.bar.repeat(filled) + "⬜".repeat(empty);
}

// ── Fetch Jake's Messages ───────────────────────────────────────────
async function fetchJakeMessages(channelId, lookbackHours = 24) {
  const oldest = String(
    Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000)
  );

  const messages = [];
  let cursor;

  do {
    const result = await app.client.conversations.history({
      channel: channelId,
      oldest,
      limit: 200,
      cursor,
    });

    const jakeMessages = result.messages
      .filter((m) => m.user === JAKE_USER_ID && m.type === "message" && !m.subtype)
      .map((m) => m.text);

    messages.push(...jakeMessages);
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return messages;
}

// ── Analyze with Gemini ─────────────────────────────────────────────
async function analyzePessimism(messages) {
  const joined = messages.map((m, i) => `${i + 1}. ${m}`).join("\n");

  const prompt = `You are a "Pessimism Analyzer" for a fun office joke. Analyze the following Slack messages from a colleague named Jake who is known for being pessimistic.

Rate his pessimism from 0-100 where:
- 0-15: Unusually positive (suspicious)
- 15-30: Cautiously hopeful
- 30-45: Mildly skeptical
- 45-60: Standard pessimism
- 60-75: Heavy doom and gloom
- 75-90: Apocalyptic outlook
- 90-100: Has lost all hope

Respond ONLY with valid JSON, no markdown backticks, no extra text:
{
  "score": <number 0-100>,
  "analysis": "<1-2 sentence witty summary of Jake's mood>",
  "highlights": ["<most pessimistic quote or paraphrase>", "<second most pessimistic>"],
  "trend": "<up|down|stable> compared to a hypothetical average of 55"
}

Jake's messages from today:
${joined}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Format Slack Response ───────────────────────────────────────────
function formatResponse(result, messageCount, channelId) {
  const level = getLevel(result.score);
  const trendEmoji =
    result.trend === "up" ? "📈" : result.trend === "down" ? "📉" : "➡️";

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${level.emoji} JAKE-O-METER™ — ${level.label}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Pessimism Score:* \`${result.score}/100\`\n${buildMeterBar(result.score)}\n\n${result.analysis}`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🔬 Peak Pessimism Detected:*\n${result.highlights
          .map((h) => `> _"${h}"_`)
          .join("\n")}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${trendEmoji} Trend: *${result.trend}* · 📊 Based on *${messageCount}* messages today · 🕐 ${new Date().toLocaleTimeString()}`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "⚠️ _JAKE-O-METER™ is for entertainment only. No pessimists were harmed in this analysis._",
        },
      ],
    },
  ];

  return blocks;
}

// ── Slash Command: /pessimism ───────────────────────────────────────
app.command("/pessimism", async ({ command, ack, respond }) => {
  await ack();

  const channelId = command.channel_id;
  const args = command.text?.trim();

  // Parse optional lookback hours: /pessimism 8 (default 24)
  const lookbackHours = args && !isNaN(args) ? parseInt(args, 10) : 24;

  try {
    await respond({
      response_type: "in_channel",
      text: "🔍 Scanning for pessimism... stand by.",
    });

    const messages = await fetchJakeMessages(channelId, lookbackHours);

    if (messages.length === 0) {
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: `☀️ No messages from Jake in the last ${lookbackHours}h in this channel. Either he's on PTO or he's moved to a bunker.`,
      });
      return;
    }

    const result = await analyzePessimism(messages);
    const blocks = formatResponse(result, messages.length, channelId);

    await respond({
      response_type: "in_channel",
      replace_original: true,
      blocks,
      text: `Jake-O-Meter: ${result.score}/100 — ${getLevel(result.score).label}`,
    });
  } catch (err) {
    console.error("Error:", err);
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: `❌ Error analyzing pessimism: ${err.message}\nMake sure the bot is in this channel and has the right permissions.`,
    });
  }
});

// ── App Mention: @JakeOMeter how's Jake? ────────────────────────────
app.event("app_mention", async ({ event, say }) => {
  const channelId = event.channel;

  try {
    await say("🔍 Scanning for pessimism... stand by.");

    const messages = await fetchJakeMessages(channelId);

    if (messages.length === 0) {
      await say(
        "☀️ No messages from Jake in the last 24h here. Suspicious silence..."
      );
      return;
    }

    const result = await analyzePessimism(messages);
    const blocks = formatResponse(result, messages.length, channelId);

    await say({
      blocks,
      text: `Jake-O-Meter: ${result.score}/100 — ${getLevel(result.score).label}`,
    });
  } catch (err) {
    console.error("Error:", err);
    await say(`❌ Something went wrong: ${err.message}`);
  }
});

// ── Scheduled Daily Report ──────────────────────────────────────────
//
// HOW THIS WORKS:
// Set DAILY_REPORT_CHANNEL in your .env to a Slack channel ID.
// The bot will automatically post a pessimism reading at 5pm every day.
//
// To find a channel ID:
//   1. Right-click the channel name in Slack
//   2. Click "View channel details"
//   3. Scroll to the bottom — the Channel ID starts with C (e.g. C0XXXXXXXXX)
//
// The report analyzes Jake's messages from the last 8 hours (roughly
// the workday), so it captures that day's pessimism only.
//
// To change the report time, edit the target.setHours(17, 0, 0, 0) line
// below. The time uses your SERVER's timezone, so if you deploy to a
// cloud host, set the TZ environment variable (e.g. TZ=America/New_York).

const DAILY_REPORT_CHANNEL = process.env.DAILY_REPORT_CHANNEL;

async function sendDailyReport() {
  if (!DAILY_REPORT_CHANNEL) return;

  try {
    const messages = await fetchJakeMessages(DAILY_REPORT_CHANNEL, 8);
    if (messages.length === 0) return;

    const result = await analyzePessimism(messages);
    const blocks = formatResponse(result, messages.length, DAILY_REPORT_CHANNEL);

    await app.client.chat.postMessage({
      channel: DAILY_REPORT_CHANNEL,
      blocks,
      text: `Daily Jake-O-Meter: ${result.score}/100`,
    });
  } catch (err) {
    console.error("Daily report error:", err);
  }
}

function scheduleDailyReport() {
  if (!DAILY_REPORT_CHANNEL) return;

  const now = new Date();
  const target = new Date();
  target.setHours(17, 0, 0, 0); // 5:00 PM server time
  if (now > target) target.setDate(target.getDate() + 1);

  const delay = target.getTime() - now.getTime();
  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, delay);

  console.log(
    `📅 Daily report scheduled for ${target.toLocaleString()} in #${DAILY_REPORT_CHANNEL}`
  );
}

// ── Start ───────────────────────────────────────────────────────────
(async () => {
  await app.start(PORT);
  console.log(`
  ╔═══════════════════════════════════════╗
  ║       💀 JAKE-O-METER™ IS LIVE       ║
  ║   Pessimism Detection System v2.4.1   ║
  ╠═══════════════════════════════════════╣
  ║  Slash command:  /pessimism           ║
  ║  Mention:        @JakeOMeter          ║
  ║  Jake's ID:      ${JAKE_USER_ID || "NOT SET ⚠️ "}          ║
  ║  AI:             Gemini 2.0 Flash     ║
  ╚═══════════════════════════════════════╝
  `);
  scheduleDailyReport();
})();