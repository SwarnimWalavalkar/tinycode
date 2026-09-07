import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VmSnapshot } from "./vm-tools.js";

export type StoredState = {
  model: string;
  messages: AgentMessage[];
  vm: VmSnapshot;
  updatedAt: string;
};

type StateMetadata = Omit<StoredState, "messages">;
type StateStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

// Four-byte UTF-8 characters still remain well below Cloudflare's 2 MB row limit.
export const STATE_CHUNK_CODE_UNITS = 256 * 1024;

export function splitStateValue(value: string): string[] {
  const output: string[] = [];
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(offset + STATE_CHUNK_CODE_UNITS, value.length);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    output.push(value.slice(offset, end));
    offset = end;
  }
  return output.length ? output : [""];
}

export class StateRepository {
  private sql: SqlStorage;

  constructor(private storage: StateStorage) {
    this.sql = storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS state_chunks (chunk_index INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  load(): StoredState | undefined {
    const metadataRow = this.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = 'agent_metadata'")
      .toArray()[0];
    if (metadataRow) {
      const messageRows = this.sql
        .exec<{ value: string }>("SELECT value FROM state_chunks ORDER BY chunk_index")
        .toArray();
      const metadata = JSON.parse(metadataRow.value) as StateMetadata;
      const messages = JSON.parse(messageRows.map((row) => row.value).join("")) as AgentMessage[];
      return { ...metadata, messages };
    }

    // Read the original aggregate row once so a pre-release deployment can migrate in place.
    const legacy = this.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = 'agent'")
      .toArray()[0];
    return legacy ? (JSON.parse(legacy.value) as StoredState) : undefined;
  }

  save(state: StoredState) {
    const { messages, ...metadata } = state;
    const messageChunks = splitStateValue(JSON.stringify(messages));
    this.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO state (key, value) VALUES ('agent_metadata', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(metadata),
      );
      this.sql.exec("DELETE FROM state_chunks");
      for (const [index, value] of messageChunks.entries())
        this.sql.exec(
          "INSERT INTO state_chunks (chunk_index, value) VALUES (?, ?)",
          index,
          value,
        );
      this.sql.exec("DELETE FROM state WHERE key = 'agent'");
    });
  }
}
