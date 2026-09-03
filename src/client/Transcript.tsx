import { lazy, memo, Suspense, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  ChevronRight,
  Folder,
  Globe,
  LoaderCircle,
  Pencil,
  Search,
  TerminalSquare,
  Workflow,
  Wrench,
} from "lucide-react";
import type { Task, TimelineItem, Turn } from "../shared/contracts";
import {
  activityGroups,
  activityActions,
  activityLabel,
  completedTurn,
  elapsedTime,
  transcriptTurns,
  workLabel,
  type ActivityAction,
} from "../shared/transcript";
import { getRow, useRow, useTimeline } from "./state";

import { MessageImages } from "./Images";

const Markdown = lazy(() => import("./Markdown"));
const activityIcons = {
  read: BookOpen,
  search: Search,
  list: Folder,
  edit: Pencil,
  browser: Globe,
  command: TerminalSquare,
  agent: Workflow,
  thought: null,
  tool: Wrench,
};

function ActivityDetail({
  item,
  action,
  active,
}: {
  item: TimelineItem;
  action: ActivityAction;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Icon = activityIcons[action.type];
  const running = active && item.status === "running";
  return (
    <details
      className={`activity-row ${item.kind}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary title={action.path ?? action.target}>
        {Icon && <Icon size={14} />}
        <span>
          <span className={running ? "activity-shimmer" : undefined}>
            {action.label}
            {action.target && (
              <>
                {" "}
                <span className={action.path ? "activity-target" : ""}>{action.target}</span>
              </>
            )}
          </span>
        </span>
        {running && <LoaderCircle className="spin" size={12} />}
        {item.status === "failed" && <small>failed</small>}
      </summary>
      {open && (
        <pre>
          {item.text}
          {item.detail ? `\n\n${item.detail}` : ""}
        </pre>
      )}
    </details>
  );
}

const Row = memo(function Row({ id, active }: { id: string; active: boolean }) {
  const item = useRow(id);
  const actions = useMemo(
    () => (item ? activityActions(item) : []),
    [item?.kind, item?.title, item?.detail],
  );
  if (!item) return null;
  const running = active && item.status === "running";
  if (item.kind === "user")
    return (
      <article
        className="message user-message"
        aria-label="Your message"
        title={new Date(item.createdAt).toLocaleString()}
      >
        <MessageImages images={item.images} />
        {item.text && <p className="user-bubble">{item.text}</p>}
      </article>
    );
  if (item.kind === "assistant")
    return item.text ? (
      <article className="message assistant-message" aria-label="Assistant response">
        <div className="prose">
          {running ? (
            <div className="streaming-text">{item.text}</div>
          ) : (
            <Suspense fallback={<div className="streaming-text">{item.text}</div>}>
              <Markdown text={item.text} />
            </Suspense>
          )}
        </div>
      </article>
    ) : null;
  if (item.kind === "error")
    return (
      <div className="event-error">
        <AlertCircle size={15} />
        <pre>{item.text}</pre>
      </div>
    );
  if (item.kind === "notice") return <div className="event-notice">{item.text}</div>;
  return actions.map((action, index) => (
    <ActivityDetail key={index} item={item} action={action} active={active} />
  ));
});

function Activity({ items, active }: { items: TimelineItem[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  const type = activityActions(items.find((item) => item.kind !== "thought") ?? items[0])[0].type;
  const Icon = activityIcons[type];
  const running = active && items.some((item) => item.status === "running");
  return (
    <details className="activity-group" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {Icon && <Icon size={14} />}
        <span className={running ? "activity-shimmer" : undefined}>
          {activityLabel(items, active)}
        </span>
        <ChevronRight size={13} />
      </summary>
      {open && (
        <div className="activity-items">
          {items.map((item) => (
            <Row key={item.id} id={item.id} active={active} />
          ))}
        </div>
      )}
    </details>
  );
}

const WorkingHeader = memo(function WorkingHeader({ turn }: { turn?: Turn }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const duration = turn && elapsedTime(turn.startedAt, now);
  return <div className="working-header">{duration ? `Working for ${duration}` : "Working"}</div>;
});

function WorkSummary({ items, turn }: { items: TimelineItem[]; turn?: Turn }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="work-summary" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{workLabel(turn)}</span>
        <ChevronRight size={13} />
      </summary>
      {open && (
        <div className="work-details">
          <Rows items={items} active={false} />
        </div>
      )}
    </details>
  );
}

function Rows({ items, active }: { items: TimelineItem[]; active: boolean }) {
  return activityGroups(items).map((group) =>
    group.activity ? (
      <Activity key={group.id} items={group.items} active={active} />
    ) : (
      <Row key={group.id} id={group.id} active={active} />
    ),
  );
}

export default function Transcript({ task }: { task: Task }) {
  const timeline = useTimeline();
  const turns = useMemo(
    () =>
      transcriptTurns(
        timeline.ids.flatMap((id) => {
          const item = getRow(id);
          return item ? [item] : [];
        }),
        timeline.turns,
      ),
    [timeline],
  );
  return turns.map((group, index) => {
    const active = group.turn
      ? group.turn.status === "running"
      : !timeline.history &&
        index === turns.length - 1 &&
        (task.status === "running" || task.status === "waiting");
    const { work, visible } = completedTurn(group.items);
    const users = visible.filter((item) => item.kind === "user");
    const firstResponse = group.items.findIndex((item) => item.kind !== "user");
    const leading = firstResponse < 0 ? group.items.length : firstResponse;
    return (
      <section className="transcript-turn" key={group.id} aria-label="Conversation turn">
        {active ? (
          <>
            <Rows items={group.items.slice(0, leading)} active />
            <WorkingHeader turn={group.turn} />
            <Rows items={group.items.slice(leading)} active />
            {group.items.every((item) => item.kind === "user") && (
              <div className="working-indicator" role="status">
                <LoaderCircle size={13} className="spin" />
                Working…
              </div>
            )}
          </>
        ) : (
          <>
            <Rows items={users} active={false} />
            {work.length > 0 && <WorkSummary items={work} turn={group.turn} />}
            <Rows items={visible.filter((item) => item.kind !== "user")} active={false} />
          </>
        )}
      </section>
    );
  });
}
