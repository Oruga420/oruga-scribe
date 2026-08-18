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
    // Unwrap an IDBRequest by whether it HAS a result property, not by whether that property is
    // defined.
    //
    // THE BUG: `out.result !== undefined ? out.result : out` returned the request OBJECT itself
    // when the key was missing, and `{result: undefined}` is truthy. So a missing frame or a
    // missing session came back as a truthy non-value: `if (!blob) return {ok:false}` never
    // fired, `if (!session) throw` never fired, and the code went on to read .steps off a
    // request object. A missing thing looked present, which is the worst way for a lookup to
    // fail.
    const unwrap = (v) => (v !== null && typeof v === 'object' && 'result' in v ? v.result : v)
    t.oncomplete = () => resolve(unwrap(out))
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

/** Every frame key a step can hold. Miss one and its blob leaks forever. */
const FRAME_KEYS = ['beforeFrame', 'afterFrame', 'modelFrame']

/**
 * Drop every frame belonging to a session. Recordings are not kept around.
 *
 * THE BUG: this deleted beforeFrame and afterFrame but not modelFrame, which is the CROPPED
 * frame added later and the one there is exactly one of per step. With unlimitedStorage nothing
 * ever complains, so every purged recording quietly left a third of its images on disk forever.
 */
export async function purgeSession(id) {
  const session = await getSession(id)
  let dropped = 0
  if (session) {
    for (const step of session.steps || []) {
      for (const k of FRAME_KEYS) {
        if (step[k]) {
          await deleteFrame(step[k]).catch(() => {})
          dropped++
        }
      }
    }
  }
  await deleteSession(id)
  return dropped
}

/**
 * Delete frames that no session references any more, which is what is left behind by a crash
 * between writing a frame and writing the step that points at it.
 */
export async function purgeOrphanFrames() {
  const sessions = await allSessions()
  const referenced = new Set()
  for (const s of sessions) {
    for (const step of s.steps || []) {
      for (const k of FRAME_KEYS) if (step[k]) referenced.add(step[k])
    }
  }
  const keys = await tx(FRAMES, 'readonly', (s) => s.getAllKeys())
  let dropped = 0
  for (const k of (keys || [])) {
    if (!referenced.has(k)) { await deleteFrame(k).catch(() => {}); dropped++ }
  }
  return dropped
}

export async function estimateBytes() {
  if (!navigator.storage || !navigator.storage.estimate) return null
  const e = await navigator.storage.estimate()
  return { usage: e.usage, quota: e.quota }
}
