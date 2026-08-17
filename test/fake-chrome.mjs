/**
 * A fake enough Chrome for testing sw.js in Node.
 *
 * The point is not fidelity for its own sake. It is that the one bug that broke the first
 * real run (session state in a worker global, lost on the 30 second idle termination) is
 * INVISIBLE to any test that cannot kill and revive the worker. So this fake can do exactly
 * that: reload the module with storage.session preserved and module globals destroyed, which
 * is what Chrome actually does.
 */

import { webcrypto } from 'node:crypto'

export function makeChrome() {
  const sessionStore = new Map()
  const localStore = new Map()
  const listeners = { message: [], navCommitted: [], installed: [], startup: [], actionClicked: [] }
  const log = {
    captures: 0, tabMessages: [], injected: [], panelMessages: [],
    panelBehavior: [],   // every setPanelBehavior call, so the test can prove it runs on wake
    panelOpens: [],
  }

  // Tab state the test drives
  const state = {
    tabs: [{ id: 7, windowId: 1, url: 'https://api.slack.com/apps/A1/oauth', active: true }],
    frames: [{ frameId: 0 }],
    contentScriptPresent: true,
    captureFails: false,
  }

  function areaFor(map) {
    return {
      get: async (keys) => {
        const out = {}
        const list = Array.isArray(keys) ? keys : (keys == null ? [...map.keys()] : [keys])
        for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k))
        return out
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)) },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) map.delete(k) },
      clear: async () => map.clear(),
    }
  }

  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.message.push(fn),
      },
      // The worker sending to the panel. Captured so the test can assert what the UI saw.
      sendMessage: async (msg) => {
        if (msg && msg.to === 'oruga-panel') { log.panelMessages.push(structuredClone(msg)); return }
        return undefined
      },
      lastError: null,
    },
    storage: {
      session: areaFor(sessionStore),
      local: areaFor(localStore),
    },
    tabs: {
      query: async () => state.tabs.filter((t) => t.active),
      captureVisibleTab: async () => {
        if (state.captureFails) throw new Error('quota')
        log.captures++
        return TINY_JPEG_DATA_URL
      },
      sendMessage: async (tabId, msg) => {
        if (!state.contentScriptPresent) throw new Error('Receiving end does not exist')
        log.tabMessages.push({ tabId, msg: structuredClone(msg) })
        return { ok: true }
      },
    },
    webNavigation: {
      getAllFrames: async () => state.frames,
      onCommitted: { addListener: (fn) => listeners.navCommitted.push(fn) },
    },
    scripting: {
      executeScript: async ({ target, files }) => {
        if (!state.contentScriptPresent) state.contentScriptPresent = true
        log.injected.push({ tabId: target.tabId, files })
        return [{ result: null }]
      },
      registerContentScripts: async () => {},
      getRegisteredContentScripts: async () => [],
    },
    sidePanel: {
      setPanelBehavior: async (o) => { log.panelBehavior.push(o) },
      setOptions: async () => {},
      open: async (o) => { log.panelOpens.push(o) },
    },
    action: {
      onClicked: { addListener: (fn) => listeners.actionClicked.push(fn) },
    },
  }
  chrome.runtime.onInstalled = { addListener: (fn) => listeners.installed.push(fn) }
  chrome.runtime.onStartup = { addListener: (fn) => listeners.startup.push(fn) }

  /**
   * Deliver a message the way Chrome does, returning the async reply.
   *
   * Re-binds globalThis.chrome first: sw.js reads `chrome.*` at call time, so once a second
   * fake environment has been created, an earlier environment's listeners would otherwise
   * read the newer environment's storage and see no session.
   */
  async function deliver(msg, sender = {}) {
    globalThis.chrome = chrome
    for (const fn of listeners.message) {
      let replied
      const reply = (r) => { replied = r }
      const kept = fn(msg, sender, reply)
      if (kept === true) {
        // async reply: give the handler a chance to finish
        for (let i = 0; i < 200 && replied === undefined; i++) await tick()
      }
      if (replied !== undefined) return replied
    }
    return undefined
  }

  async function navigate(url) {
    globalThis.chrome = chrome
    state.tabs[0].url = url
    for (const fn of listeners.navCommitted) {
      await fn({ tabId: 7, frameId: 0, url })
    }
  }

  /** Simulate the toolbar button being clicked. */
  async function clickAction() {
    globalThis.chrome = chrome
    for (const fn of listeners.actionClicked) await fn(state.tabs[0])
  }

  return { chrome, state, log, deliver, navigate, clickAction, sessionStore, localStore, listeners }
}

export function tick() { return new Promise((r) => setTimeout(r, 0)) }

/**
 * Every fillRect any fake canvas performs, in order. The redaction criterion is "a solid
 * black fill happened", and the fill lands on an intermediate canvas that is then transferred
 * to a bitmap, so tracking it per-canvas checks the wrong object.
 */
export const canvasFills = []

/** 2x2 JPEG. Small enough to be free, real enough for createImageBitmap. */
export const TINY_JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzMv/AABEIAAIAAgMBIgACEQEDEQH/' +
  'xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFB' +
  'BhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpj' +
  'ZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV' +
  '1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDAQACEQMRAD8A9/oooA//2Q=='

export { webcrypto }
