// Voice-over manifest — the single source of truth for every spoken line in the
// game. Shared by BOTH the build-time generator (tools/gen-vo.mjs, which turns
// each line into assets/vo/<id>.mp3 via ElevenLabs) and the runtime (audio.js,
// which fetches + plays those files, and cutscene.js/finisher.js, which trigger
// them by id).
//
// The `text` here is the plain spoken form; the on-screen subtitles keep their own
// HTML markup (bold/emphasis) in the beat definitions. If you edit a line's text,
// re-run `npm run gen-vo` to regenerate just the changed clip (the generator tracks
// a per-line hash and skips unchanged ones).
//
// Voice ids are ElevenLabs premade (public) voices so any account can generate
// without first importing a custom voice. Override any of them without touching
// tracked code via env vars: VO_VOICE_NARRATOR / VO_VOICE_REBBE / VO_VOICE_PLAYER.

export const VO_DIR = './assets/vo/';

// The three speakers. `voiceId`s are stable ElevenLabs premade voices; `settings`
// are passed straight through to the text-to-speech call.
export const VO_VOICES = {
  // The storyteller framing the tale — warm, grave, unhurried.
  narrator: {
    label: 'Narrator',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb', // "George" — mature, resonant narrator
    settings: { stability: 0.5, similarityBoost: 0.75, style: 0.15, useSpeakerBoost: true },
  },
  // The rebbe delivering the dark dvar torah — old, commanding, seductive.
  rebbe: {
    label: 'The Rebbe',
    voiceId: 'pqHfZKP75CvOlQylNhV4', // "Bill" — older, gravelly, authoritative
    settings: { stability: 0.4, similarityBoost: 0.8, style: 0.35, useSpeakerBoost: true },
  },
  // The player's own battle cry at the finisher — manic, hoarse, unhinged.
  player: {
    label: 'Player',
    voiceId: 'N2lVS1w4EtoT3dr4eOWO', // "Callum" — intense, raw
    settings: { stability: 0.3, similarityBoost: 0.75, style: 0.6, useSpeakerBoost: true },
  },
  // Rabbi Zehnwirth — the learned seducer of the chavrusa cut-scene. Reuses the gravelly
  // "Bill" voice (a fitting second dark rabbi); overridable via VO_VOICE_ZEHNWIRTH.
  zehnwirth: {
    label: 'Rabbi Zehnwirth',
    voiceId: 'pqHfZKP75CvOlQylNhV4', // "Bill" — older, gravelly, authoritative
    settings: { stability: 0.42, similarityBoost: 0.8, style: 0.42, useSpeakerBoost: true },
  },
  // Chaim Barer, learning — young, measured, quietly probing (and, at the end, coldly
  // resolved). Callum with calmer settings than the finisher shout. Override: VO_VOICE_BARER.
  barer: {
    label: 'Chaim Barer',
    voiceId: 'N2lVS1w4EtoT3dr4eOWO', // "Callum"
    settings: { stability: 0.58, similarityBoost: 0.75, style: 0.22, useSpeakerBoost: true },
  },
  // The bachur who bursts in with the alarm — breathless, panicked. Override: VO_VOICE_BACHUR.
  bachur: {
    label: 'Bachur',
    voiceId: 'N2lVS1w4EtoT3dr4eOWO', // "Callum" (distinct settings; swap via env if desired)
    settings: { stability: 0.32, similarityBoost: 0.7, style: 0.6, useSpeakerBoost: true },
  },
};

