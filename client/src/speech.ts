// Stage narrator: browser TTS with a resolute fallback, so the show never
// stalls on machines with no voices (muted kiosks, headless test runs).
// speak() resolves when the line has been spoken — or after a reading-time
// fallback if speech never happens.

export function speak(
  text: string,
  { rate = 1, interrupt = false }: { rate?: number; interrupt?: boolean } = {},
): Promise<void> {
  return new Promise((resolve) => {
    const words = text.trim().split(/\s+/).length;
    // Generous cap: normal speech runs ~150-180 wpm; if 'end' never fires
    // (no voices installed), this doubles as silent reading time.
    const capMs = words * 380 + 2600;
    let done = false;
    let cap: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (cap) clearTimeout(cap);
      resolve();
    };
    cap = setTimeout(finish, capMs);
    try {
      const synth = window.speechSynthesis;
      if (!synth) return; // the cap timer resolves after reading time
      if (interrupt) synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'en-US';
      utter.rate = rate;
      utter.onend = finish;
      utter.onerror = finish;
      synth.speak(utter);
    } catch {
      // the cap timer resolves
    }
  });
}
