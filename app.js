// StudyLite: hybrid on-device / cloud AI study buddy built on Firebase AI Logic.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app-check.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, collection, addDoc, query, orderBy, onSnapshot, deleteDoc, doc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { getRemoteConfig, fetchAndActivate, getValue } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-remote-config.js";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-ai.js";
import { firebaseConfig, APP_CHECK_SITE_KEY } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const configured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_");

// ---------- Sample notes (for demos) ----------
const PARAS = [
  "Photosynthesis is the process plants, algae and some bacteria use to turn light energy into chemical energy. It takes place in chloroplasts, which contain the green pigment chlorophyll. Chlorophyll absorbs mostly red and blue light and reflects green, which is why leaves look green. The overall reaction combines carbon dioxide and water, using light, to produce glucose and oxygen.",
  "The light-dependent reactions happen in the thylakoid membranes. Light excites electrons in chlorophyll, and water is split to replace them, releasing oxygen as a by-product. The energy carried by the electrons is used to make ATP and NADPH. These two molecules act as short-term energy stores that power the next stage of photosynthesis.",
  "The Calvin cycle takes place in the stroma of the chloroplast. It uses ATP and NADPH to fix carbon dioxide into sugars. The enzyme RuBisCO attaches carbon dioxide to a five-carbon molecule called RuBP. After several steps, the cycle produces G3P, which cells combine to build glucose, starch and cellulose. The cycle does not need light directly, but it depends on the products of the light reactions.",
  "Cellular respiration is the reverse partner of photosynthesis. Cells break down glucose in the presence of oxygen to release usable energy as ATP, producing carbon dioxide and water. It has three main stages: glycolysis in the cytoplasm, the Krebs cycle in the mitochondrial matrix, and the electron transport chain on the inner mitochondrial membrane, which produces most of the ATP.",
  "Glycolysis splits one glucose molecule into two pyruvate molecules and gives a small net gain of two ATP. If oxygen is present, pyruvate enters the mitochondria and is converted to acetyl-CoA for the Krebs cycle. If oxygen is missing, cells use fermentation instead: animals make lactic acid, while yeast makes ethanol and carbon dioxide. Fermentation yields far less ATP than aerobic respiration.",
  "Several factors limit the rate of photosynthesis: light intensity, carbon dioxide concentration and temperature. At low light, more light speeds up the reaction until another factor becomes limiting. Very high temperatures denature enzymes such as RuBisCO and slow the process. Gardeners use this idea in greenhouses by controlling light, carbon dioxide and heat to raise crop yields."
];
const SAMPLE_SHORT = PARAS.slice(0, 2).join("\n\n");
const SAMPLE_LONG = PARAS.join("\n\n");

// ---------- Prompts ----------
const PROMPTS = {
  summary: (n) => `Summarize these study notes in 5 short bullet points. Each bullet starts with "- ". Plain text only.\n\nNOTES:\n${n}`,
  cards: (n) => `Create up to 8 flashcards from these study notes. Reply with ONLY a JSON array, no other text. Each item is {"q": "question", "a": "short answer"}.\n\nNOTES:\n${n}`,
  quiz: (n) => `Create 4 multiple-choice questions from these study notes. Reply with ONLY a JSON array, no other text. Each item is {"q": "question", "options": ["A","B","C","D"], "answer": 0, "why": "one sentence explanation"}, where answer is the index (0-3) of the correct option.\n\nNOTES:\n${n}`
};

// ---------- State ----------
let user = null;
let current = null; // { task, data, source, ms, notes }
let hybridModel = null; // PREFER_ON_DEVICE (or PREFER_IN_CLOUD, set by Remote Config)
let cloudModel = null;  // ONLY_IN_CLOUD, used for long documents
let db = null;
let longChars = 2000;
let unsubscribeSets = null;

// ---------- Firebase setup ----------
let app, auth, ai;
if (configured) {
  app = initializeApp(firebaseConfig);

  // App Check is required by Firebase AI Logic. On localhost we use a debug token.
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });

  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache() }); // lets saved sets work offline
  ai = getAI(app, { backend: new GoogleAIBackend() });
  hybridModel = buildHybridModel(false);
  cloudModel = getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD });
} else {
  $("setupBanner").hidden = false;
}

// Hybrid inference: use Gemini Nano in Chrome when available, otherwise fall back to the cloud.
function buildHybridModel(preferCloud) {
  return getGenerativeModel(ai, {
    mode: preferCloud ? InferenceMode.PREFER_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }]
      }
    }
  });
}

// Remote Config lets us change routing without redeploying.
async function loadRemoteConfig() {
  if (!configured) return;
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 3600000;
    rc.defaultConfig = { prefer_cloud: false, long_doc_chars: 2000 };
    await fetchAndActivate(rc);
    longChars = Number(getValue(rc, "long_doc_chars").asNumber()) || 2000;
    hybridModel = buildHybridModel(getValue(rc, "prefer_cloud").asBoolean());
  } catch (e) {
    console.warn("Remote Config unavailable, using defaults.", e);
  }
  updateHint();
}

