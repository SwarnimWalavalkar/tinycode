import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./connection", () => ({ connection: {}, readToken: () => "token", openSocket: mocks.open }));
import { connectCloudTerminal } from "./cloud-terminal";
function fixture() {
  const sockets: any[] = [];
  mocks.open.mockImplementation(() => {
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), onopen: null, onclose: null, onmessage: null };
    sockets.push(socket);
    return socket;
  });
  const callbacks = { taskId: "task-1", output: vi.fn(), reset: vi.fn(), status: vi.fn(), exit: vi.fn() };
  return { callbacks, sockets, terminal: connectCloudTerminal(callbacks) };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("WebSocket", { OPEN: 1 }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
it("renders replay before ready, gates input, sends binary keystrokes and resize control", () => {
  const { terminal, sockets, callbacks } = fixture();
  const ws = sockets[0];
  ws.onopen();
  const bytes = new TextEncoder().encode("\x1b[32mhello").buffer;
  ws.onmessage({ data: bytes });
  terminal.write("ignored");
  terminal.resize(120, 40);
  expect(ws.send).not.toHaveBeenCalled();
  expect(callbacks.output).toHaveBeenCalledWith(new Uint8Array(bytes));
  ws.onmessage({ data: '{"type":"ready"}' });
  expect(ws.send).toHaveBeenCalledWith('{"type":"resize","cols":120,"rows":40}');
  terminal.write("\x03");
  expect(ws.send).toHaveBeenCalledWith(new TextEncoder().encode("\x03"));
  expect(mocks.open.mock.calls[0][2]).toBe("/api/tasks/task-1/terminal");
  terminal.dispose();
});
it("bounds failed reconnects and cancels retries on disposal or shell exit", async () => {
  const { terminal, sockets, callbacks } = fixture();
  for (let i = 0; i < 4; i++) { sockets[i].onclose(); await vi.runOnlyPendingTimersAsync(); }
  expect(sockets).toHaveLength(4);
  terminal.dispose();
  await vi.runAllTimersAsync();
  expect(sockets).toHaveLength(4);
  const second = fixture();
  second.sockets[0].onmessage({ data: '{"type":"exit","code":7}' });
  second.sockets[0].onclose();
  await vi.runAllTimersAsync();
  expect(second.callbacks.exit).toHaveBeenCalledWith(7);
  expect(second.sockets).toHaveLength(1);
});
