// Saving a file out of the app (CSV export, backup).
// In the installed Android/iOS app a plain <a download> does nothing, so the file is written to the app's
// cache and handed to the system share sheet (Save to Files / Drive / WhatsApp ...). In a browser or the
// Windows app it is an ordinary download.

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const isNative = () => Boolean(globalThis.Capacitor?.isNativePlatform?.());

/** Returns "shared" (native share sheet) or "downloaded". Throws if the user's device refuses. */
export async function saveFile(name, text, mime = "text/plain") {
  const cap = globalThis.Capacitor;
  if (isNative()) {
    const { Filesystem, Share } = cap.Plugins || {};
    if (!Filesystem || !Share) throw new Error("Saving files isn't available on this device.");
    const written = await Filesystem.writeFile({ path: name, data: toBase64(text), directory: "CACHE" });
    try {
      await Share.share({ title: name, url: written.uri, dialogTitle: "Save or share " + name });
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) throw e;       // dismissing the share sheet is not an error
    }
    return "shared";
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}
