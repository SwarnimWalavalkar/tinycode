import WebSocket from "ws";
import assert from "node:assert/strict";
const bootstrap = await (await fetch("http://127.0.0.1:4738/api/bootstrap")).json();
const task = bootstrap.tasks.find((t) => t.cwd.endsWith("smoke-project"));
assert(task, "Run the disposable harness smoke fixture first");
async function attach() {
  const ws = new WebSocket("ws://127.0.0.1:4738/socket", { origin: "http://127.0.0.1:4738" });
  let terminalId;
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Terminal attach timed out")), 10000);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "error") reject(new Error(m.message));
      if (m.type === "terminal.ready") {
        terminalId = m.terminalId;
        clearTimeout(timeout);
        resolve();
      }
      if (m.type === "terminal.output") output += m.data;
    });
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "terminal.create", taskId: task.id, cols: 80, rows: 20 }));
  await ready;
  return { ws, terminalId, output: () => output };
}
const first = await attach();
first.ws.send(
  JSON.stringify({
    type: "terminal.input",
    terminalId: first.terminalId,
    data: "export TINYCODE_SMOKE=survived\r",
  }),
);
await new Promise((r) => setTimeout(r, 300));
first.ws.close();
const second = await attach();
assert.equal(second.terminalId, first.terminalId);
second.ws.send(
  JSON.stringify({
    type: "terminal.input",
    terminalId: second.terminalId,
    data: "printf '__RESULT__%s\\n' \"$TINYCODE_SMOKE\"\r",
  }),
);
const deadline = Date.now() + 5000;
while (!second.output().includes("__RESULT__survived") && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 100));
assert(second.output().includes("__RESULT__survived"), second.output());
second.ws.send(
  JSON.stringify({ type: "terminal.resize", terminalId: second.terminalId, cols: 100, rows: 30 }),
);
second.ws.send(JSON.stringify({ type: "terminal.close", terminalId: second.terminalId }));
second.ws.close();
console.log(
  "PASS: server-owned shell, same PTY after reconnect, environment preserved, input/output, resize, explicit close",
);
