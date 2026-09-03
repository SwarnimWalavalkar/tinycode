import { useRef, useState, type PointerEvent } from "react";
import { ArrowUp, CornerDownRight, ListEnd, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import type { QueuedMessage } from "../shared/contracts";
import { MessageImages } from "./Images";
import { post } from "./state";

const label = (message: QueuedMessage) =>
  message.text ||
  (message.images?.length === 1 ? "Image" : `${message.images?.length ?? 0} images`);

function move(messages: QueuedMessage[], id: string, beforeId: string | null) {
  const message = messages.find((message) => message.id === id);
  if (!message || message.status === "sending" || beforeId === id) return messages;
  const movable = messages.filter((message) => message.status !== "sending" && message.id !== id);
  const index =
    beforeId === null ? movable.length : movable.findIndex((message) => message.id === beforeId);
  if (index < 0) return messages;
  movable.splice(index, 0, message);
  let next = 0;
  return messages.map((message) => (message.status === "sending" ? message : movable[next++]));
}

export default function MessageQueue({
  taskId,
  messages,
  busy,
  canSteer,
  disabled,
  editingId,
  onEdit,
}: {
  taskId: string;
  messages: QueuedMessage[];
  busy: boolean;
  canSteer: boolean;
  disabled: boolean;
  editingId: string | null;
  onEdit: (message: QueuedMessage) => void;
}) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [optimistic, setOptimistic] = useState<{
    base: QueuedMessage[];
    order: QueuedMessage[];
  } | null>(null);
  const dragTarget = useRef<{ id: string; beforeId: string | null } | null>(null);
  const gesture = useRef<{ id: string; startY: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; beforeId: string | null } | null>(null);
  const ordered = optimistic?.base === messages ? optimistic.order : messages;
  const locked = disabled || pending || editingId !== null;

  async function act(action: string, input: object = {}) {
    if (inFlight.current || disabled) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await post(`/tasks/${taskId}/queue/${action}`, input);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  async function reorder(id: string, beforeId: string | null) {
    if (locked || inFlight.current) return;
    const order = move(messages, id, beforeId);
    if (order.every((message, index) => message.id === messages[index].id)) return;
    setOptimistic({ base: messages, order });
    if (await act("move", { id, beforeId })) {
      setAnnouncement(
        `Message moved to position ${order.findIndex((message) => message.id === id) + 1}.`,
      );
    } else setOptimistic(null);
  }
  function stopDrag() {
    gesture.current = null;
    dragTarget.current = null;
    setDrag(null);
  }
  function dragMove(event: PointerEvent<HTMLButtonElement>) {
    const started = gesture.current;
    if (!started || locked || (Math.abs(event.clientY - started.startY) < 4 && !dragTarget.current))
      return;
    const list = event.currentTarget.closest(".queue-list")!;
    const bounds = list.getBoundingClientRect();
    if (event.clientY < bounds.top + 20) list.scrollTop -= 10;
    else if (event.clientY > bounds.bottom - 20) list.scrollTop += 10;
    const next = Array.from(list.querySelectorAll<HTMLElement>(".queue-entry")).find((row) => {
      if (row.dataset.id === started.id || row.dataset.sending === "true") return false;
      const rect = row.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    dragTarget.current = { id: started.id, beforeId: next?.dataset.id ?? null };
    setDrag(dragTarget.current);
  }
  if (!messages.length && !error) return null;
  return (
    <div className="message-queue" aria-label="Queued messages">
      <span className="queue-announcement" role="status">
        {announcement}
      </span>
      {!busy && messages.length > 0 && (
        <div className="queue-heading">
          <span>{messages.length} queued</span>
          <button disabled={locked || !!drag} onClick={() => void act("resume")}>
            <ArrowUp size={13} /> Send next
          </button>
        </div>
      )}
      <div className="queue-list">
        {ordered.map((message, index) => (
          <div
            data-id={message.id}
            data-sending={message.status === "sending"}
            className={`queue-entry${editingId === message.id ? " queue-editing" : ""}${drag?.id === message.id ? " queue-dragging" : ""}${drag?.beforeId === message.id ? " queue-drop-before" : ""}${drag && drag.beforeId === null && index === ordered.length - 1 ? " queue-drop-after" : ""}`}
            key={message.id}
          >
            <div className="queue-row">
              <button
                className="queue-handle"
                aria-label={`Reorder queued message: ${label(message).slice(0, 60)}`}
                title="Drag to reorder. Or use Alt + Up / Down."
                disabled={locked || message.status === "sending"}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  gesture.current = { id: message.id, startY: event.clientY };
                }}
                onPointerMove={dragMove}
                onPointerUp={(event) => {
                  const target = dragTarget.current;
                  const bounds = event.currentTarget
                    .closest(".queue-list")!
                    .getBoundingClientRect();
                  if (
                    target &&
                    event.clientX >= bounds.left - 16 &&
                    event.clientX <= bounds.right + 16 &&
                    event.clientY >= bounds.top - 16 &&
                    event.clientY <= bounds.bottom + 16
                  ) {
                    void reorder(target.id, target.beforeId);
                  }
                  stopDrag();
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={stopDrag}
                onLostPointerCapture={stopDrag}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    stopDrag();
                    return;
                  }
                  if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  event.preventDefault();
                  const movable = ordered.filter((message) => message.status !== "sending");
                  const position = movable.findIndex((candidate) => candidate.id === message.id);
                  if (event.key === "ArrowUp" && position > 0)
                    void reorder(message.id, movable[position - 1].id);
                  if (event.key === "ArrowDown" && position < movable.length - 1)
                    void reorder(message.id, movable[position + 2]?.id ?? null);
                }}
              >
                {message.status === "sending" ? (
                  <LoaderCircle size={14} className="spin" aria-label="Delivering message" />
                ) : (
                  <ListEnd size={15} />
                )}
              </button>
              <MessageImages images={message.images} compact />
              <details className="queue-message">
                <summary title={message.text}>{label(message)}</summary>
                <div>
                  <MessageImages images={message.images} />
                  {message.text}
                </div>
              </details>
              {busy && canSteer && (
                <button
                  className="queue-steer"
                  disabled={locked || !!drag || message.status === "sending"}
                  title="Send into the current turn"
                  onClick={() => void act("steer", { id: message.id })}
                >
                  <CornerDownRight size={14} />
                  <span>Steer</span>
                </button>
              )}
              <button
                className="queue-edit"
                aria-label={`Edit queued message: ${label(message).slice(0, 60)}`}
                title="Edit message"
                disabled={locked || !!drag || message.status === "sending"}
                onClick={() => {
                  setError(null);
                  onEdit(message);
                }}
              >
                <Pencil size={14} />
              </button>
              <button
                className="queue-remove"
                aria-label={`Remove queued message: ${message.text.slice(0, 60) || message.images?.[0]?.name || "Image"}`}
                title="Remove message"
                disabled={locked || !!drag || message.status === "sending"}
                onClick={() => void act("remove", { id: message.id })}
              >
                <Trash2 size={14} />
              </button>
            </div>
            {message.error && (
              <div className="queue-error" role="status">
                {message.error}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && (
        <div className="queue-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
