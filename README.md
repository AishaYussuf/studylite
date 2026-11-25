# StudyLite

An AI study buddy that works offline. Paste your notes and get a summary, flashcards or a quiz. Short tasks run **on-device with Gemini Nano**; long documents or browsers without a local model **fall back to the cloud**. Built for the #BuildHybridAI hackathon with **Firebase AI Logic hybrid inference**.

## Why it exists
Many students study on slow, expensive or unreliable internet, and cloud AI tools stop working when the connection drops. StudyLite keeps the common tasks private, free and available offline, and only uses the cloud when it has to.

## How Firebase AI Logic is used
All AI calls are in [`app.js`](app.js):

- `getAI(app, { backend: new GoogleAIBackend() })` creates the AI Logic instance.
- `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE })` is the hybrid model. It uses Gemini Nano in Chrome when available and falls back to the cloud otherwise.
- `getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD })` handles long documents that exceed the on-device limit.
- `result.response.inferenceSource` tells us where each answer ran, and the UI shows it as an **on-device** or **cloud** label.

Other Firebase products: **App Check** (required by AI Logic), **Authentication** (Google and guest), **Cloud Firestore** (saved study sets, with offline cache), **Remote Config** (`prefer_cloud` and `long_doc_chars` change routing without a redeploy).

## Features
- Summaries, flashcards (tap to flip) and multiple-choice quizzes
- Live status for connection and Gemini Nano availability
- A hint before you run showing whether the task will run on-device or in the cloud
- Save, reopen and delete study sets per user

## Run it
Requires Chrome with Gemini Nano enabled for on-device inference. Other browsers still work through the cloud fallback.

1. Create a Firebase project and add a **Web app**. Paste its config into `firebase-config.js`.
2. In the Firebase console, enable **Firebase AI Logic** (Gemini Developer API).
3. Enable **App Check** with reCAPTCHA v3 for the web app and put the site key in `firebase-config.js`. For local testing, open the browser console, copy the App Check debug token it prints, and register it in App Check > Apps > Manage debug tokens.
4. Enable **Authentication** providers: Google and Anonymous.
5. Create a **Firestore** database and deploy `firestore.rules`.
6. (Optional) In **Remote Config**, add `prefer_cloud` (Boolean, `false`) and `long_doc_chars` (Number, `2000`).
7. Serve locally: `npx serve .` (or `python -m http.server 8000`) and open `http://localhost:8000`.
8. Deploy: `firebase deploy --only hosting,firestore:rules`.

### Enable Gemini Nano in Chrome
Use a recent desktop Chrome. Open `chrome://flags`, enable **Prompt API for Gemini Nano** and **Optimization Guide On Device Model**, relaunch, then check `chrome://on-device-internals` to confirm the model has downloaded. Requirements and flag names change between Chrome versions, so see Firebase's hybrid inference guide for the current steps.

## Try the hybrid routing
1. Select **Use short sample** and **Summarize**. It should show *Ran on-device*.
2. Turn on airplane mode and run it again. It still works.
3. Select **Use long sample** while online. It should show *Ran in the cloud*.

## License
MIT. See [LICENSE](LICENSE).
