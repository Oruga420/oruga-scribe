/**
 * MAIN world, document_start. Forces every shadow root open.
 *
 * Why: event.composedPath()[0] gives the real inner target only for OPEN shadow roots.
 * A CLOSED root truncates the path to the host element, so on a web-component UI you see
 * <my-fancy-button> and nothing inside it, which makes the accessible name unrecoverable.
 *
 * This must beat page script to the punch, so it is registered via
 * chrome.scripting.registerContentScripts with world MAIN, not injected lazily.
 */
;(() => {
  const proto = Element.prototype
  const original = proto.attachShadow
  if (!original || original.__orugaPatched) return

  function patched(init) {
    const requested = init && init.mode
    const root = original.call(this, Object.assign({}, init, { mode: 'open' }))
    if (requested === 'closed') {
      try {
        // Record what the page asked for, so the SOP can note the element was meant to
        // be encapsulated. Never hide the fact that we changed behavior.
        this.setAttribute('data-oruga-shadow-was-closed', '')
      } catch { /* some elements refuse attributes, not worth failing over */ }
    }
    return root
  }
  patched.__orugaPatched = true

  try {
    Object.defineProperty(proto, 'attachShadow', {
      value: patched, writable: true, configurable: true,
    })
  } catch { /* a page may have frozen the prototype; degrade to host-level capture */ }
})()
