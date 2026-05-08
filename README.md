# Animocamind Telegram Connector

A service that enables users to **login with Telegram** and automatically provision a **dedicated Telegram bot per user** using Telegram's Managed Bots API (Bot API 9.6).

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Architecture](#architecture)
- [Login with Telegram](#login-with-telegram)
  - [Widget Setup](#widget-setup)
  - [Auth Data](#auth-data)
  - [Server-Side Verification](#server-side-verification)
- [Managed Bots — Per-User Bot Creation](#managed-bots--per-user-bot-creation)
  - [What Are Managed Bots](#what-are-managed-bots)
  - [Bot Creation Flow](#bot-creation-flow)
  - [Webhook Handler](#webhook-handler)
  - [Retrieving the Bot Token](#retrieving-the-bot-token)
- [Programming the Manager Bot](#programming-the-manager-bot)
  - [Step 1 — Verify Manager Capability](#step-1--verify-manager-capability)
  - [Step 2 — Register the Webhook](#step-2--register-the-webhook)
  - [Step 3 — Trigger Bot Creation](#step-3--trigger-bot-creation)
  - [Step 4 — Handle ManagedBotUpdated](#step-4--handle-managedbolupdated)
  - [Step 5 — Fetch the Bot Token](#step-5--fetch-the-bot-token)
  - [Step 6 — Rotate a Token](#step-6--rotate-a-token)
  - [Mini App Integration](#mini-app-integration)
  - [TypeScript Type Definitions](#typescript-type-definitions)
  - [SDK Support](#sdk-support)
- [Manager Bot Capabilities](#manager-bot-capabilities)
  - [Enabling Bot Management Mode](#enabling-bot-management-mode)
  - [Child Bot Control — Full Impersonation Model](#child-bot-control--full-impersonation-model)
  - [Messaging](#messaging)
  - [Profile and Identity Management](#profile-and-identity-management)
  - [Bot Behavior Settings](#bot-behavior-settings)
  - [Webhook and Update Configuration](#webhook-and-update-configuration)
  - [Group and Channel Administration](#group-and-channel-administration)
  - [Bot-to-Bot Communication](#bot-to-bot-communication)
  - [Token Management Patterns](#token-management-patterns)
  - [Child Bot Ownership Model](#child-bot-ownership-model)
  - [Limits and Quotas](#limits-and-quotas)
  - [What the Manager Cannot Do](#what-the-manager-cannot-do)
- [Full User Journey](#full-user-journey)
- [API Reference](#api-reference)
- [Limitations](#limitations)

---

## Overview

This connector bridges Animocamind with Telegram by providing two core capabilities:

1. **Telegram Login** — Authenticate users via Telegram's Login Widget (OAuth-like, verified with HMAC-SHA256).
2. **Per-User Bot Provisioning** — After login, each user is guided through creating their own Telegram bot managed by the Animocamind manager bot, using the Managed Bots feature introduced in Bot API 9.6 (April 2026).

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Telegram Manager Bot | Created via `@BotFather`. Must have `can_manage_bots: true` (visible in `getMe` response) |
| Domain registration | Run `/setdomain` in `@BotFather` to link your website domain to the login bot |
| HTTPS endpoint | Required for both the Login Widget and webhook receiver |
| Webhook port | Must be one of: `443`, `80`, `88`, `8443` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        User Browser                         │
│                                                             │
│  1. Clicks "Login with Telegram"                            │
│  2. Completes Telegram auth popup                           │
│  3. Receives deep link → opens Telegram app                 │
│  4. Creates their bot (guided, one-time)                    │
└───────────────────┬──────────────────────────────┬──────────┘
                    │                              │
          Auth callback (JS)              Deep link redirect
                    │                              │
                    ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Animocamind Backend                       │
│                                                             │
│  • Verifies login hash (HMAC-SHA256)                        │
│  • Stores user Telegram ID                                  │
│  • Sends deep link for managed bot creation                 │
│  • Receives ManagedBotUpdated webhook                       │
│  • Calls getManagedBotToken → stores per-user bot token     │
└─────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                   Telegram Platform                         │
│                                                             │
│  • Login Widget JS (telegram.org)                           │
│  • BotFather / Managed Bot API                              │
│  • Per-user bot instances                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Login with Telegram

### Widget Setup

1. Create a login bot via `@BotFather` and note the bot username.
2. Link your domain by messaging `@BotFather`:
   ```
   /setdomain
   ```
   Then enter your website's domain (e.g., `app.animocamind.com`).

3. Embed the widget on your login page:

```html
<script
  async
  src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="YOUR_BOT_USERNAME"
  data-size="large"
  data-onauth="onTelegramAuth(user)"
  data-request-access="write"
></script>

<script>
  function onTelegramAuth(user) {
    // Send `user` object to your backend for verification
    fetch('/api/auth/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
  }
</script>
```

> For redirect-based flows, replace `data-onauth` with `data-auth-url="https://yourapp.com/auth/callback"`.

### Auth Data

After a successful login, Telegram returns the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | Integer | Yes | Telegram user ID |
| `first_name` | String | Yes | User's first name |
| `last_name` | String | No | User's last name |
| `username` | String | No | Telegram username |
| `photo_url` | String | No | Profile photo URL |
| `auth_date` | Integer | Yes | Unix timestamp of authentication |
| `hash` | String | Yes | HMAC-SHA256 verification hash |

### Server-Side Verification

**All login data must be verified server-side.** Skipping this step allows forged logins.

```js
import crypto from 'crypto';

/**
 * Verifies Telegram Login Widget auth data.
 * @param {Record<string, string>} data - The auth fields sent by the widget
 * @param {string} botToken - Your login bot's API token
 * @returns {boolean}
 */
function verifyTelegramAuth(data, botToken) {
  const { hash, ...fields } = data;

  // 1. Sort fields alphabetically and build check string
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');

  // 2. Derive secret key: SHA256 of the bot token (NOT HMAC)
  const secretKey = crypto.createHash('sha256').update(botToken).digest();

  // 3. Compute HMAC-SHA256
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // 4. Validate hash
  if (computedHash !== hash) return false;

  // 5. Reject auth_date older than 5 minutes (prevent replay attacks)
  const age = Math.floor(Date.now() / 1000) - parseInt(fields.auth_date, 10);
  if (age > 300) return false;

  return true;
}
```

**Express route using the verifier:**

```js
import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/auth/telegram', (req, res) => {
  const data = req.body;

  if (!verifyTelegramAuth(data, process.env.LOGIN_BOT_TOKEN)) {
    return res.status(401).json({ error: 'Invalid Telegram auth data' });
  }

  // Auth is valid — create or update user session
  const { id, first_name, last_name, username, photo_url } = data;

  // ... persist user, issue JWT/session, etc.

  res.json({ ok: true, user: { id, first_name, last_name, username, photo_url } });
});
```

**Common mistakes to avoid:**

- Do **not** include the `hash` field itself in `dataCheckString`
- The secret key is `SHA256(botToken)` — plain hash, **not** `HMAC(botToken)`
- Always validate `auth_date` to prevent replay attacks

---

https://t.me/newbot/hellominds_bot/HelloMindsTesterBot?name=Hello+Mind+Tester

## Managed Bots — Per-User Bot Creation

### What Are Managed Bots

Introduced in **Bot API 9.6 (April 2026)**, Managed Bots allow a "manager bot" to assist users in creating new bots that are linked back to the manager. The manager bot can then retrieve and manage the tokens of these child bots.

The manager bot must have `can_manage_bots: true`, which is verified by calling `getMe`:

```bash
curl https://api.telegram.org/bot<TOKEN>/getMe
# Response includes: "can_manage_bots": true
```

### Bot Creation Flow

After a user logs in, initiate bot creation by sending them a deep link:

```
https://t.me/newbot/{manager_bot_username}/{suggested_bot_username}?name={suggested_bot_name}
```

**Parameters:**

| Parameter | Description |
|-----------|-------------|
| `manager_bot_username` | Your manager bot's username (without `@`) |
| `suggested_bot_username` | Pre-filled username for the new bot (must end in `bot`) |
| `name` | (Optional) Pre-filled display name for the new bot |

**Example:**
```
https://t.me/newbot/AnimocamindManagerBot/alice_animoca_bot?name=Alice%27s+Bot
```

> The user opens this link in the Telegram app. Telegram guides them through the creation steps. A human confirmation is always required — headless/silent creation is not supported.

Alternatively, trigger bot creation from a Mini App using a `KeyboardButtonRequestManagedBot` inline keyboard button.

### Webhook Handler

Once the user completes bot creation, your manager bot receives a `ManagedBotUpdated` update on your webhook endpoint.

**Incoming update shape:**
```json
{
  "update_id": 123456789,
  "managed_bot": {
    "user": {
      "id": 111222333,
      "is_bot": false,
      "first_name": "Alice"
    },
    "bot": {
      "id": 987654321,
      "is_bot": true,
      "username": "alice_animoca_bot",
      "first_name": "Alice's Bot"
    }
  }
}
```

**Webhook handler (Express / Node.js example):**
```js
app.post('/webhook/telegram', express.json(), async (req, res) => {
  const update = req.body;

  if (update.managed_bot) {
    const { user, bot } = update.managed_bot;

    // Retrieve the bot token using the bot's user ID
    const token = await getManagedBotToken(bot.id);

    // Persist: associate token with the owner user
    await db.managedBots.upsert({
      where: { owner_telegram_id: user.id },
      data: {
        bot_id: bot.id,
        bot_username: bot.username,
        bot_token: token,
      },
    });
  }

  res.sendStatus(200);
});
```

### Retrieving the Bot Token

Call `getManagedBotToken` with `user_id` set to the managed bot's Telegram user ID:

```bash
curl -X POST https://api.telegram.org/bot<MANAGER_TOKEN>/getManagedBotToken \
  -H "Content-Type: application/json" \
  -d '{"user_id": 987654321}'
```

**Response:**
```json
{
  "ok": true,
  "result": "987654321:ABCDefGhIjKlMnOpQrStUvWxYz"
}
```

To rotate a managed bot's token:
```bash
curl -X POST https://api.telegram.org/bot<MANAGER_TOKEN>/replaceManagedBotToken \
  -H "Content-Type: application/json" \
  -d '{"user_id": 987654321}'
```

---

## Programming the Manager Bot

This section is a step-by-step implementation guide for the manager bot — the central piece of the system that receives managed bot creation events and controls child bots on behalf of users.

> All HTTP calls use the format: `POST https://api.telegram.org/bot<TOKEN>/METHOD`

---

### Step 1 — Verify Manager Capability

Before writing any code, confirm that your bot has the `can_manage_bots` capability. This is a platform-level flag set by Telegram — it is **not configurable via the API or BotFather settings**. Check it with `getMe`:

```bash
curl https://api.telegram.org/bot<MANAGER_TOKEN>/getMe
```

Expected response for a manager bot:

```json
{
  "ok": true,
  "result": {
    "id": 123456789,
    "is_bot": true,
    "first_name": "Animocamind Manager",
    "username": "AnimocamindManagerBot",
    "can_manage_bots": true
  }
}
```

If `can_manage_bots` is absent or `false`, your bot does not have this capability. Contact Telegram support or check BotFather for eligibility.

---

### Step 2 — Register the Webhook

The `managed_bot` update type is **not included in the default update set** — you must explicitly subscribe to it via `allowed_updates`.

```bash
curl -X POST https://api.telegram.org/bot<MANAGER_TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.com/webhook/telegram",
    "allowed_updates": ["message", "managed_bot"],
    "secret_token": "your_webhook_secret"
  }'
```

**Parameters:**

| Parameter | Description |
|-----------|-------------|
| `url` | Your HTTPS endpoint. Must be on port `443`, `80`, `88`, or `8443` |
| `allowed_updates` | Must include `"managed_bot"` to receive creation/update events |
| `secret_token` | Optional but recommended — Telegram sends this in the `X-Telegram-Bot-Api-Secret-Token` header so you can authenticate incoming requests |

Verify the webhook is set:

```bash
curl https://api.telegram.org/bot<MANAGER_TOKEN>/getWebhookInfo
```

---

### Step 3 — Trigger Bot Creation

After a user logs in, you have three ways to prompt them to create their managed bot:

#### Option A — Deep Link (simplest)

Send the user a message or redirect them to:

```
https://t.me/newbot/{manager_bot_username}/{suggested_username}?name={suggested_name}
```

Example:

```
https://t.me/newbot/AnimocamindManagerBot/alice_animoca_bot?name=Alice%27s+Bot
```

The user opens this in their Telegram app and follows the guided creation flow.

#### Option B — Reply Keyboard Button

Send a reply keyboard to the user inside a chat with the manager bot:

```bash
curl -X POST https://api.telegram.org/bot<MANAGER_TOKEN>/sendMessage \
  -H "Content-Type: application/json" \
  -d '{
    "chat_id": 111111111,
    "text": "Tap the button below to create your personal bot.",
    "reply_markup": {
      "keyboard": [[
        {
          "text": "Create My Bot",
          "request_managed_bot": {
            "request_id": 1,
            "suggested_name": "My Bot",
            "suggested_username": "mybot"
          }
        }
      ]],
      "resize_keyboard": true,
      "one_time_keyboard": true
    }
  }'
```

`KeyboardButtonRequestManagedBot` fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `request_id` | Integer | Yes | Unique signed 32-bit ID for this request within the message |
| `suggested_name` | String | No | Pre-filled display name for the new bot |
| `suggested_username` | String | No | Pre-filled username (must end in `bot`) |

#### Option C — Mini App (`savePreparedKeyboardButton`)

For apps embedded in Telegram, pre-store the button server-side and surface it in the Mini App:

```bash
# 1. Save the prepared button
curl -X POST https://api.telegram.org/bot<MANAGER_TOKEN>/savePreparedKeyboardButton \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 111111111,
    "button": {
      "text": "Create Bot",
      "request_managed_bot": {
        "request_id": 1,
        "suggested_username": "mynewbot"
      }
    }
  }'
# Returns: {"ok": true, "result": {"id": "abc123preparedid"}}
```

Pass the returned `id` to the Mini App client and invoke it via `WebApp.requestChat()`.

---

### Step 4 — Handle ManagedBotUpdated

When a user completes bot creation (or a token is rotated, or ownership changes), your webhook receives an update with the `managed_bot` field.

**Incoming update shape:**

```json
{
  "update_id": 100500,
  "managed_bot": {
    "user": {
      "id": 111111111,
      "is_bot": false,
      "first_name": "Alice"
    },
    "bot": {
      "id": 987654321,
      "is_bot": true,
      "first_name": "Alice's Bot",
      "username": "alice_animoca_bot"
    }
  }
}
```

`ManagedBotUpdated` fields:

| Field | Type | Description |
|-------|------|-------------|
| `user` | `User` | The Telegram user who created/owns the bot |
| `bot` | `User` | The newly created or updated managed bot |

This event fires for **three scenarios**: initial creation, token replacement, and owner transfer.

**Express / Node.js webhook handler:**

```ts
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

app.post('/webhook/telegram', async (req, res) => {
  // Verify secret token header
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  const update = req.body;

  if (update.managed_bot) {
    const { user, bot } = update.managed_bot;

    try {
      // Fetch the bot token (see Step 5)
      const botToken = await getManagedBotToken(bot.id);

      // Persist association: user → their managed bot
      await db.managedBots.upsert({
        where: { owner_telegram_id: user.id },
        update: {
          bot_id: bot.id,
          bot_username: bot.username,
          bot_token: botToken,           // store encrypted at rest
          updated_at: new Date(),
        },
        create: {
          owner_telegram_id: user.id,
          bot_id: bot.id,
          bot_username: bot.username,
          bot_token: botToken,
          created_at: new Date(),
        },
      });

      console.log(`Managed bot provisioned: @${bot.username} for user ${user.id}`);
    } catch (err) {
      console.error('Failed to provision managed bot:', err);
      // Return 200 anyway — Telegram will retry on non-2xx
    }
  }

  res.sendStatus(200);
});
```

> Always return `200 OK` to Telegram even on internal errors. Non-2xx responses cause Telegram to retry the update repeatedly.

A service message (`Message.managed_bot_created`) is also delivered in the chat where the keyboard button was pressed. Its `ManagedBotCreated` object contains a single `bot` field (the `User` of the new bot).

---

### Step 5 — Fetch the Bot Token

Call `getManagedBotToken` with the managed bot's Telegram user ID (`bot.id` from the update):

```ts
async function getManagedBotToken(botUserId: number): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.MANAGER_BOT_TOKEN}/getManagedBotToken`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: botUserId }),
    }
  );

  const data = await res.json();
  if (!data.ok) throw new Error(`getManagedBotToken failed: ${data.description}`);

  return data.result; // plain string token
}
```

> The parameter is `user_id`, not `bot_id`. The managed bot's `id` field in the `User` object is its Telegram user ID.

---

### Step 6 — Rotate a Token

Call `replaceManagedBotToken` to immediately invalidate the current token and issue a new one:

```ts
async function rotateManagedBotToken(botUserId: number): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.MANAGER_BOT_TOKEN}/replaceManagedBotToken`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: botUserId }),
    }
  );

  const data = await res.json();
  if (!data.ok) throw new Error(`replaceManagedBotToken failed: ${data.description}`);

  return data.result; // new token string — old token is immediately dead
}
```

After rotation, a new `ManagedBotUpdated` update is delivered to your webhook. Update the stored token in your database from there (or from the return value above).

---

### Mini App Integration

If your frontend is a Telegram Mini App, the flow differs slightly:

1. Call `savePreparedKeyboardButton` from your server with the user's Telegram ID and the `request_managed_bot` button definition.
2. Return the `PreparedKeyboardButton.id` to the Mini App client.
3. The Mini App calls `window.Telegram.WebApp.requestChat(preparedButtonId, callback)` to surface the creation prompt.
4. On completion, your webhook receives the `managed_bot` update as usual.

---

### TypeScript Type Definitions

Bot API 9.6 introduced the following new types. Add these to your project until your SDK ships official support:

```ts
// Telegram Bot API 9.6 — Managed Bots types

interface ManagedBotCreated {
  /** The newly created managed bot */
  bot: User;
}

interface ManagedBotUpdated {
  /** The user who created or owns the bot */
  user: User;
  /** The managed bot (created, token-rotated, or owner-changed) */
  bot: User;
}

interface KeyboardButtonRequestManagedBot {
  /** Unique signed 32-bit request ID, must be unique within the message */
  request_id: number;
  /** Optional pre-filled display name */
  suggested_name?: string;
  /** Optional pre-filled username (must end in "bot") */
  suggested_username?: string;
}

interface PreparedKeyboardButton {
  /** Unique identifier of the stored button, pass to Mini App */
  id: string;
}

// Extensions to existing types
interface User {
  /** Only present in getMe for manager bots */
  can_manage_bots?: boolean;
}

interface Update {
  managed_bot?: ManagedBotUpdated;
}

interface Message {
  managed_bot_created?: ManagedBotCreated;
}

interface KeyboardButton {
  request_managed_bot?: KeyboardButtonRequestManagedBot;
}
```

---

### SDK Support

Bot API 9.6 was released April 3, 2026. Library support is still rolling out:

| Library | Status |
|---------|--------|
| Raw HTTP API (`node-fetch` / native `fetch`) | Available immediately |
| `grammY` | Tracks API updates quickly — check latest release |
| `telegraf` | Check changelog for 9.6 type additions |
| `node-telegram-bot-api` | May require manual type augmentation |

For production use today, call the raw HTTP API directly or augment your SDK with the TypeScript types above.

---

## Manager Bot Capabilities

This section documents everything a manager bot can do — both to its managed child bots and as a regular bot in its own right.

---

### Enabling Bot Management Mode

Bot Management Mode is **not enabled via the API**. It is a one-time manual step done through BotFather's Mini App:

1. Open `https://t.me/Botfather?startapp` (the **Mini App** interface — not just `/mybots` commands)
2. Select the bot you want to designate as a manager
3. Go to **Bot Settings**
4. Enable **"Bot Management Mode"**

After enabling, `getMe` will return `can_manage_bots: true`:

```js
// Verify management mode is active
const res = await fetch(
  `https://api.telegram.org/bot${MANAGER_TOKEN}/getMe`
);
const { result } = await res.json();
console.log(result.can_manage_bots); // true
```

If `can_manage_bots` is absent or `false`, the bot cannot receive `managed_bot` updates or call `getManagedBotToken`.

---

### Child Bot Control — Full Impersonation Model

The central pattern for controlling a child bot is **direct token impersonation**. The manager calls the standard Bot API using the child bot's token. There is no special "act on behalf of" wrapper — once the manager holds the child's token, it has complete operational control.

```
Manager Bot
    │
    ├── getManagedBotToken(user_id: childBot.id)  ← manager's token
    │         └── returns: child_token
    │
    └── api.telegram.org/bot{child_token}/METHOD  ← child's token
              ├── sendMessage (AS the child)
              ├── setWebhook  (configure child's updates)
              ├── setMyCommands (configure child's commands)
              └── ... any Bot API method
```

```js
const MANAGER_TOKEN = process.env.MANAGER_BOT_TOKEN;
const CHILD_TOKEN   = await getManagedBotToken(childBotId);

// Send a message AS the child bot
await fetch(`https://api.telegram.org/bot${CHILD_TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: userTelegramId,
    text: 'Hello from your personal bot!',
  }),
});

// Point the child bot's updates to your infrastructure
await fetch(`https://api.telegram.org/bot${CHILD_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: `https://yourapp.com/webhook/child/${childBotId}`,
    allowed_updates: ['message', 'callback_query'],
    secret_token: process.env.CHILD_WEBHOOK_SECRET,
  }),
});
```

> Each child bot uses its **own rate limit bucket** (30 messages/sec) — separate from the manager's bucket and from other children. This is the correct architecture for per-user bots at scale.

---

### Messaging

All send methods work when called with the child bot's token. The child bot appears as the sender.

| Method | Description |
|--------|-------------|
| `sendMessage` | Send text messages |
| `sendPhoto` / `sendVideo` / `sendAudio` | Send media files |
| `sendDocument` / `sendVoice` / `sendVideoNote` | Send documents and voice |
| `sendSticker` / `sendAnimation` | Send stickers and GIFs |
| `sendLocation` / `sendVenue` / `sendContact` | Send location and contact cards |
| `sendDice` | Send animated dice |
| `sendMediaGroup` | Send an album of photos/videos |
| `sendPoll` | Send polls and quizzes |
| `sendInvoice` | Send payment invoices |
| `sendGame` | Send HTML5 games |
| `forwardMessage` / `copyMessage` | Forward or silently copy messages |
| `editMessageText` / `editMessageCaption` / `editMessageMedia` | Edit previously sent messages |
| `editMessageReplyMarkup` | Edit inline keyboards on sent messages |
| `deleteMessage` | Delete a message the child bot sent |
| `sendChatAction` | Show "typing…" or "uploading…" indicator |

```js
// Send a poll as the child bot
await fetch(`https://api.telegram.org/bot${CHILD_TOKEN}/sendPoll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: userTelegramId,
    question: 'How are you today?',
    options: [
      { text: 'Great' },
      { text: 'Okay' },
      { text: 'Not great' },
    ],
    is_anonymous: false,
  }),
});
```

---

### Profile and Identity Management

The manager can fully customize how each child bot appears to users.

| Method | Description |
|--------|-------------|
| `setMyName` | Set the child bot's display name |
| `setMyDescription` | Set the "What can this bot do?" description shown to new users |
| `setMyShortDescription` | Set the short bio visible on the bot's profile |
| `setMyProfilePhoto` | Set the child bot's profile picture *(Bot API 9.4+)* |
| `removeMyProfilePhoto` | Remove the child bot's profile picture *(Bot API 9.4+)* |

```js
// Personalise the child bot for a specific user
async function personaliseChildBot(childToken, ownerFirstName) {
  const base = `https://api.telegram.org/bot${childToken}`;

  await fetch(`${base}/setMyName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${ownerFirstName}'s AI Agent` }),
  });

  await fetch(`${base}/setMyDescription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: `This is ${ownerFirstName}'s personal AI bot powered by Animocamind.`,
    }),
  });
}
```

---

### Bot Behavior Settings

| Method | Description |
|--------|-------------|
| `setMyCommands` | Register the child bot's command list (shown when user types `/`) |
| `deleteMyCommands` | Remove commands by scope/language |
| `getMyCommands` | Read the child's current command configuration |
| `setChatMenuButton` | Configure the menu button displayed next to the input field |
| `getChatMenuButton` | Read current menu button config |
| `setMyDefaultAdministratorRights` | Set default admin rights when child is added to groups/channels |
| `getMyDefaultAdministratorRights` | Read current default admin rights |

```js
// Set up commands for the child bot
await fetch(`https://api.telegram.org/bot${CHILD_TOKEN}/setMyCommands`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    commands: [
      { command: 'start',    description: 'Start the bot' },
      { command: 'help',     description: 'Show help' },
      { command: 'settings', description: 'Manage your settings' },
    ],
  }),
});
```

---

### Webhook and Update Configuration

Each child bot needs its own webhook so your infrastructure can receive its updates independently.

```js
// Point each child bot's updates to a per-bot endpoint
async function configureChildWebhook(childToken, childBotId) {
  const res = await fetch(
    `https://api.telegram.org/bot${childToken}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `https://yourapp.com/webhook/bot/${childBotId}`,
        allowed_updates: ['message', 'callback_query', 'inline_query'],
        secret_token: process.env.CHILD_WEBHOOK_SECRET,
        max_connections: 40,
      }),
    }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`setWebhook failed: ${data.description}`);
}
```

| Method | Description |
|--------|-------------|
| `setWebhook` | Register a webhook URL for the child's incoming updates |
| `deleteWebhook` | Remove the child's webhook |
| `getWebhookInfo` | Inspect the child's webhook status and any delivery errors |
| `getUpdates` | Poll for updates (mutually exclusive with webhook) |
| `getMe` | Get the child's `User` object — useful to confirm identity after provisioning |
| `logOut` | Log the child bot out of the cloud API (forces a clean state) |
| `close` | Close connection to a local Bot API server |

---

### Group and Channel Administration

If a child bot is added to a group or channel as an admin, all standard admin methods are available:

```js
// Ban a user via the child bot (if child is a group admin)
await fetch(`https://api.telegram.org/bot${CHILD_TOKEN}/banChatMember`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: groupChatId,
    user_id: offendingUserId,
    until_date: Math.floor(Date.now() / 1000) + 86400, // 24h ban
  }),
});
```

Available admin methods include: `banChatMember`, `unbanChatMember`, `restrictChatMember`, `promoteChatMember`, `setChatAdministratorCustomTitle`, `pinChatMessage`, `unpinChatMessage`, `setChatTitle`, `setChatDescription`, `setChatPhoto`, `exportChatInviteLink`, and more.

---

### Bot-to-Bot Communication

Introduced alongside Bot API 9.6, this feature lets bots exchange messages — useful for multi-agent workflows between the manager and its child bots.

#### Enabling

Enable **"Bot-to-Bot Communication Mode"** per bot in BotFather Mini App (`t.me/Botfather?startapp` → Bot Settings). There is **no API method** to toggle this — it must be done manually.

#### Rules

| Scenario | Behaviour |
|----------|-----------|
| Bot A mentions Bot B in a group (`/cmd@BotB`) | Bot B receives the message if either bot has the mode enabled |
| Bot A replies to Bot B's message in a group | Bot B receives the reply if either bot has the mode enabled |
| Bot with mode enabled + group admin rights | Receives **all** messages from other bots in the group without explicit mention |
| Bot with mode enabled + privacy mode disabled | Also receives all bot messages in groups |
| Via Business Account | A bot in Chat Access Mode can message other bots on the same business account if the sender has the mode enabled |

#### ⚠️ Mandatory Loop Prevention

Telegram **will restrict** bots that fail to prevent infinite interaction loops. Implement all three:

```js
// Recommended safeguards in your bot-to-bot message handler
const lastReplyTime = new Map(); // botId → timestamp
const interactionDepth = new Map(); // threadId → depth

function shouldReply(fromBotId, threadId) {
  // 1. Rate limit: max 1 reply per 3 seconds per bot
  const last = lastReplyTime.get(fromBotId) ?? 0;
  if (Date.now() - last < 3000) return false;

  // 2. Max depth: stop after 10 hops in a thread
  const depth = interactionDepth.get(threadId) ?? 0;
  if (depth >= 10) return false;

  lastReplyTime.set(fromBotId, Date.now());
  interactionDepth.set(threadId, depth + 1);
  return true;
}
```

---

### Token Management Patterns

#### Proactive Token Rotation on Creation

The human user who created the managed bot retains BotFather-level ownership and could regenerate the token themselves via BotFather, breaking your manager's access. To prevent this, **immediately rotate the token after provisioning**:

```js
async function onManagedBotCreated(update) {
  const { user, bot } = update.managed_bot;

  // 1. Get initial token
  const initialToken = await getManagedBotToken(bot.id);

  // 2. Immediately rotate — the user never holds this token
  //    (replaceManagedBotToken also triggers a new managed_bot update)
  const stableToken = await rotateManagedBotToken(bot.id);

  // 3. Store only the rotated token
  await db.managedBots.create({
    owner_telegram_id: user.id,
    bot_id: bot.id,
    bot_username: bot.username,
    bot_token: encrypt(stableToken), // always encrypt tokens at rest
  });

  // 4. Configure the child bot using the stable token
  await configureChildWebhook(stableToken, bot.id);
  await personaliseChildBot(stableToken, user.first_name);
}
```

#### Handling Token Change Events

`replaceManagedBotToken` triggers a new `ManagedBotUpdated` update. Handle it alongside the initial creation event:

```js
app.post('/webhook/telegram', express.json(), async (req, res) => {
  const { managed_bot } = req.body;

  if (managed_bot) {
    const { user, bot } = managed_bot;

    const newToken = await getManagedBotToken(bot.id);

    // Covers creation, token rotation, and ownership transfers
    await db.managedBots.upsert({
      where: { bot_id: bot.id },
      update: {
        owner_telegram_id: user.id,   // owner may have changed
        bot_token: encrypt(newToken),
        updated_at: new Date(),
      },
      create: {
        owner_telegram_id: user.id,
        bot_id: bot.id,
        bot_username: bot.username,
        bot_token: encrypt(newToken),
        created_at: new Date(),
      },
    });

    // Reconfigure webhook with new token
    await configureChildWebhook(newToken, bot.id);
  }

  res.sendStatus(200);
});
```

---

### Child Bot Ownership Model

There are two distinct ownership layers:

| Layer | Owner | Controls |
|-------|-------|---------|
| **Telegram account ownership** | The human user who clicked "Create" | BotFather access, ownership transfer, manual token reset |
| **Operational control** | The manager bot | Holds and manages the token, configures webhook, sends messages |

**Key implications:**

- The human user appears as the registered BotFather owner — they could go to BotFather, find the bot in `/mybots`, and regenerate its token. This would break the manager's connection until `getManagedBotToken` is called again (the manager always gets the current token via its API).
- Ownership can be transferred via BotFather. When this happens, your manager receives a `ManagedBotUpdated` update where `user` will reflect the new owner. Store `bot_id` (permanent) not just the token.
- Storing `bot.id` is critical — it is the permanent identifier for `getManagedBotToken` calls regardless of token rotations or ownership changes.

```js
// Always key your records on bot_id, not the token
const childBotRecord = {
  bot_id:            bot.id,        // permanent — use this for getManagedBotToken
  bot_username:      bot.username,  // can change
  owner_telegram_id: user.id,       // can change (ownership transfer)
  bot_token:         encrypt(token), // can change (rotation)
};
```

---

### Limits and Quotas

| Constraint | Value |
|-----------|-------|
| Bot API rate limit per child bot | 30 messages/sec (each child has its own bucket) |
| Messages to the same chat | 1 message/sec |
| Manager's own API rate limit | Separate bucket from all children |
| Webhook connections per bot | 1–100 (up to 100,000 with a local Bot API server) |
| Bot username length | 5–32 characters, must end in `bot` |
| User's BotFather bot quota | 20 bots per account |
| Max managed bots per manager | **Not officially documented** |
| Managed bots vs BotFather quota | **Not officially documented** — test empirically |

> Architecture note: because each child bot has its own rate limit bucket, the managed bot model scales naturally. A platform with 1,000 users each having their own bot is 1,000 independent rate limit buckets — not 1,000 users sharing a single bot's limits.

---

### What the Manager Cannot Do

| Limitation | Notes |
|-----------|-------|
| **Delete a child bot** | No API method exists. Only the BotFather UI owner can delete a bot. |
| **Create a bot silently** | User confirmation is always required — no headless creation. |
| **Enable Bot-to-Bot Communication Mode via API** | BotFather Mini App only — no programmatic toggle. |
| **Enable Bot Management Mode via API** | BotFather Mini App only. |
| **See messages the child bot receives without a webhook** | Must configure a webhook (or polling) on the child bot to receive its updates. |
| **Access another manager's child bots** | `getManagedBotToken` only works for bots managed by the calling manager. |

---

## Full User Journey

```
1. User visits Animocamind and clicks "Login with Telegram"
        │
        ▼
2. Telegram popup opens — user confirms login
        │
        ▼
3. Browser receives auth data → POST /api/auth/telegram
        │
        ▼
4. Backend verifies HMAC-SHA256 hash + auth_date freshness
        │
        ├── Invalid → 401 Unauthorized
        │
        └── Valid → user record created/updated in DB
                │
                ▼
        5. Backend responds with managed bot deep link
                │
                ▼
        6. User opens deep link in Telegram app
                │
                ▼
        7. User completes guided bot creation (name + username)
                │
                ▼
        8. Manager bot receives ManagedBotUpdated webhook
                │
                ▼
        9. Backend calls getManagedBotToken → stores token
                │
                ▼
        10. User's personal bot is live and ready
```

---

## API Reference

### Manager Bot — Lifecycle Methods

| Method | Token Used | Description |
|--------|-----------|-------------|
| `getMe` | Manager | Check `can_manage_bots` capability |
| `setWebhook` | Manager | Subscribe to `managed_bot` updates (include in `allowed_updates`) |
| `getWebhookInfo` | Manager | Verify webhook is configured correctly |
| `getManagedBotToken` | Manager | Retrieve a child bot's current API token (`user_id` = child bot's ID) |
| `replaceManagedBotToken` | Manager | Rotate a child bot's token — old token immediately invalidated |
| `savePreparedKeyboardButton` | Manager | Pre-store a `request_managed_bot` button for Mini App flows |

### Child Bot — Control Methods (called with child's token)

#### Messaging
| Method | Description |
|--------|-------------|
| `sendMessage` | Send text |
| `sendPhoto` / `sendVideo` / `sendAudio` / `sendDocument` | Send media |
| `sendVoice` / `sendVideoNote` / `sendSticker` / `sendAnimation` | Send voice and stickers |
| `sendLocation` / `sendVenue` / `sendContact` / `sendDice` | Send location, contacts, dice |
| `sendMediaGroup` | Send albums |
| `sendPoll` | Send polls and quizzes |
| `sendInvoice` | Send payment invoices |
| `sendGame` | Send HTML5 games |
| `sendChatAction` | Typing/uploading indicators |
| `forwardMessage` / `copyMessage` | Forward or silently copy |
| `editMessageText` / `editMessageCaption` / `editMessageMedia` / `editMessageReplyMarkup` | Edit sent messages |
| `deleteMessage` | Delete sent messages |

#### Profile and Configuration
| Method | Description |
|--------|-------------|
| `setMyName` | Set child bot display name |
| `setMyDescription` | Set "What can this bot do?" text |
| `setMyShortDescription` | Set profile bio |
| `setMyProfilePhoto` | Set profile photo *(API 9.4+)* |
| `removeMyProfilePhoto` | Remove profile photo *(API 9.4+)* |
| `setMyCommands` / `deleteMyCommands` / `getMyCommands` | Manage command list |
| `setChatMenuButton` / `getChatMenuButton` | Configure menu button |
| `setMyDefaultAdministratorRights` | Set default admin rights |

#### Webhook and Updates
| Method | Description |
|--------|-------------|
| `setWebhook` | Set child bot's webhook URL |
| `deleteWebhook` | Remove child bot's webhook |
| `getWebhookInfo` | Check child bot's webhook status |
| `getUpdates` | Poll for child bot updates (alternative to webhook) |
| `getMe` | Get child bot's `User` object |
| `logOut` | Log child bot out of cloud API |

### Internal Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/telegram` | `POST` | Receives and verifies Telegram Login Widget auth data |
| `/webhook/telegram` | `POST` | Receives manager bot updates (`managed_bot`, `message`, etc.) |
| `/webhook/bot/:botId` | `POST` | Receives individual child bot updates (one per child) |

---

## Limitations

| Limitation | Details |
|------------|---------|
| No headless bot creation | User must always confirm bot creation in the Telegram app — fully silent creation is not supported |
| No child bot deletion via API | Only the BotFather UI owner can delete a bot — no `deleteBot` API method exists |
| Bot Management Mode is manual | Must be enabled through BotFather Mini App — no API method to toggle it |
| Bot-to-Bot Communication Mode is manual | Must be enabled through BotFather Mini App — no API method to toggle it |
| Domain binding required | The Login Widget only works on domains registered with `/setdomain` in BotFather |
| `auth_date` not enforced by Telegram | Your backend must reject stale tokens (recommended: 5 min window) |
| Webhook ports | Only ports `443`, `80`, `88`, and `8443` are accepted by Telegram |
| Manager bot capability | The manager bot must have `can_manage_bots: true` — enabled in BotFather Mini App |
| Bot username rules | Usernames must be unique across Telegram, 5–32 chars, must end in `bot` |
| Max managed bots per manager | Not officially documented — test empirically or contact @BotSupport |
| BotFather quota interaction | Unclear whether managed bots count against the user's 20-bot BotFather limit |
| User retains BotFather ownership | The human user can regenerate the child bot's token via BotFather — mitigate with proactive token rotation on creation |
| No cross-manager sharing | `getManagedBotToken` only works for bots managed by the calling manager bot |
