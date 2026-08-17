/**
 * IndexedDB blob store for screenshots plus the session record.
 *
 * Why not chrome.storage: storage.local caps at 10MB, which is about 65 steps at 150KB.
 * storage.session is in-memory and cleared on browser restart, so it is useless for the
 * crash recovery this needs. IndexedDB plus the unlimitedStorage permission has no such cap.
 */

const DB_NAME = 'oruga-scribe'
const DB_VERSION = 1
const FRAMES = 'frames'
const SESSIONS = 'sessions'

let dbPromise = null

function open() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FRAMES)) {
        db.createObjectStore(FRAMES) // key: frame id string, value: Blob
      }
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const s = t.objectStore(store)
    let out
    try { out = fn(s) } catch (e) { return reject(e) }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

// --- frames -----------------------------------------------------------------

export function putFrame(id, blob) {
  return tx(FRAMES, 'readwrite', (s) => { s.put(blob, id); return id })
}

export function getFrame(id) {
  return tx(FRAMES, 'readonly', (s) => s.get(id))
}

export function deleteFrame(id) {
  return tx(FRAMES, 'readwrite', (s) => s.delete(id))
}

export async function frameCount() {
  return tx(FRAMES, 'readonly', (s) => s.count())
}

// --- sessions ---------------------------------------------------------------

/**
 * Written BEFORE the step is acknowledged, every single time. The service worker dies
 * after 30s idle and takes its globals with it, so nothing lives only in memory.
 */
export function putSession(session) {
  return tx(SESSIONS, 'readwrite', (s) => { s.put(session); return session.id })
}

export function getSession(id) {
  return tx(SESSIONS, 'readonly', (s) => s.get(id))
}

export function allSessions() {
  return tx(SESSIONS, 'readonly', (s) => s.getAll())
}

export function deleteSession(id) {
  return tx(SESSIONS, 'readwrite', (s) => s.delete(id))
}

/** Drop every frame belonging to a session. Recordings are not kept around. */
export async function purgeSession(id) {
  const session = await getSession(id)
  if (session) {
    for (const step of session.steps || []) {
      if (step.beforeFrame) await deleteFrame(step.beforeFrame).catch(() => {})
      if (step.afterFrame) await deleteFrame(step.afterFrame).catch(() => {})
    }
  }
  await deleteSession(id)
}

export async function estimateBytes() {
  if (!navigator.storage || !navigator.storage.estimate) return null
  const e = await navigator.storage.estimate()
  return { usage: e.usage, quota: e.quota }
}
