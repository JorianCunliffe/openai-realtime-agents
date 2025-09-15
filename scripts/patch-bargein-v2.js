const fs = require('fs');
const file = 'scripts/next-ws-server.ts';
let s = fs.readFileSync(file, 'utf8');

function ensure(afterAnchor, snippet) {
  if (s.includes(snippet.trim())) return;
  const i = s.indexOf(afterAnchor);
  if (i < 0) throw new Error('Anchor not found: ' + afterAnchor.slice(0, 80));
  s = s.slice(0, i + afterAnchor.length) + snippet + s.slice(i + afterAnchor.length);
}

function replaceRx(rx, add, checkRx) {
  if (checkRx && checkRx.test(s)) return;
  s = s.replace(rx, m => m + add);
}

// 1) Add flags next to your existing barge-in state
ensure(
  'const SHOW_TIMING_MATH = false',
  `;\n    let isInterrupted = false;                    // stop forwarding old TTS after barge-in\n    let lastResponseId: string | null = null;     // track in-flight response id\n`
);

// 2) Track response.created and resume after interrupt
replaceRx(
  /session\.socket\.on\("message",\s*\(raw\)\s*=>\s*\{\s*try\s*\{\s*const evt = JSON\.parse\(raw\.toString\(\)\);\s*/m,
  `\n              // Track new responses so we can resume after an interrupt\n              if (evt.type === "response.created") {\n                lastResponseId = evt.response?.id ?? evt.id ?? null;\n                isInterrupted = false; // a fresh response can be forwarded again\n              }\n`,
  /isInterrupted\s*=\s*false;[\s\S]*response\.created/
);

// 3) In audio delta branch, avoid forwarding when interrupted and keep response_id
replaceRx(
  /if \(streamSid && evt\.type === "response\.audio\.delta" && typeof evt\.delta === "string"\) \{\s*/m,
  `if (isInterrupted) return;\n`,
  /if \(isInterrupted\) return;/
);

// If deltas don’t already capture response_id, add it just after tracking item_id
s = s.replace(
  /if \(typeof evt\.item_id === "string"\)\s*{\s*lastAssistantItem = evt\.item_id;\s*}\s*/m,
  (m) => m + `\n                if (typeof evt.response_id === "string") lastResponseId = evt.response_id;\n`
);

// 4) Ensure speech_started cancels in-flight response before truncate/clear
s = s.replace(
  /const handleSpeechStartedEvent = \(\) => \{\s*/m,
  (m) => m +
`            // mark we're interrupting and cancel the in-flight response at the model
            isInterrupted = true;
            if (lastResponseId) {
              session?.socket.send(JSON.stringify({
                type: "response.cancel",
                response_id: lastResponseId
              }));
            }
`
);

// 5) (Optional) double-clear, commented out; keep for quick enable
if (!/optional extra flush/.test(s)) {
  s = s.replace(
    /ws\.send\(JSON\.stringify\(\{ event: "clear", streamSid \}\)\);\s*\/\/ Reset barge-in state/m,
    `ws.send(JSON.stringify({ event: "clear", streamSid }));
              // (optional extra flush)
              // setTimeout(() => ws.send(JSON.stringify({ event: "clear", streamSid })), 50);
              // Reset barge-in state`
  );
}

fs.writeFileSync(file, s, 'utf8');
console.log('Applied barge-in v2 edits to', file);
