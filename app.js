import "dotenv/config";
import bolt from "@slack/bolt";
import { GoogleGenerativeAI } from "@google/generative-ai";

const { App } = bolt;

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

// ── User Name Cache ─────────────────────────────────────────────────
const userNameCache = new Map();

async function getUserName(userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);

  try {
    const result = await app.client.users.info({ user: userId });
    const name =
      result.user.profile.display_name ||
      result.user.real_name ||
      result.user.name;
    userNameCache.set(userId, name);
    return name;
  } catch (err) {
    console.error(`Failed to look up user ${userId}:`, err.message);
    return userId;
  }
}

// ── Pessimism Levels ────────────────────────────────────────────────
const PESSIMISM_LEVELS = [
  { min: 0, max: 15, label: "Suspiciously Cheerful", emoji: "☀️", bar: "🟩" },
  { min: 15, max: 30, label: "Cautiously Hopeful", emoji: "🌤️", bar: "🟩" },
  { min: 30, max: 45, label: "Mildly Skeptical", emoji: "😐", bar: "🟨" },
  { min: 45, max: 60, label: "Leaning Negative", emoji: "😒", bar: "🟧" },
  { min: 60, max: 75, label: "Doom & Gloom", emoji: "🌧️", bar: "🟥" },
  { min: 75, max: 90, label: "Apocalypse Incoming", emoji: "🌪️", bar: "🟥" },
  { min: 90, max: 100, label: "THE END IS NIGH", emoji: "💀", bar: "⬛" },
];

const OPTIMISM_LEVELS = [
  { min: 0, max: 15, label: "Barely Alive", emoji: "😶", bar: "⬜" },
  { min: 15, max: 30, label: "Meh", emoji: "😐", bar: "⬜" },
  { min: 30, max: 45, label: "Glass Half Full-ish", emoji: "🙂", bar: "🟨" },
  { min: 45, max: 60, label: "Good Vibes", emoji: "😊", bar: "🟩" },
  { min: 60, max: 75, label: "Team Cheerleader", emoji: "🎉", bar: "🟩" },
  { min: 75, max: 90, label: "Sunshine Incarnate", emoji: "🌞", bar: "🟩" },
  { min: 90, max: 100, label: "AGGRESSIVELY HAPPY", emoji: "🤩", bar: "💛" },
];

function getLevel(score, levels) {
  return levels.find((l) => score >= l.min && score <= l.max) || levels[3];
}

function buildMeterBar(score, levels) {
  const filled = Math.round(score / 5);
  const empty = 20 - filled;
  const level = getLevel(score, levels);
  return level.bar.repeat(filled) + "⬜".repeat(empty);
}

// ── Fetch ALL Channel Messages (grouped by user) ────────────────────
async function fetchChannelMessages(channelId, lookbackHours = 24) {
  const oldest = String(
    Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000)
  );

  const byUser = new Map(); // userId -> [messages]
  let cursor;

  do {
    const result = await app.client.conversations.history({
      channel: channelId,
      oldest,
      limit: 200,
      cursor,
    });

    for (const m of result.messages) {
      if (m.type !== "message" || m.subtype || m.bot_id) continue;
      if (!m.user || !m.text) continue;

      if (!byUser.has(m.user)) byUser.set(m.user, []);
      byUser.get(m.user).push(m.text);
    }

    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return byUser;
}

