# Phone receptionist

A voice agent on [LiveKit Agents](https://docs.livekit.io/agents/) that answers a store's phone. It speaks as the business, using the store's business profile, and it can:

- tell callers what the business does, its hours and the area it serves
- offer open times and book a visit in FluentBooking
- put an urgent caller through to the owner's mobile, or take an urgent message
- save every caller in FluentCRM with a `Phone call` tag, `<service>: Interested` when they asked about one, and a call note

Each call is logged in the AnyPress API and counted against the store's monthly minutes. When the minutes run out, the receptionist still answers and takes messages but doesn't book.

## How a call gets here

1. A phone number (for example from Telnyx) is connected to your LiveKit project as an inbound SIP trunk.
2. A dispatch rule sends the trunk's calls to the agent named `anypress-receptionist`.
3. The agent reads the number that was called and asks the AnyPress API which store has it (`/voice/lines/<number>`). The platform admin gives a store its number with `PUT /admin/voice-lines/<number>` and `{ "tenantId": "...", "forwardTo": "+1..." }`.

The store needs AnyPress Client 2.14.0 or later, with FluentBooking and FluentCRM active.

## Settings

| Variable | What it is |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Your LiveKit project. Speech, the model and the voice run on LiveKit Inference with the same key. |
| `ANYPRESS_API_URL` | The AnyPress API, e.g. `https://api.anypress.io` |
| `VOICE_AGENT_TOKEN` | The same value as the API's `VOICE_AGENT_TOKEN` |
| `VOICE_STT`, `VOICE_LLM`, `VOICE_TTS` | Optional LiveKit Inference model strings. Defaults: `deepgram/nova-3`, `openai/gpt-4.1-mini`, `cartesia/sonic-3` |

## Running

```sh
npm ci
node --import tsx src/main.ts download-files   # once: the voice activity and turn models
npm run dev                                     # or: npm start
npm test
```

Or run the container from the `Dockerfile`, or deploy it to LiveKit Cloud with `lk agent create`.
