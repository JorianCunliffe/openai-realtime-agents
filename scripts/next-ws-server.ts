/* eslint-disable no-console */
import http from "http";
import { parse as parseUrl } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";

// ---- Realtime config ----
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.REALTIME_VOICE || "alloy";
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY missing");
}

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

type UserCtx = { userId: string; callSid?: string; streamSid?: string };

type StartFrame = {
  event: "start";
  start: { accountSid: string; streamSid: string; callSid: string; tracks?: string[] };
  streamSid: string;
};
type MediaFrame = { event: "media"; media: { payload: string; timestamp?: number }; streamSid: string };
type StopFrame = { event: "stop"; streamSid: string };
type MarkFrame = { event: "mark"; mark: { name: string }; streamSid: string };

// --- OpenAI Realtime session factory ---
async function createRealtimeSession(ctx: UserCtx): Promise<{
  socket: WebSocket;
  close: () => Promise<void>;
  sendAudio: (b64: string) => void;
}> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }
  const rt = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let open = false;
  let hasAudioInBuffer = false;
  let silenceTimer: NodeJS.Timeout | null = null;

  // Diagnostics
  let commitCount = 0;
  let deltaCount = 0;
  console.log("[Realtime] init", { model: REALTIME_MODEL, userId: ctx.userId, callSid: ctx.callSid });

  const commitNow = () => {
    if (!open || !hasAudioInBuffer) return;
    hasAudioInBuffer = false;
    commitCount++;
    console.log("[Realtime] commit#", commitCount);
    try {
      rt.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      rt.send(JSON.stringify({ type: "response.create" }));
    } catch (e) {
      console.log("[Realtime] commit send error", e);
    }
  };
  const scheduleCommit = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(commitNow, 300);
  };

  rt.on("open", () => {
    open = true;
    console.log("[Realtime] open");

    // ✅ Legacy/flat session payload expected by your server
    const sessionUpdate = {
      type: "session.update",
      session: {
        turn_detection: { type: "server_vad" },    // top-level
        input_audio_format: "g711_ulaw",           // Twilio PCMU in
        output_audio_format: "g711_ulaw",          // PCMU back to Twilio
        voice: VOICE,
        instructions: "You are a helpful, concise voice assistant for phone calls.",
        modalities: ["text", "audio"],             // <- legacy servers accept this
        // optional knobs if you want them:
        // temperature: 0.8,
        // tools: [...],
      },
    };

    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    rt.send(JSON.stringify(sessionUpdate));
    console.log("[Realtime] session.update sent");

    // Have the model speak first (and force dual modalities as required)
    const greeting = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Greet the caller briefly (under 5 seconds). Introduce yourself and ask how you can help." },
        ],
      },
    };
    rt.send(JSON.stringify(greeting));
    console.log("[Realtime] greeting item sent");

    rt.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"] }  // <- your server requires audio+text (not audio-only)
    }));
    console.log("[Realtime] response.create (greeting) sent");
  });



  rt.on("error", (e) => console.log("[Realtime] error", e));
  rt.on("close", (code, reason) => {
    open = false;
    console.log("[Realtime] close", code, reason?.toString());
  });

  return {
    socket: rt,
    sendAudio: (b64: string) => {
      if (!open) return;
      try {
        rt.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        hasAudioInBuffer = true;
        scheduleCommit();
      } catch (e) {
        console.log("[Realtime] append error", e);
      }
    },
    close: async () => {
      try {
        commitNow();
        rt.close();
      } catch (e) {
        console.log("[Realtime] close error", e);
      }
    },
  };
}

