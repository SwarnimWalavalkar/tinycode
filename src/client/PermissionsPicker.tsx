import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  Hand,
  Pencil,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import type { ProviderId } from "../shared/contracts";
import { permissionOptions, type PermissionMode } from "../shared/permissions";
import { providerNames } from "./Harness";

const icons = {
  ask: Hand,
  edit: Pencil,
  auto: ShieldCheck,
  read: BookOpen,
  deny: ShieldOff,
  full: ShieldAlert,
};

export default function PermissionsPicker({
  provider,
  value,
  disabled,
  onChange,
  autoModeAvailable,
}: {
  provider: ProviderId;
  value?: PermissionMode | null;
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void | Promise<void>;
  autoModeAvailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = permissionOptions[provider];
  const selected = options.find((option) => option.id === value);
  const label = selected?.label ?? "Permission Settings";
  const Icon = selected ? icons[selected.icon] : Shield;

  useEffect(() => {
    setOpen(false);
    setError("");
  }, [provider, disabled]);
  useEffect(() => {
    if (!open) return;
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    buttons?.[
      Math.max(
        0,
        options.findIndex((option) => option.id === value),
      )
    ]?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  async function choose(mode: PermissionMode) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onChange(mode);
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="permission-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const buttons = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="permission-trigger"
        data-full-access={selected?.icon === "full" || undefined}
        aria-label={`Permissions: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={`${selected?.description ?? "Uses this task's existing native harness settings."}${disabled ? " Available after this turn when connected." : ""}`}
        onClick={() => {
          setError("");
          setOpen(!open);
        }}
      >
        <Icon size={15} />
        <span>{label}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          className="permission-menu"
          ref={menu}
          role="menu"
          aria-label={`${providerNames[provider]} permissions`}
          aria-busy={saving}
        >
          <div className="permission-heading" role="presentation">
            {provider === "pi" ? "Which tools can Pi use?" : "How should actions be approved?"}
          </div>
          {options.map((option) => {
            const OptionIcon = icons[option.icon];
            const unavailable =
              provider === "claude" && option.id === "auto" && autoModeAvailable === false;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={option.id === value}
                aria-disabled={saving || unavailable}
                data-unavailable={unavailable || undefined}
                data-full-access={option.icon === "full" || undefined}
                onClick={() => {
                  if (!unavailable) void choose(option.id);
                }}
              >
                <OptionIcon size={17} />
                <span>
                  <strong>{option.label}</strong>
                  <small>
                    {unavailable
                      ? "Not available for this model. Choose a model that supports Claude auto mode."
                      : option.description}
                  </small>
                </span>
                {option.id === value && <Check size={15} />}
              </button>
            );
          })}
          {error && (
            <p className="permission-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
