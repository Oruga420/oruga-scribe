/**
 * Screenshot handling: crop, highlight, downscale, and the guard that stops the model
 * from confidently misreading a squeezed image.
 *
 * Runs in the service worker. OffscreenCanvas and createImageBitmap exist there.
 * URL.createObjectURL does NOT, which is why download URLs are minted in the panel.
 */

/** The model downscales the long edge to about this, so anything above it is wasted bytes. */
export const MAX_LONG_EDGE = 1568

/** Target size for a frame handed to the model. 1024x640 measured legible down to 17px text. */
export const MODEL_W = 1024
export const MODEL_H = 640

/**
 * Past roughly this ratio, text turns to mush after the downscale and the model reads it
 * WRONG while reporting success. A 1280x5000 capture came back with every field corrupted
 * and looking authoritative. See wiki/capture-algorithm.md.
 */
export const MAX_ASPECT = 2.2

export class AspectGuardError extends Error {
  constructor(w, h, why) {
    super(
      'oruga-scribe: refusing a ' + w + 'x' + h + ' image (aspect ' +
      (Math.max(w, h) / Math.min(w, h)).toFixed(1) + ':1). ' + (why || '') + ' ' +
      'Past ' + MAX_ASPECT + ':1 the downscale destroys text and the model misreads it ' +
      'while reporting success.'
    )
    this.name = 'AspectGuardError'
    this.width = w
    this.height = h
  }
}

/**
 * Refuse anything unsafe to send. Call on the FINAL dimensions of every image that leaves.
 *
 * Learned from the harness: the original guard was almost dead code. It only checked the crop
 * window, and the crop always normalized the aspect ratio to 1024x640, so a pathological
 * source could never trip it. The check has to be on the source too, not just the output.
 */
export function assertSendable(w, h) {
  const ratio = Math.max(w, h) / Math.min(w, h)
  if (ratio > MAX_ASPECT) throw new AspectGuardError(w, h, 'Aspect ratio out of range.')
  if (Math.max(w, h) > MAX_LONG_EDGE) {
    throw new AspectGuardError(w, h, 'Long edge exceeds ' + MAX_LONG_EDGE + 'px.')
  }
  return true
}

async function toBitmap(source) {
  if (typeof source === 'string') {
    const res = await fetch(source)          // data: URL from captureVisibleTab
    return createImageBitmap(await res.blob())
  }
  return createImageBitmap(source)
}

/**
 * Store-sized frame: full viewport, downscaled, WebP.
 * @param {string|Blob} source
 */
export async function toStorageFrame(source, quality = 0.8) {
  const bmp = await toBitmap(source)
  try {
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bmp, 0, 0, w, h)
    return { blob: await canvas.convertToBlob({ type: 'image/webp', quality }), width: w, height: h }
  } finally {
    bmp.close()
  }
}

/**
 * Model-sized frame: cropped toward the click target, with the target outlined, then
 * blacked out over any region the redaction layer flagged.
 *
 * Cropping toward the target is the single biggest quality differentiator in commercial
 * tools. A full 1920px viewport per step reads as a screenshot dump, not a guide.
 *
 * @param {string|Blob} source
 * @param {{x:number,y:number,width:number,height:number}|null} target  CSS px
 * @param {Array<{x:number,y:number,width:number,height:number}>} redactRects  CSS px
 * @param {number} dpr
 */
