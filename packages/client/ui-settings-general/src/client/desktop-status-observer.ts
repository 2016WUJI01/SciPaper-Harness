/** Shared ordering and lifetime rules for Desktop preload status observations. */

interface DesktopStatusBridge<Presentation> {
  status(): Promise<Presentation>
  subscribe(listener: (presentation: Presentation) => void): () => void
}

type DesktopStatusPatch<Presentation> =
  | { presentation: Presentation; failed?: false }
  | { failed: true }

/**
 * Subscribe before reading the initial status; a newer event always wins.
 * @param bridge - preload status API owned by the feature.
 * @param isLive - whether the feature still accepts carrier updates.
 * @param publish - merge an observation into the feature's current view.
 * @returns the carrier subscription disposer.
 */
export function observeDesktopStatus<Presentation>(
  bridge: DesktopStatusBridge<Presentation>,
  isLive: () => boolean,
  publish: (patch: DesktopStatusPatch<Presentation>) => void,
): () => void {
  let received = false
  const unsubscribe = bridge.subscribe((presentation) => {
    if (!isLive()) return
    received = true
    publish({ presentation, failed: false })
  })
  void bridge.status().then((presentation) => {
    if (isLive() && !received) publish({ presentation })
  }, () => {
    if (isLive() && !received) publish({ failed: true })
  })
  return unsubscribe
}
