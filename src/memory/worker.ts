import { randomUUID } from "node:crypto";
import { MemoryError, type MemoryCardHit, type MemoryErrorCode, type MemoryMeta } from "./host.js";
import type { StageMemory } from "./access.js";

const TIMEOUT_MS = 30_000;

type MemoryVerb =
  | "memory.read"
  | "memory.replace"
  | "memory.meta"
  | "memory.addCard"
  | "memory.updateCard"
  | "memory.readCard"
  | "memory.searchCards";

type MemoryResponse = {
  type?: string;
  requestId?: string;
  body?: string;
  meta?: MemoryMeta;
  hits?: MemoryCardHit[];
  error?: { code: MemoryErrorCode };
};

function request(type: MemoryVerb, input: unknown): Promise<MemoryResponse> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new MemoryError("MEMORY_NOT_ATTACHED"));
      return;
    }
    const requestId = randomUUID();
    const finish = (error?: MemoryError, response?: MemoryResponse): void => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", disconnected);
      if (error) reject(error);
      else resolve(response!);
    };
    const disconnected = (): void => finish(new MemoryError("MEMORY_UNREADABLE"));
    const receive = (message: unknown): void => {
      const response = message as MemoryResponse;
      if (response?.type !== "memory.response" || response.requestId !== requestId) return;
      finish(undefined, response);
    };
    const timer = setTimeout(disconnected, TIMEOUT_MS);
    process.on("message", receive);
    process.once("disconnect", disconnected);
    process.send({ type, requestId, input }, (error) => {
      if (error) disconnected();
    });
  });
}

export async function workerMemoryForStage(ids: readonly string[]): Promise<StageMemory> {
  const ipc = workerStageMemory();
  const attachments: MemoryMeta[] = [];
  for (const id of ids) attachments.push(await ipc.meta(id));
  const allowed = new Set(ids);
  return {
    attachments,
    async read(id) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      return ipc.read(id);
    },
    async replace(id, content) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      await ipc.replace(id, content);
    },
    async addCard(id, key, body) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      await ipc.addCard(id, key, body);
    },
    async updateCard(id, key, body) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      await ipc.updateCard(id, key, body);
    },
    async readCard(id, key) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      return ipc.readCard(id, key);
    },
    async searchCards(id, query) {
      if (!allowed.has(id)) throw new MemoryError("MEMORY_NOT_ATTACHED");
      return ipc.searchCards(id, query);
    },
  };
}

function workerStageMemory(): {
  read(id: string): Promise<string>;
  replace(id: string, content: string): Promise<void>;
  meta(id: string): Promise<MemoryMeta>;
  addCard(id: string, key: string, body: string): Promise<void>;
  updateCard(id: string, key: string, body: string): Promise<void>;
  readCard(id: string, key: string): Promise<string>;
  searchCards(id: string, query: string): Promise<MemoryCardHit[]>;
} {
  return {
    async read(id) {
      const response = await request("memory.read", { memory: id });
      if (response.error) throw new MemoryError(response.error.code);
      return response.body ?? "";
    },
    async replace(id, content) {
      const response = await request("memory.replace", { memory: id, content });
      if (response.error) throw new MemoryError(response.error.code);
    },
    async meta(id) {
      const response = await request("memory.meta", { memory: id });
      if (response.error || !response.meta) throw new MemoryError(response.error?.code ?? "MEMORY_UNREADABLE");
      return response.meta;
    },
    async addCard(id, key, body) {
      const response = await request("memory.addCard", { memory: id, key, content: body });
      if (response.error) throw new MemoryError(response.error.code);
    },
    async updateCard(id, key, body) {
      const response = await request("memory.updateCard", { memory: id, key, content: body });
      if (response.error) throw new MemoryError(response.error.code);
    },
    async readCard(id, key) {
      const response = await request("memory.readCard", { memory: id, key });
      if (response.error) throw new MemoryError(response.error.code);
      return response.body ?? "";
    },
    async searchCards(id, query) {
      const response = await request("memory.searchCards", { memory: id, query });
      if (response.error) throw new MemoryError(response.error.code);
      if (!response.hits) throw new MemoryError("MEMORY_UNREADABLE");
      return response.hits;
    },
  };
}