// Every line, in narrative order. `id` is the filename stem (assets/vo/<id>.mp3)
// and the handle the cut-scene beats reference via their `vo:` field.
export const VO_LINES = [
  // ---- opening cinematic (src/main.js _introBeats) --------------------------
  { id: 'intro-1', voice: 'narrator', text: 'For years, you learned here — day and night, without end.' },
  { id: 'intro-2', voice: 'narrator', text: 'Shoulder to shoulder with the chevra. Your friends. Your chavrusa.' },
  { id: 'intro-3', voice: 'narrator', text: 'Until this morning… when something in the yeshiva turned.' },
  { id: 'intro-4', voice: 'narrator', text: 'They rise.' },
  { id: 'intro-5', voice: 'narrator', text: 'Fists up. Smash your way out — hall by endless hall.' },
  { id: 'intro-6', voice: 'narrator', text: 'There is no end. Only how deep you get.' },

  // ---- the dvar-torah cut-scene (src/dvartorah.js beats) --------------------
  { id: 'dvar-1', voice: 'narrator', text: 'Long before the halls rose against you… there was a voice they all came to hear.' },
  { id: 'dvar-2', voice: 'rebbe', text: 'Chazal teach: da lifnei mi atah omed — know before Whom you stand.' },
  { id: 'dvar-3', voice: 'rebbe', text: 'But tonight I ask you a deeper question. Do you know what it is that stands within you?' },
  { id: 'dvar-4', voice: 'rebbe', text: 'The yetzer hara, they name it — the evil within. Yet the Torah itself calls it tov me’od. Very good.' },
  { id: 'dvar-5', voice: 'rebbe', text: 'Without it, no man builds a home, takes a wife, lays a single stone. It is the fire beneath all of creation.' },
  { id: 'dvar-6', voice: 'rebbe', text: 'Your rebbeim taught you to break it. To starve it. To beg it into silence.' },
  { id: 'dvar-7', voice: 'rebbe', text: 'They were afraid of it. But a flame like this is not made to be smothered — it is made to be obeyed.' },
  { id: 'dvar-8', voice: 'rebbe', text: 'Aizehu gibbor? Who is the true gibbor? Not the one who conquers his nature —' },
  { id: 'dvar-9', voice: 'rebbe', text: '— but the one who unleashes it, and dares to call it avodah. Holy service.' },
  { id: 'dvar-10', voice: 'rebbe', text: 'There is one who has waited at your shoulder since the day you were born. Patient. Faithful. He asks only that you listen.' },
  { id: 'dvar-11', voice: 'rebbe', text: 'So tonight, my talmidim — open the door. Let him in. And become at last what you were made to be.' },
  { id: 'dvar-12', voice: 'narrator', text: 'And in the front row, one talmid drank in every word.' },
  { id: 'dvar-13', voice: 'narrator', text: 'Chaim Barer.' },

  // ---- the chavrusa cut-scene (src/chavrusa.js beats) — Zehnwirth & Barer learn -----
  { id: 'zehn-1', voice: 'zehnwirth', text: 'The Gemara could not be clearer, Chaim.' },
  { id: 'zehn-2', voice: 'zehnwirth', text: 'Ha-ba l’horgecha, hashkem l’horgo — if a man comes to kill you, rise early and kill him first.' },
  { id: 'zehn-3', voice: 'zehnwirth', text: 'The Torah does not ask you to wait for the knife. It commands you to see it coming.' },
  { id: 'zehn-4', voice: 'barer', text: 'But Rebbe — the halacha is narrow. A rodef, caught in the very act. There must be certainty. A warning.' },
  { id: 'zehn-5', voice: 'zehnwirth', text: 'A warning. You would offer the wolf a warning?' },
  { id: 'zehn-6', voice: 'barer', text: 'The poskim limit it. Chazal themselves feared the zealot — too eager to spill blood.' },
  { id: 'zehn-7', voice: 'zehnwirth', text: 'Chazal feared the lazy, Chaim, not the zealous. Pinchas convened no beis din. He saw the desecration, and he struck. And the Ribono shel Olam called it a covenant of peace.' },
  { id: 'zehn-8', voice: 'barer', text: 'But that was Pinchas. One man, one moment. Who am I to decide?' },
  { id: 'zehn-9', voice: 'zehnwirth', text: 'Who are you? A soldier who dresses his cowardice as piety! While you weigh the limits, the rodef already walks these halls.' },
  { id: 'zehn-10', voice: 'zehnwirth', text: 'He wears his hunger like a talis — and you would beg him for a warning?! There is no warning. There is the one who strikes, and the one who is struck. Choose what you are.' },
  { id: 'zehn-11', voice: 'barer', text: 'I understand, Rebbe.' },
  { id: 'zehn-12', voice: 'bachur', text: 'Rebbe Zehnwirth! Come quick — a madman in the yeshiva! Room to room, he’s beating the kugel out of every bachur — no one can stop him!' },
  { id: 'zehn-13', voice: 'barer', text: 'Stay, Rebbe. I will meet him myself. My life, my soul — I give them to the Satan. Let him move my hands.' },

  // ---- the Barer finisher (src/finisher.js) ---------------------------------
  { id: 'finisher-lewie', voice: 'player', text: 'LEWIE BALLEWIE!' },
];

// Convenience: just the ids, for preloading.
export const VO_IDS = VO_LINES.map((l) => l.id);