export async function toModelFrame(source, target, redactRects = [], dpr = 1) {
  const bmp = await toBitmap(source)
  try {
    // Guard the SOURCE, not only the crop. With no target to crop toward, a pathological
    // source would be silently reduced to its top slice and presented as "the page".
    const srcRatio = Math.max(bmp.width, bmp.height) / Math.min(bmp.width, bmp.height)
    if (srcRatio > MAX_ASPECT && !(target && target.width > 0 && target.height > 0)) {
      throw new AspectGuardError(bmp.width, bmp.height,
        'Source is out of range and there is no click target to crop toward.')
    }

    const sx = (r) => ({
      x: r.x * dpr, y: r.y * dpr, width: r.width * dpr, height: r.height * dpr,
    })

    // Black out first, in source space, so a redacted region can never survive a crop.
    let base = bmp
    let baseCanvas = null
    if (redactRects.length) {
      baseCanvas = new OffscreenCanvas(bmp.width, bmp.height)
      const bctx = baseCanvas.getContext('2d')
      bctx.drawImage(bmp, 0, 0)
      bctx.fillStyle = '#000'
      for (const r of redactRects) {
        const s = sx(r)
        // Solid fill, never ctx.filter = 'blur()'. Low radius blur over text is
        // partially recoverable, which is not redaction.
        bctx.fillRect(Math.floor(s.x), Math.floor(s.y), Math.ceil(s.width), Math.ceil(s.height))
      }
      base = baseCanvas.transferToImageBitmap()
    }

    // Choose a crop window around the target, at the model aspect ratio.
    const aspect = MODEL_W / MODEL_H
    let cw, ch, cx, cy
    if (target && target.width > 0 && target.height > 0) {
      const t = sx(target)
      const pad = Math.max(t.width, t.height) * 2.5 + 240 * dpr
      ch = Math.min(base.height, Math.max(t.height + pad, MODEL_H * 0.75))
      cw = Math.min(base.width, ch * aspect)
      ch = Math.min(base.height, cw / aspect)
      cx = Math.round(Math.min(Math.max(0, t.x + t.width / 2 - cw / 2), base.width - cw))
      cy = Math.round(Math.min(Math.max(0, t.y + t.height / 2 - ch / 2), base.height - ch))
    } else {
      cw = base.width
      ch = Math.min(base.height, cw / aspect)
      cx = 0
      cy = 0
    }

    // Only the dimensions that ACTUALLY get sent are worth asserting on.
    //
    // There used to be a second check here on the crop window that clamped the height it passed
    // to the assertion, so an oversized crop was rewritten into a passing value before being
    // checked. A validation that edits its input to make it pass is worse than no validation:
    // it reads like coverage and provides none.
    const canvas = new OffscreenCanvas(MODEL_W, Math.round(MODEL_W / (cw / ch)))
    assertSendable(canvas.width, canvas.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(base, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height)

    // Outline the target so the model and the reader both know what was clicked.
    if (target && target.width > 0) {
      const t = sx(target)
      const k = canvas.width / cw
      ctx.strokeStyle = '#ef3340'
      ctx.lineWidth = Math.max(2, Math.round(3 * k))
      ctx.strokeRect((t.x - cx) * k, (t.y - cy) * k, t.width * k, t.height * k)
    }

    if (baseCanvas) base.close()
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
    return { blob, width: canvas.width, height: canvas.height }
  } finally {
    bmp.close()
  }
}

/** Base64 without the data: prefix, for the relay's JSONL image block. */
export async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/**
 * 32x32 grayscale difference, 0 to 1. Below ~0.012 nothing visibly happened, which makes
 * the step an auto-prune candidate. This is what stops 300 clicks becoming 300 SOP steps.
 */
export async function frameDiff(aBlob, bBlob) {
  const [a, b] = await Promise.all([shrink(aBlob), shrink(bBlob)])
  if (!a || !b) return 1
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / (a.length * 255)
}

async function shrink(blob) {
  if (!blob) return null
  const bmp = await createImageBitmap(blob)
  try {
    const c = new OffscreenCanvas(32, 32)
    const ctx = c.getContext('2d')
    ctx.drawImage(bmp, 0, 0, 32, 32)
    const { data } = ctx.getImageData(0, 0, 32, 32)
    const gray = new Uint8Array(32 * 32)
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
    }
    return gray
  } finally {
    bmp.close()
  }
}