async function main() {
  await app.prepare();

  // Create one HTTP server for both Next requests and WS upgrades
  const server = http.createServer(async (req, res) => {
    if (!req.url) return;
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    return handle(req, res, parseUrl(req.url, true));
  });

  const wss = new WebSocketServer({
    noServer: true,
    // Twilio may or may not send Sec-WebSocket-Protocol: audio
    handleProtocols: (protocols: Set<string>, _req) => (protocols.has("audio") ? "audio" : false),
  });

  wss.on("connection", (ws: WebSocket, _request: http.IncomingMessage, userCtx: UserCtx) => {
    console.log(`[WS] Connected: userId=${userCtx.userId}`);
    let session: Awaited<ReturnType<typeof createRealtimeSession>> | null = null;
    let streamSid: string | null = null;

    // Twilio media diagnostics
    let mediaCount = 0;
    let firstMediaAt: number | null = null;
    let bytesAccum = 0;
    let lastRateAt = Date.now();

    ws.on("message", async (data) => {
      let msg: { event: string; [k: string]: any };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.warn("[WS] non-JSON frame");
        return;
      }

      switch (msg.event) {
        case "start": {
          const s = msg as StartFrame;
          userCtx.callSid = s.start.callSid;
          userCtx.streamSid = s.streamSid;
          streamSid = s.streamSid;
          console.log("[Twilio][start]", { callSid: s.start.callSid, streamSid: s.streamSid, tracks: s.start.tracks });
          session = await createRealtimeSession(userCtx);

          // Model → Twilio: forward audio deltas, with counters
          // Model → Twilio: forward audio deltas, with counters
          let deltaCount = 0;
          session.socket.on("message", (raw) => {
            try {
              const evt = JSON.parse(raw.toString());

              // Always log event type
              console.log("[Realtime] any evt:", evt.type);

              // Show payload head for any response.* event that's not a big audio delta
              if (evt.type?.startsWith?.("response.") && evt.type !== "response.audio.delta") {
                console.log("[Realtime] response payload head:", JSON.stringify(evt).slice(0, 400));
              }

              // ✅ Forward actual audio chunks you receive
              if (streamSid && evt.type === "response.audio.delta" && typeof evt.delta === "string") {
                deltaCount++;
                if (deltaCount % 50 === 1) console.log("[Realtime] audio delta#", deltaCount, "b64len", evt.delta.length);
                ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
                if (deltaCount % 50 === 1) console.log("[Twilio<-Model] forwarded delta#", deltaCount);
          
              } else if (evt.type !== "response.output.audio.delta") {
                //log text output
                if (evt.type === "response.output_text.delta") {
                  console.log("[Realtime] text-delta:", JSON.stringify(evt, null, 2));
                }
                // log a few interesting non-delta events
                if ([
                  "session.updated",
                  "response.created",
                  "response.completed",
                  "response.content.done",
                  "error",
                  "rate_limits.updated"
                ].includes(evt.type)) {
                  console.log("[Realtime] evt", evt.type);
                }
          
                // 🔎 print full error payload if it's an error
                if (evt.type === "error") {
                  console.log("[Realtime] error payload:", JSON.stringify(evt, null, 2));
                }
              }
          
            } catch (e) {
              console.error("[Realtime] parse message err", e);
            }
          });
          break;
        }

        case "media": {
          const m = msg as MediaFrame;
          mediaCount++;
          if (!firstMediaAt) firstMediaAt = Date.now();

          // rough bitrate estimate every 2s (3/4 of base64 length ≈ bytes)
          bytesAccum += Math.floor((m.media?.payload?.length || 0) * 0.75);
          const now = Date.now();
          if (now - lastRateAt > 2000) {
            const kbps = ((bytesAccum * 8) / (now - lastRateAt)).toFixed(1);
            console.log(`[Twilio] media#${mediaCount} ~${kbps} kbps inbound, ts=${m.media?.timestamp ?? "?"}`);
            bytesAccum = 0;
            lastRateAt = now;
          }

          // Twilio → Model
          session?.sendAudio(m.media.payload);
          break;
        }

        case "mark":
          // optional timing
          break;

        case "stop": {
          const secs = firstMediaAt ? ((Date.now() - firstMediaAt) / 1000).toFixed(1) : "0";
          console.log("[Twilio][stop]", { streamSid: msg.streamSid, mediaCount, firstMediaAfterSec: secs });
          await session?.close();
          session = null;
          ws.close(1000, "done");
          break;
        }

        case "connected":
        case "dtmf":
          // ignore, but keep the log minimal if you want:
          // console.log("[Twilio]", msg.event);
          break;

        default:
          console.log("[Twilio] unknown event", msg.event);
      }
    });

    ws.on("close", async () => {
      console.log("[WS] Closed");
      await session?.close();
    });

    ws.on("error", (e) => console.error("[WS] Error", e));
  });

  server.on("upgrade", (req, socket, head) => {
    const info = {
      path: (req.url ?? "").split("?")[0],
      proto: req.headers["sec-websocket-protocol"],
      ua: req.headers["user-agent"],
    };
    console.log("[UPGRADE]", info);
    const url = parseUrl(req.url ?? "", true);
    if (url.pathname !== "/twilio-media") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const userId = String(url.query.userId ?? "guest");
    const userCtx: UserCtx = { userId };
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, userCtx);
    });
  });

  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => {
    console.log(`[NEXT+WS] Listening on :${port} (WS path: /twilio-media)`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
