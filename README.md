# EduChat 💬

A real-time chat web app built with Firebase Firestore + WebRTC.

## Features
- 🔐 Firebase Authentication (Google Sign-In)
- 💬 Real-time direct messaging
- 👥 Group chats with add/leave member support
- 📞 Voice & video calls via WebRTC
- 🔔 Toast notifications for messages, friend requests & group activity
- 🔊 Ping sound for messages (`ping.mp3`) — add `ring.mp3` for call ringtones
- 🌙 Dark mode
- 👤 Presence (online / away / offline)
- 😊 Emoji picker
- ↩️ Message reply & reactions

## Setup

1. **Clone / download** this repo
2. Open `index.html` in a browser (or deploy via GitHub Pages)
3. Firebase is pre-configured — no extra setup needed for the demo project

## Adding Sound Files

| File | Purpose |
|------|---------|
| `ping.mp3` | Message & notification sound (already included) |
| `ring.mp3` | Incoming call ringtone — **add this file yourself** |

## Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Then go to **Settings → Pages → Source: main branch** and save.

## Tech Stack
- HTML / CSS / Vanilla JS
- Firebase (Auth, Firestore)
- WebRTC (peer-to-peer calls)
