import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  STATE_CHUNK_CODE_UNITS,
  StateRepository,
  splitStateValue,
  type StoredState,
} from "./state.js";

const cursor = <T extends Record<string, SqlStorageValue>>(rows: T[]) =>
  ({ toArray: () => rows }) as SqlStorageCursor<T>;

class MemorySql {
  state = new Map<string, string>();
  messageChunks = new Map<number, string>();

  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T> {
    const statement = query.replace(/\s+/g, " ").trim();
    if (statement.startsWith("CREATE TABLE")) return cursor([]);
    if (statement === "SELECT value FROM state WHERE key = 'agent_metadata'") {
      const value = this.state.get("agent_metadata");
      return cursor(value === undefined ? [] : ([{ value }] as unknown as T[]));
    }
    if (statement === "SELECT value FROM state WHERE key = 'agent'") {
      const value = this.state.get("agent");
      return cursor(value === undefined ? [] : ([{ value }] as unknown as T[]));
    }
    if (statement === "SELECT value FROM state_chunks ORDER BY chunk_index")
      return cursor(
        [...this.messageChunks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => ({ value })) as unknown as T[],
      );
    if (statement.startsWith("INSERT INTO state (key, value) VALUES ('agent_metadata', ?)")) {
      this.state.set("agent_metadata", String(bindings[0]));
      return cursor([]);
    }
    if (statement === "DELETE FROM state_chunks") {
      this.messageChunks.clear();
      return cursor([]);
    }
    if (statement === "INSERT INTO state_chunks (chunk_index, value) VALUES (?, ?)") {
      this.messageChunks.set(Number(bindings[0]), String(bindings[1]));
      return cursor([]);
    }
    if (statement === "DELETE FROM state WHERE key = 'agent'") {
      this.state.delete("agent");
      return cursor([]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

class MemoryStorage {
  readonly memory = new MemorySql();
  readonly sql = this.memory as unknown as SqlStorage;

  transactionSync<T>(closure: () => T): T {
    return closure();
  }
}

describe("durable agent state", () => {
  it("does not split a Unicode surrogate pair between SQLite rows", () => {
    const value = `${"a".repeat(STATE_CHUNK_CODE_UNITS - 1)}😀tail`;
    const values = splitStateValue(value);
    expect(values).toHaveLength(2);
    expect(values.join("")).toBe(value);
    expect(values[0].endsWith("\ud83d")).toBe(false);
  });

  it("persists and reloads image-bearing history across bounded rows", () => {
    const storage = new MemoryStorage();
    const repository = new StateRepository(storage);
    const imageData = "a".repeat(2_500_000);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image" },
          { type: "image", data: imageData, mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ] as AgentMessage[];
    const state: StoredState = {
      model: "openai/gpt-5.4",
      messages,
      vm: { state: "absent", lastUsedAt: null },
      updatedAt: "2026-09-04T00:00:00.000Z",
    };

    repository.save(state);

    expect(storage.memory.messageChunks.size).toBeGreaterThan(1);
    expect(
      Math.max(...[...storage.memory.messageChunks.values()].map((value) => value.length)),
    ).toBeLessThanOrEqual(STATE_CHUNK_CODE_UNITS);
    expect(
      Math.max(
        ...[...storage.memory.messageChunks.values()].map(
          (value) => new TextEncoder().encode(value).byteLength,
        ),
      ),
    ).toBeLessThan(2 * 1024 * 1024);
    expect(storage.memory.state.get("agent_metadata")).not.toContain(imageData);
    expect(repository.load()).toEqual(state);
  });
});