// ---------- Status chips ----------
function setChip(dotId, textId, cls, text) {
  $(dotId).className = "dot " + cls;
  $(textId).textContent = text;
}
function updateNet() {
  navigator.onLine ? setChip("netDot", "netText", "ok", "Online") : setChip("netDot", "netText", "off", "Offline");
}
async function checkNano() {
  try {
    if (typeof LanguageModel === "undefined") {
      return setChip("nanoDot", "nanoText", "warn", "Gemini Nano not in this browser, using cloud");
    }
    const a = await LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }]
    });
    if (a === "available") setChip("nanoDot", "nanoText", "ok", "Gemini Nano ready");
    else if (a === "downloadable" || a === "downloading") setChip("nanoDot", "nanoText", "warn", "Gemini Nano downloading, cloud for now");
    else setChip("nanoDot", "nanoText", "warn", "Gemini Nano unavailable, using cloud");
  } catch {
    setChip("nanoDot", "nanoText", "warn", "Gemini Nano unavailable, using cloud");
  }
}
window.addEventListener("online", updateNet);
window.addEventListener("offline", () => { updateNet(); updateHint(); });
updateNet();
checkNano();

// ---------- Routing hint ----------
function updateHint() {
  const n = $("notes").value.trim().length;
  const hint = $("routeHint");
  if (!n) { hint.textContent = ""; return; }
  hint.textContent = n > longChars
    ? `${n.toLocaleString()} characters: long document, this will run in the cloud.`
    : `${n.toLocaleString()} characters: this will run on-device when Gemini Nano is available.`;
}
$("notes").addEventListener("input", updateHint);

// ---------- Small DOM helper ----------
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  kids.forEach((c) => c != null && node.append(c));
  return node;
}
function say(text, info = false) {
  const m = $("message");
  m.textContent = text || "";
  m.classList.toggle("info", info);
}

// ---------- Run a task ----------
function setBusy(busy) {
  document.querySelectorAll("[data-task]").forEach((b) => (b.disabled = busy));
}
function parseJson(text) {
  const clean = text.replace(/```json|```/g, "");
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s === -1 || e === -1) throw new Error("No JSON found");
  return JSON.parse(clean.slice(s, e + 1));
}

async function run(task) {
  say("");
  if (!configured) return say("Add your Firebase config in firebase-config.js first.");
  const notes = $("notes").value.trim();
  if (notes.length < 40) return say("Paste at least a few sentences of notes first.");

  const isLong = notes.length > longChars;
  const model = isLong ? cloudModel : hybridModel;
  setBusy(true);
  say(isLong ? "Working in the cloud..." : "Working...", true);
  $("saveBtn").disabled = true;
  const t0 = performance.now();
  try {
    const result = await model.generateContent(PROMPTS[task](notes));
    const text = result.response.text();
    const src = result.response.inferenceSource || (isLong ? "IN_CLOUD" : "");
    const source = /on[_-]?device/i.test(String(src)) ? "device" : "cloud";
    const ms = Math.round(performance.now() - t0);

    let data = text;
    if (task !== "summary") {
      try { data = parseJson(text); } catch { data = null; }
    }
    if (task !== "summary" && !Array.isArray(data)) {
      say("The model's answer wasn't in the expected format. Try again.");
      return;
    }
    current = { task, data, source, ms, notes };
    render(current);
    say("");
    $("saveBtn").disabled = !user;
  } catch (err) {
    console.error(err);
    if (!navigator.onLine && isLong) {
      say(`You're offline. Long documents need the cloud. Shorten the notes to under ${longChars.toLocaleString()} characters to study offline.`);
    } else if (!navigator.onLine) {
      say("You're offline and Gemini Nano isn't ready on this browser. Try again once it has downloaded or you are back online.");
    } else {
      say("Something went wrong generating that. Check your Firebase and App Check setup, then try again.");
    }
  } finally {
    setBusy(false);
  }
}

// ---------- Render ----------
function render({ task, data, source, ms }) {
  const route = $("route");
  route.hidden = false;
  route.dataset.source = source;
  route.replaceChildren(
    el("span", { text: source === "device" ? "Ran on-device with Gemini Nano" : "Ran in the cloud" }),
    el("span", { class: "ms", text: ms ? `${(ms / 1000).toFixed(1)} s` : "" })
  );

  const out = $("output");
  out.replaceChildren();
  if (task === "summary") {
    const lines = String(data).split("\n").map((l) => l.trim()).filter(Boolean);
    const bullets = lines.filter((l) => /^[-*•]\s+/.test(l));
    if (bullets.length) {
      out.append(el("ul", {}, ...bullets.map((l) => el("li", { text: l.replace(/^[-*•]\s+/, "").replace(/\*\*/g, "") }))));
    } else {
      lines.forEach((l) => out.append(el("p", { text: l.replace(/\*\*/g, "") })));
    }
  } else if (task === "cards") {
    const wrap = el("div", { class: "cards" });
    data.forEach((c, i) => {
      const label = el("small", { text: "Question" });
      const body = el("span", { text: String(c.q ?? "") });
      const btn = el("button", { class: "fcard", type: "button", "aria-pressed": "false", "aria-label": `Flashcard ${i + 1}. Select to reveal the answer.` }, label, body);
      btn.addEventListener("click", () => {
        const flipped = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", String(!flipped));
        label.textContent = flipped ? "Question" : "Answer";
        body.textContent = String(flipped ? c.q : c.a);
      });
      wrap.append(btn);
    });
    out.append(wrap);
  } else if (task === "quiz") {
    data.forEach((q) => {
      const why = el("p", { class: "why", hidden: "" });
      const opts = el("div", { class: "opts" });
      (q.options || []).forEach((o, idx) => {
        const b = el("button", { class: "opt", type: "button", text: String(o) });
        b.addEventListener("click", () => {
          [...opts.children].forEach((x, j) => {
            x.disabled = true;
            if (j === q.answer) x.classList.add("good");
          });
          if (idx !== q.answer) b.classList.add("bad");
          why.textContent = (idx === q.answer ? "Correct. " : "Not quite. ") + (q.why || "");
          why.hidden = false;
        });
        opts.append(b);
      });
      out.append(el("div", { class: "q" }, el("p", { text: String(q.q ?? "") }), opts, why));
    });
  }
}

