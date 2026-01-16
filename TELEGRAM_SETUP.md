# Telegram Channel Integration Setup

This guide will help you set up automatic posting of KAIRO transmissions to your Telegram channel.

## Overview

Every time a new transmission cycle is generated, the system will automatically:
- Post the transmission text to your Telegram channel
- Include the video file (kairo-bg.mp4)
- Add cycle information and hashtags

## Setup Steps

### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Start a chat with BotFather and send: `/newbot`
3. Follow the prompts:
   - Choose a name for your bot (e.g., "KAIRO Bot")
   - Choose a username (must end in 'bot', e.g., "kairo_transmission_bot")
4. BotFather will give you a **Bot Token** that looks like: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`
5. **Save this token** - you'll need it for the .env file

### 2. Add Bot as Admin to Your Channel

1. Open your Telegram channel: https://t.me/your_channel
2. Go to Channel Info → Administrators
3. Click "Add Admin"
4. Search for your bot username (e.g., @kairo_transmission_bot)
5. Add the bot and give it permission to "Post Messages"

### 3. Get Your Channel ID (Optional)

Your channel ID is: `@your_channel`

If you want to use the numeric ID instead:
1. Forward a message from your channel to **@userinfobot**
2. It will reply with the channel ID (format: `-100XXXXXXXXXX`)

### 4. Configure Environment Variables

Create a `.env` file in your project root (copy from `.env.example`):

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHANNEL_ID=@your_channel
TELEGRAM_VIDEO_PATH=./public/assets/kairo-bg.mp4
TELEGRAM_VIDEO_URL=
TELEGRAM_POSTING_ENABLED=true

# Other required environment variables
ANTHROPIC_API_KEY=your_anthropic_key
OPENAI_API_KEY=your_openai_key
# ... other configs
```

**Required Variables:**
- `TELEGRAM_BOT_TOKEN` - Token from BotFather (step 1)
- `TELEGRAM_CHANNEL_ID` - Your channel (@your_channel or numeric ID)
- `TELEGRAM_VIDEO_PATH` - Path to video file (default: ./public/assets/kairo-bg.mp4)
- `TELEGRAM_VIDEO_URL` - Optional public URL for the video (recommended on Netlify)
- `TELEGRAM_POSTING_ENABLED` - Set to `true` to enable posting

### 5. Verify Video File Exists

Make sure the video file exists at: `./public/assets/kairo-bg.mp4`

If you want to use a different video:
1. Place your .mp4 file in the project
2. Update `TELEGRAM_VIDEO_PATH` in .env to point to your file
3. On Netlify, prefer `TELEGRAM_VIDEO_URL` set to your deployed asset URL (example: `https://your-site.netlify.app/assets/kairo-bot.mp4`)

### 6. Test the Integration

Start your server:
```bash
npm start
```

The next time a cycle is generated (every 5 minutes by default), it should automatically post to your Telegram channel.

To manually trigger a test cycle (requires ADMIN_KEY):
```bash
curl -X POST http://localhost:8787/api/admin/cycle \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY"
```

## Message Format

Each post will look like:
```
TRANSMISSION - CYCLE 42

[Transmission text from KAIRO]

#KAIRO #CYCLE42
```

With the kairo-bg.mp4 video attached.

## Troubleshooting

### Bot can't post to channel
- Ensure bot is added as admin with "Post Messages" permission
- Verify `TELEGRAM_CHANNEL_ID` is correct (try both @username and numeric ID)
- Check bot token is valid

### Video not attaching
- Verify file exists at path specified in `TELEGRAM_VIDEO_PATH`
- Check file size (Telegram has a 50MB limit for bot API)
- Ensure server has read permissions for the video file
- On Netlify, use `TELEGRAM_VIDEO_URL` since functions may not have local file access

### Posts not appearing
- Check `TELEGRAM_POSTING_ENABLED=true` in .env
- Check server logs for error messages
- Verify bot token and channel ID are correct

### Check Logs

Server logs will show:
- `Posted to Telegram` - Success message
- `Failed to post to Telegram` - Error with details

## Disabling Telegram Posting

To temporarily disable posting without removing the bot:

Set in `.env`:
```bash
TELEGRAM_POSTING_ENABLED=false
```

Or remove `TELEGRAM_BOT_TOKEN` from .env.

## Security Notes

- **Never commit** your `.env` file to git (it contains sensitive tokens)
- Keep your bot token secret - anyone with it can control your bot
- The bot only needs "Post Messages" permission - don't give it admin rights
- Consider using environment variables on your hosting platform instead of .env file

## Support

If you encounter issues:
1. Check server logs for error messages
2. Verify all environment variables are set correctly
3. Test bot token with BotFather using `/mybots`
4. Ensure channel is public or bot is added as admin
