// Pictures of what's in the app window, taken in code (never a screenshot of
// the user's screen): the sketch renders itself onto a canvas, and the deka
// preview's WebGL canvas is read right after a draw. The previews register
// how to take one; Make it real uses them to compare the sketch and the app.
export const snapshots: { sketch: null | (() => Promise<string | null>); deka: null | (() => Promise<string | null>) } = { sketch: null, deka: null };