// ---------- Auth ----------
function updateAuthUi() {
  $("googleBtn").hidden = !!user;
  $("guestBtn").hidden = !!user;
  $("signOutBtn").hidden = !user;
  $("authText").textContent = user
    ? (user.isAnonymous ? "Signed in as a guest." : `Signed in as ${user.displayName || user.email}.`)
    : "Sign in to save your study sets.";
  $("saveBtn").disabled = !user || !current;
}
if (configured) {
  onAuthStateChanged(auth, (u) => {
    user = u;
    updateAuthUi();
    watchSets();
  });
  $("googleBtn").addEventListener("click", () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => say("Google sign-in failed: " + e.code)));
  $("guestBtn").addEventListener("click", () => signInAnonymously(auth).catch((e) => say("Guest sign-in failed: " + e.code)));
  $("signOutBtn").addEventListener("click", () => signOut(auth));
}

// ---------- Saved sets (Firestore) ----------
function watchSets() {
  if (unsubscribeSets) { unsubscribeSets(); unsubscribeSets = null; }
  const list = $("savedList");
  list.replaceChildren();
  $("savedEmpty").hidden = false;
  if (!user) return;
  const q = query(collection(db, "users", user.uid, "sets"), orderBy("createdAt", "desc"));
  unsubscribeSets = onSnapshot(q, (snap) => {
    list.replaceChildren();
    $("savedEmpty").hidden = !snap.empty;
    snap.forEach((d) => {
      const s = d.data();
      const names = { summary: "Summary", cards: "Flashcards", quiz: "Quiz" };
      const open = el("button", { class: "btn ghost", type: "button", text: "Open" });
      open.addEventListener("click", () => {
        let data = s.result;
        if (s.task !== "summary") { try { data = JSON.parse(s.result); } catch { return; } }
        $("notes").value = s.notes || "";
        updateHint();
        current = { task: s.task, data, source: s.source, ms: 0, notes: s.notes };
        render(current);
        $("saveBtn").disabled = true;
      });
      const del = el("button", { class: "btn ghost", type: "button", text: "Delete" });
      del.addEventListener("click", () => deleteDoc(doc(db, "users", user.uid, "sets", d.id)));
      list.append(el("li", {},
        el("div", {}, el("strong", { text: s.title || "Untitled" }), el("div", { class: "meta", text: `${names[s.task] || s.task}, made ${s.source === "device" ? "on-device" : "in the cloud"}` })),
        el("span", { class: "row" }, open, del)));
    });
  });
}

$("saveBtn").addEventListener("click", async () => {
  if (!user || !current) return;
  try {
    await addDoc(collection(db, "users", user.uid, "sets"), {
      title: current.notes.split("\n")[0].slice(0, 60),
      task: current.task,
      notes: current.notes.slice(0, 20000),
      result: current.task === "summary" ? String(current.data) : JSON.stringify(current.data),
      source: current.source,
      createdAt: serverTimestamp()
    });
    $("saveBtn").disabled = true;
    say("Saved.", true);
  } catch (e) {
    console.error(e);
    say("Couldn't save. Check your Firestore rules and try again.");
  }
});

// ---------- Wire up buttons ----------
document.querySelectorAll("[data-task]").forEach((b) => b.addEventListener("click", () => run(b.dataset.task)));
$("sampleShort").addEventListener("click", () => { $("notes").value = SAMPLE_SHORT; updateHint(); });
$("sampleLong").addEventListener("click", () => { $("notes").value = SAMPLE_LONG; updateHint(); });
$("clearBtn").addEventListener("click", () => {
  $("notes").value = ""; updateHint(); say("");
  $("route").hidden = true; current = null; $("saveBtn").disabled = true;
  $("output").replaceChildren(el("p", { class: "empty", text: "Paste notes on the left and pick what you want to make. Each result shows whether it ran on your device or in the cloud." }));
});

loadRemoteConfig();
