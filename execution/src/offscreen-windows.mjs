const OFFSCREEN_BOUNDS = { left: -32000, top: -32000 };
const placements = new WeakMap();
const managedContexts = new WeakMap();
const MANAGEMENT_TIMEOUT_MS = 3000;

function placementError(message, failureCode, cause) {
  const error = new Error(message, { cause });
  error.name = "OffscreenWindowManagementError";
  error.failureCode = failureCode;
  return error;
}

async function beforeDeadline(operation, deadline) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(placementError("Offscreen window placement timed out",
          "offscreen_window_management_timeout")), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function awaitOffscreenWindow(page) {
  await placements.get(page);
}

// Chrome's launch position applies to its first window. Feature-created OAuth
// popups can open a separate window on the desktop, so constrain each page's
// own window without changing window.open, its opener, or its navigation.
export async function installOffscreenWindows(context, config = {}, { timeoutMs = MANAGEMENT_TIMEOUT_MS } = {}) {
  if (config.headless !== false || config.backgroundWindowMode !== "offscreen") return;
  if (managedContexts.has(context)) return managedContexts.get(context);

  let closed = false;

  const prepare = (page) => {
    if (placements.has(page)) return placements.get(page);
    const reposition = (async () => {
      let session, attaching;
      const deadline = Date.now() + timeoutMs;
      try {
        if (closed || page.isClosed()) return;
        attaching = context.newCDPSession(page);
        session = await beforeDeadline(attaching, deadline);
        const { windowId, bounds } = await beforeDeadline(session.send("Browser.getWindowForTarget"), deadline);
        if (bounds.windowState !== "normal") {
          // CDP forbids combining geometry with minimized/maximized/fullscreen.
          await beforeDeadline(session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }), deadline);
        }
        await beforeDeadline(session.send("Browser.setWindowBounds", { windowId, bounds: OFFSCREEN_BOUNDS }), deadline);
      } catch (error) {
        // Some OAuth callbacks close their own popup before its page event.
        // Preserve that successful callback/closure instead of rejecting it.
        if (!closed && !page.isClosed()) {
          throw error.failureCode ? error : placementError("Offscreen window placement failed",
            "offscreen_window_management_failed", error);
        }
      } finally {
        if (session) await beforeDeadline(session.detach(), Math.min(deadline, Date.now() + 250)).catch(() => {});
        else void attaching?.then((lateSession) => lateSession.detach()).catch(() => {});
      }
    })();
    placements.set(page, reposition);
    // The event emitter does not await listeners. Keep errors available to
    // awaitOffscreenWindow callers without an unhandled background rejection.
    void reposition.catch(() => {});
    return reposition;
  };

  context.on("page", prepare);
  context.once("close", () => { closed = true; });
  const initialized = Promise.all(context.pages().map(prepare));
  managedContexts.set(context, initialized);
  await initialized;
}
