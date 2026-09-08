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
    // If speech never starts (no voices installed), resolve after silent
    // reading time instead.
    const readingMs = words * 380 + 2600;
    let done = false;
    let cap: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (cap) clearTimeout(cap);
      resolve();
    };
    cap = setTimeout(finish, readingMs);
    try {
      const synth = window.speechSynthesis;
      if (!synth) return; // the reading-time timer resolves
      if (interrupt) synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'en-US';
      utter.rate = rate;
      utter.onstart = () => {
        // Real speech is underway (voices can load late and speak slower
        // than the estimate) — never cut it off: from here only 'end' or
        // 'error' resolves, with a long stuck-synth safety net.
        if (cap) clearTimeout(cap);
        cap = setTimeout(finish, readingMs * 3 + 10000);
      };
      utter.onend = finish;
      utter.onerror = finish;
      synth.speak(utter);
    } catch {
      // the reading-time timer resolves
    }
  });
}
