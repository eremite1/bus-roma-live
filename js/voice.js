// Voce in italiano (sintesi vocale del telefono), con muto ricordato sul telefono.

let muted = (() => { try { return localStorage.getItem('voce') === 'off'; } catch (e) { return false; } })();

export function isMuted() { return muted; }

export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('voce', v ? 'off' : 'on'); } catch (e) { /* ok */ }
  if (v && window.Android && Android.stopSpeak) Android.stopSpeak();
  if (v && 'speechSynthesis' in window) speechSynthesis.cancel();
}

export function speak(text, { interrupt = true } = {}) {
  if (muted || !text) return;
  // nell'app Android la voce è quella del telefono (il browser interno non sa parlare)
  if (window.Android && Android.speak) { Android.speak(String(text), !!interrupt); return; }
  if (!('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'it-IT';
  const voice = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith('it'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}
