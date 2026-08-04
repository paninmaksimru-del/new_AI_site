const DATABASE_NAME = "mik-anonymizer-drafts";
const DATABASE_VERSION = 1;
const DRAFT_STORE = "drafts";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("INDEXED_DB_REQUEST")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("INDEXED_DB_ABORT")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("INDEXED_DB_TRANSACTION")), { once: true });
  });
}

let databasePromise = null;

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("INDEXED_DB_UNAVAILABLE"));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        const store = database.createObjectStore(DRAFT_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    }, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      databasePromise = null;
      reject(request.error || new Error("INDEXED_DB_OPEN"));
    }, { once: true });
  });
  return databasePromise;
}

async function useStore(mode, callback) {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFT_STORE, mode);
  const store = transaction.objectStore(DRAFT_STORE);
  const done = transactionDone(transaction);
  const result = await callback(store);
  await done;
  return result;
}

export async function listDraftRecords() {
  const records = await useStore("readonly", (store) => requestResult(store.getAll()));
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

export async function getDraftRecord(id) {
  if (!id) return null;
  return useStore("readonly", (store) => requestResult(store.get(id)));
}

export async function saveDraftRecord(snapshot, sourceBlob = null) {
  if (!snapshot?.sessionId) throw new Error("DRAFT_SESSION_ID");
  const record = {
    id: snapshot.sessionId,
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
    snapshot,
    sourceBlob: sourceBlob || null
  };
  await useStore("readwrite", (store) => requestResult(store.put(record)));
  return record;
}

export async function deleteDraftRecord(id) {
  if (!id) return;
  await useStore("readwrite", (store) => requestResult(store.delete(id)));
}

export async function clearDraftRecords() {
  await useStore("readwrite", (store) => requestResult(store.clear()));
}

export async function migrateLegacyDrafts(legacySessions) {
  const sessions = legacySessions && typeof legacySessions === "object" ? Object.values(legacySessions) : [];
  if (!sessions.length) return 0;
  const existing = new Set((await listDraftRecords()).map((record) => record.id));
  let migrated = 0;
  for (const snapshot of sessions) {
    if (!snapshot?.sessionId || existing.has(snapshot.sessionId)) continue;
    await saveDraftRecord(snapshot, null);
    migrated += 1;
  }
  return migrated;
}
