# ONEXAI Intelligence

ONEXAI is a browser based chat and voice assistant for Ali and Hamza. It keeps the existing LiveKit Python agent and React client, and adds server verified accounts, persistent SQLite conversations, and Gemini text chat. LiveKit and Google credentials stay on the Python server.

## Start ONEXA locally

Copy `.env.example` to `.env.local`. Configure the LiveKit values and `GOOGLE_API_KEY`; the key stays in the backend file and must never be copied into frontend environment variables. The default chat model is `gemini-3.8-flash` and can be changed with `GEMINI_MODEL`.

Create the two password protected accounts once from the project root. Passwords are prompted securely and stored using salted scrypt hashes:

```powershell
uv run python src/setup_users.py
```

Open three PowerShell terminals in the project root and run:

1. Start the existing LiveKit agent:

   ```powershell
   & "C:\Users\a3454\AppData\Local\Microsoft\WinGet\Packages\LiveKit.LiveKitCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\lk.exe" agent dev --deployment onexa-dev
   ```

2. Start the local token service:

   ```powershell
   uv run python src/token_server.py
   ```

3. Start the React app:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

Open the local URL printed by Vite, normally `http://localhost:5173`, and sign in as Ali or Hamza. Use **New chat** for streamed Gemini text chat or **Start voice session** to connect to the existing LiveKit agent. Allow microphone access when prompted. A voice conversation can be reopened from history and continued in chat.

The worker and token service use the same stable, named development deployment, `onexa-dev`. `lk agent dev` otherwise creates a new random `dev-*` deployment, while dispatches that omit a deployment target `production`; that mismatch leaves the browser room open without an agent. The token service now includes the configured deployment in its automatic room dispatch, and `/health` reports the configured target without exposing credentials. A successful room connection is not counted as an agent connection: the frontend waits for the agent participant.

The token service binds to `127.0.0.1:3000`, requires a server verified HTTP-only session cookie, and allows browser requests only from local Vite origins. It creates a random room per session and dispatches the existing `my-agent` to that room. The local SQLite database is stored at `data/onexai.sqlite3`; override it with `ONEXA_DATABASE_PATH`. Set `COOKIE_SECURE=true` when serving over HTTPS.

## Current scope

- Browser voice connection to the existing LiveKit agent.
- Independent Ali/Hamza accounts with salted scrypt password hashes and revocable server-side sessions.
- Short-lived LiveKit room credentials created server-side.
- Owner scoped SQLite conversations and ordered chat/voice messages, search, pagination, and deletion.
- Gemini streamed chat through a backend provider interface.
- LiveKit transcript segment persistence into the same conversation and message store used by chat.
- Long term personal memory, shared business knowledge, wake word, and Excel/CRM tools remain future work.

## Tests and checks

From the project root:

```powershell
uv run pytest -q
uv run ruff check
uv run ruff format --check
```

From `frontend`:

```powershell
npm run build
npm run lint
```

The existing LiveKit starter also includes cloud based conversation simulations in `scenarios.yaml`; those require the authenticated LiveKit CLI and use inference services.

## Existing voice stack

The agent in `src/agent.py` retains LiveKit Inference Gemma 4 31B, AssemblyAI realtime transcription, Fish Audio speech, LiveKit turn detection, expressive audio, and AIcoustics noise cancellation. The ONEXA instructions are already part of that agent. The browser client does not replace those services.

## Gemini model

The backend adapter uses Google’s documented Gemini streaming REST endpoint. Google currently lists stable `gemini-3.8-flash` with text output support; the model is configurable using `GEMINI_MODEL`. See [Gemini model details](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) and the [streaming text API](https://ai.google.dev/gemini-api/docs/text-generation).
