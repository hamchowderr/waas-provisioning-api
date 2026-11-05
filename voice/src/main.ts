// The phone receptionist worker. A Telnyx number's calls reach LiveKit over SIP, and LiveKit's dispatch rule sends
// each call to this agent (agent name "anypress-receptionist"). The agent finds the store by the number that was
// called, answers as that business, and logs the call when it ends.
//
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET   the LiveKit project (LiveKit Inference runs speech and the model)
//   ANYPRESS_API_URL, VOICE_AGENT_TOKEN                the AnyPress API and the phone receptionist's token
//   VOICE_LLM, VOICE_STT, VOICE_TTS                    optional model choices (LiveKit Inference model strings)
import { fileURLToPath } from 'node:url';
import { beta, cli, defineAgent, inference, type JobContext, type JobProcess, ServerOptions, voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { SipClient } from 'livekit-server-sdk';
import { VoiceApi } from './api.ts';
import { businessName, instructions } from './prompt.ts';
import { createTools, newCallState } from './tools.ts';

export const AGENT_NAME = 'anypress-receptionist';

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const api = new VoiceApi(env('ANYPRESS_API_URL'), env('VOICE_AGENT_TOKEN'));
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    const called = participant.attributes['sip.trunkPhoneNumber'] ?? '';
    const caller = participant.attributes['sip.phoneNumber'] || null;
    const line = called ? await api.line(called) : null;
    if (!line) {
      // A number no store has (or a test call from the LiveKit console): nothing to answer for.
      console.warn(`No store answers ${called || 'this call'}; hanging up.`);
      ctx.shutdown('no store for this number');
      return;
    }

    const timezone = String(line.business?.site?.timezone ?? '') || 'America/Los_Angeles';
    const state = newCallState();
    const started = Date.now();
    const sip = new SipClient(env('LIVEKIT_URL').replace(/^wss:/, 'https:'), env('LIVEKIT_API_KEY'), env('LIVEKIT_API_SECRET'));

    ctx.addShutdownCallback(async () => {
      const seconds = Math.round((Date.now() - started) / 1000);
      try {
        await api.logCall(called, { caller, seconds, outcome: state.outcome, urgent: state.urgent, summary: state.summary });
      } catch (error) {
        console.error('Could not log the call:', (error as Error).message);
      }
    });

    const tools = createTools({
      api,
      number: called,
      caller,
      timezone,
      canBook: line.minutesLeft > 0,
      state,
      transfer: async () => {
        if (!line.forwardTo) return false;
        try {
          await sip.transferSipParticipant(ctx.room.name!, participant.identity, `tel:${line.forwardTo}`, { playDialtone: true });
          return true;
        } catch (error) {
          console.error('Transfer failed:', (error as Error).message);
          return false;
        }
      },
    });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: (process.env.VOICE_STT as any) || 'deepgram/nova-3',
      llm: (process.env.VOICE_LLM as any) || 'openai/gpt-4.1-mini',
      tts: (process.env.VOICE_TTS as any) || 'cartesia/sonic-3',
      // LiveKit's audio end-of-turn model (falls back to its small local model when the cloud one can't be reached).
      turnDetection: new inference.TurnDetector(),
    });

    const agent = new voice.Agent({
      instructions: instructions(line, new Date(), timezone),
      tools: [...tools, beta.createEndCallTool({ endInstructions: 'say a short, warm goodbye', ignoreOnEnter: true })],
    });

    await session.start({ agent, room: ctx.room });
    session.generateReply({ instructions: `Greet the caller: "Thanks for calling ${businessName(line)}, how can I help?" Say only that.` });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
