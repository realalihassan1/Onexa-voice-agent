# ONEXA voice preview

ONEXA is a browser based voice assistant for Ali and Hamza. This repository keeps the existing LiveKit Python agent and adds a React browser client plus a local token service. The browser connects to the existing agent through LiveKit; LiveKit API credentials stay on the Python server.

## Start ONEXA locally

Make sure `.env.local` in the project root contains `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_AGENT_DEPLOYMENT=onexa-dev`. Keep the API key and secret in that file only; never copy them into the frontend or commit them.

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

Open the local URL printed by Vite, normally `http://localhost:5173`. Choose a name and select **Start talking**. Allow microphone access when the browser asks. ONEXA voice audio and available agent transcriptions appear in the session view. Use the microphone control to mute and **End session** to disconnect.

The worker and token service use the same stable, named development deployment, `onexa-dev`. `lk agent dev` otherwise creates a new random `dev-*` deployment, while dispatches that omit a deployment target `production`; that mismatch leaves the browser room open without an agent. The token service now includes the configured deployment in its automatic room dispatch, and `/health` reports the configured target without exposing credentials. A successful room connection is not counted as an agent connection: the frontend waits for the agent participant.

The token service binds to `127.0.0.1:3000` and allows browser requests only from the local Vite origins. It creates a random room per session and dispatches the existing `my-agent` to that same room. It is a development service, with no account authentication; do not expose it to the internet or another device. Add real authentication before deployment or network use.

## Current scope

- Browser voice connection to the existing LiveKit agent.
- Ali/Hamza display-name selection for local testing. This is not login and does not verify identity.
- Short-lived LiveKit room credentials created server-side.
- Session-only display of transcriptions when provided by the agent.
- Long-term memory, persisted conversation history, wake word, authentication, and Excel/CRM tools are not implemented yet. The UI identifies memory as unavailable and does not claim to save the conversation.

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
