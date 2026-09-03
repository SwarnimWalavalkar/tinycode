import type { ProviderId } from "../shared/contracts";
import codexLogo from "./assets/harnesses/codex.svg";
import claudeLogo from "./assets/harnesses/claude.svg";
import piLogo from "./assets/harnesses/pi.svg";

export const providerNames: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
};
const logos: Record<ProviderId, string> = { codex: codexLogo, claude: claudeLogo, pi: piLogo };
export function ProviderMark({ id }: { id: ProviderId }) {
  return (
    <span className={`provider-mark ${id}`} aria-hidden="true">
      <img src={logos[id]} alt="" width={18} height={18} />
    </span>
  );
}
