import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tinycode-excalidraw", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("boards");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Canvas storage is blocked by another tab.")); };
  });
}

export async function loadCanvas(key: string): Promise<ExcalidrawInitialDataState | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("boards").objectStore("boards").get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCanvas(key: string, scene: ExcalidrawInitialDataState): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("boards", "readwrite");
    transaction.objectStore("boards").put(scene, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Canvas save was interrupted."));
  });
}
