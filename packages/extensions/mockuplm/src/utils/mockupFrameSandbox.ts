/**
 * `sandbox` value for every frame that renders a mockup document.
 *
 * `allow-same-origin` stays because the editor reads and decorates the frame's
 * DOM from the parent (selection, comment pins, screenshots). `allow-scripts`
 * must never be added next to it: a script in a same-origin frame reaches
 * `parent.electronAPI`, which exposes the app's IPC to the mockup's author.
 * A mockup's own scripts therefore do not run (the editor says so in a notice).
 */
export const MOCKUP_FRAME_SANDBOX = "allow-same-origin";
