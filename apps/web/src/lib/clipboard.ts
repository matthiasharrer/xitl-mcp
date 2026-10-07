/** Copies `text`; false when the clipboard is unavailable (insecure origin,
 * refused permission), so the caller can show the text for a manual copy. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