// ── Analyze Team with Gemini ────────────────────────────────────────
async function analyzeTeam(messagesByUser) {
  // Build a labeled transcript
  const entries = [];
  for (const [userId, msgs] of messagesByUser) {
    const name = await getUserName(userId);
    entries.push(`=== ${name} (${msgs.length} messages) ===\n${msgs.join("\n")}`);
  }
  const transcript = entries.join("\n\n");

  const prompt = `You are a fun "Team Vibe Analyzer" for an office Slack channel. Analyze each person's messages and score them on two scales:

PESSIMISM (0-100): How negative, skeptical, doom-and-gloom are they?
OPTIMISM (0-100): How positive, encouraging, collaborative, upbeat are they?

These are NOT inverses — someone can be low on both (neutral/factual) or high on both (passionate about everything).

For each person, provide a score and a short witty observation.

Then crown:
- 🏆 THE PESSIMIST: whoever scored highest on pessimism
- 🏆 THE OPTIMIST: whoever scored highest on optimism

If someone only has 1-2 very short messages, still score them but note the small sample size.

Respond ONLY with valid JSON, no markdown backticks:
{
  "people": [
    {
      "name": "<display name>",
      "pessimism_score": <0-100>,
      "optimism_score": <0-100>,
      "vibe_summary": "<1 sentence witty take on their energy today>",
      "most_pessimistic_quote": "<their most negative message or null>",
      "most_optimistic_quote": "<their most positive message or null>"
    }
  ],
  "pessimist": {
    "name": "<name of the most pessimistic person>",
    "score": <their pessimism score>,
    "roast": "<1 sentence playful roast crowning them today's pessimist>"
  },
  "optimist": {
    "name": "<name of the most optimistic person>",
    "score": <their optimism score>,
    "celebration": "<1 sentence celebrating them as today's optimist>"
  },
  "team_vibe": "<1-2 sentence overall read on the team's energy today>"
}

Here are today's Slack messages by person:

${transcript}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Format Team Report ──────────────────────────────────────────────
function formatTeamResponse(result, totalMessages, userCount) {
  const pessimist = result.pessimist;
  const optimist = result.optimist;
  const pessLevel = getLevel(pessimist.score, PESSIMISM_LEVELS);
  const optLevel = getLevel(optimist.score, OPTIMISM_LEVELS);

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "📊 TEAM VIBE CHECK™",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_${result.team_vibe}_`,
      },
    },
    { type: "divider" },
    // Pessimist of the day
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${pessLevel.emoji} *TODAY'S PESSIMIST:  ${pessimist.name}*\n*Pessimism Score:* \`${pessimist.score}/100\` — ${pessLevel.label}\n${buildMeterBar(pessimist.score, PESSIMISM_LEVELS)}\n\n${pessimist.roast}`,
      },
    },
    { type: "divider" },
    // Optimist of the day
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${optLevel.emoji} *TODAY'S OPTIMIST:  ${optimist.name}*\n*Optimism Score:* \`${optimist.score}/100\` — ${optLevel.label}\n${buildMeterBar(optimist.score, OPTIMISM_LEVELS)}\n\n${optimist.celebration}`,
      },
    },
    { type: "divider" },
    // Individual scoreboard
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*📋 Full Scoreboard:*\n" +
          result.people
            .sort((a, b) => b.pessimism_score - a.pessimism_score)
            .map(
              (p) =>
                `• *${p.name}* — 😒 ${p.pessimism_score} / 😊 ${p.optimism_score} — _${p.vibe_summary}_`
            )
            .join("\n"),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📊 Based on *${totalMessages}* messages from *${userCount}* people · 🕐 ${new Date().toLocaleTimeString()}`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "⚠️ _TEAM VIBE CHECK™ is for entertainment only. All readings are approximate and legally non-binding._",
        },
      ],
    },
  ];

  return blocks;
}

// ── Slash Command: /vibecheck ───────────────────────────────────────
app.command("/pessimism", async ({ command, ack, respond }) => {
  await ack();

  const channelId = command.channel_id;
  const args = command.text?.trim();
  const lookbackHours = args && !isNaN(args) ? parseInt(args, 10) : 24;

  try {
    await respond({
      response_type: "in_channel",
      text: "🔍 Scanning the team's vibes... stand by.",
    });

    const messagesByUser = await fetchChannelMessages(channelId, lookbackHours);

    if (messagesByUser.size === 0) {
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: `😶 No messages in the last ${lookbackHours}h. The team is either very productive or very asleep.`,
      });
      return;
    }

    const totalMessages = [...messagesByUser.values()].reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );

    const result = await analyzeTeam(messagesByUser);
    const blocks = formatTeamResponse(result, totalMessages, messagesByUser.size);

    await respond({
      response_type: "in_channel",
      replace_original: true,
      blocks,
      text: `Team Vibe Check: Pessimist=${result.pessimist.name}, Optimist=${result.optimist.name}`,
    });
  } catch (err) {
    console.error("Error:", err);
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: `❌ Error analyzing vibes: ${err.message}\nMake sure the bot is in this channel and has the right permissions.`,
    });
  }
});

// ── App Mention: @Pessimeter ────────────────────────────────────────
app.event("app_mention", async ({ event, say }) => {
  const channelId = event.channel;

  try {
    await say("🔍 Scanning the team's vibes... stand by.");

    const messagesByUser = await fetchChannelMessages(channelId);

    if (messagesByUser.size === 0) {
      await say("😶 No messages in the last 24h. Eerie silence...");
      return;
    }

    const totalMessages = [...messagesByUser.values()].reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );

    const result = await analyzeTeam(messagesByUser);
    const blocks = formatTeamResponse(result, totalMessages, messagesByUser.size);

    await say({
      blocks,
      text: `Team Vibe Check: Pessimist=${result.pessimist.name}, Optimist=${result.optimist.name}`,
    });
  } catch (err) {
    console.error("Error:", err);
    await say(`❌ Something went wrong: ${err.message}`);
  }
});

// ── Scheduled Daily Report ──────────────────────────────────────────
const DAILY_REPORT_CHANNEL = process.env.DAILY_REPORT_CHANNEL;

async function sendDailyReport() {
  if (!DAILY_REPORT_CHANNEL) return;

  try {
    const messagesByUser = await fetchChannelMessages(DAILY_REPORT_CHANNEL, 8);
    if (messagesByUser.size === 0) return;

    const totalMessages = [...messagesByUser.values()].reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );

    const result = await analyzeTeam(messagesByUser);
    const blocks = formatTeamResponse(result, totalMessages, messagesByUser.size);

    await app.client.chat.postMessage({
      channel: DAILY_REPORT_CHANNEL,
      blocks,
      text: `Daily Vibe Check: Pessimist=${result.pessimist.name}, Optimist=${result.optimist.name}`,
    });
  } catch (err) {
    console.error("Daily report error:", err);
  }
}

function scheduleDailyReport() {
  if (!DAILY_REPORT_CHANNEL) return;

  const now = new Date();
  const target = new Date();
  target.setHours(17, 0, 0, 0);
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
  ║     📊 TEAM VIBE CHECK™ IS LIVE      ║
  ║   Pessimism & Optimism Detection      ║
  ╠═══════════════════════════════════════╣
  ║  Slash command:  /pessimism           ║
  ║  Mention:        @Pessimeter          ║
  ║  AI:             Gemini 2.0 Flash     ║
  ╚═══════════════════════════════════════╝
  `);
  scheduleDailyReport();
})();