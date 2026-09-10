# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm install
npm run install:browser   # playwright install chromium — required before first run
npm start                 # node server.js  → http://localhost:3210 (binds 127.0.0.1 only)
npm run dev               # node --watch server.js
npm test                  # node --test (node:test runner, discovers test/*.test.js)
```

Run one file or one case:

```bash
node --test test/video.test.js
node --test --test-name-pattern="FFmpeg giữ nguyên hai clip"
```

Tests never call the real ChatGPT/Grok sites: browser-dependent tests build fake DOM with `page.setContent()` or serve a local `http.createServer` fixture, so they cost no video-generation credits. Keep new tests that way.

## Architecture

Local-only Express app that drives **ChatGPT** and **Grok Imagine** through Playwright (no APIs — it reuses the user's logged-in web sessions) and stitches the results with FFmpeg.

Pipeline, all orchestrated inside `runQueue()` in [server.js](server.js):

```
input (topic | youtube | upload)
  → [youtube] yt-dlp download             lib/youtube.js
  → ffmpeg probe (duration/size/rotation) lib/video.js
  → ffmpeg contact sheets (video→images) lib/video.js
  → ChatGPT: JSON storyboard plan         lib/chatgpt.js + lib/prompt-plan.js
  → Grok: one clip per plan part          lib/grok.js
  → ffmpeg normalize + concat             lib/video.js
```

**Clip length is one number that everything derives from.** Grok offers 5s/10s/15s; `GROK_CLIP_SECONDS` (default `15,10`) is a preference list and its first entry becomes `job.clipSeconds` at creation. `expectedPartCount(duration, clipSeconds) = ceil(duration/clipSeconds)` is the single source of truth for how many Grok generations a job costs — 60s is 4 parts at 15s, 6 parts at 10s. Output is intentionally *not* trimmed to match source length, so a 36s source at 15s yields ~45s of output. `MAX_VIDEO_PARTS` (default 30) is a spend guard checked in both the POST handler and `runQueue`.

`job.clipSeconds` is frozen when the job is created, because the ChatGPT plan, the storyboard ranges, the part fingerprints and the FFmpeg join all commit to it. **Jobs loaded from `data/jobs.json` without the field are pinned to 10** (`clipSecondsOf()`), so retrying old work still reuses its cached plan and clips. Changing the preference only affects new jobs; it never re-cuts an existing one.

Anything that reads or writes a clip length must take it from `job.clipSeconds`, never a literal 10 — that includes `parseTargetDuration` (target must be a whole multiple of it), `clipDurationWindow()` (± 1.5s, used by both `validateGrokVideoMetadata` and `reusableVideoPart`), every `build*Prompt`/`buildGrok*PartJob`, and the UI, which reads `GET /api/config` on load to size its duration input.

### Job queue and state

- Jobs live in memory in `server.js` (`let jobs`) and are mirrored to `data/jobs.json` via [lib/store.js](lib/store.js), which serializes writes through a promise chain and does atomic tmp-file + rename. `saveJobsInBackground()` is the fire-and-forget variant used for high-frequency progress messages.
- Strictly sequential: the `working` flag means one job at a time, because both Playwright contexts are single shared browser sessions. Login/debug endpoints refuse while `working` is true.
- On startup, jobs left `running` are marked `failed` (the browser session did not survive the restart).
- `publicJob()` strips `sourcePath`, `aiPlan`, and `aiStory` before sending to the client — keep internals out of `/api/jobs`.

### Caching and resume (fingerprints)

Three SHA-256 fingerprints decide what may be reused; changing generation semantics means bumping/extending them, or stale work will silently be reused:

- `sourcePlanFingerprint` (schemaVersion 4) — source-video plan; invalidated when prompt, source duration, aspect ratio, target duration, language, clip length, or `writeStory` changes. `legacyPlanIsCompatible` grandfathers plans saved before fingerprints existed.
- `autoTopicPlanFingerprint` (schemaVersion 2) — trend plan; includes the clip length and `trendDateKey()`, so trend research re-runs the next day.
- `partFingerprint` — per-clip; written next to each clip as `<part>.mp4.manifest.json`. `reusableVideoPart()` re-accepts a clip only if the manifest fingerprint matches *and* the file re-probes inside `clipDurationWindow(job.clipSeconds)`, ≥720p, and the right aspect ratio. It folds in a `referenceDigest` **only when the part has references**, so clips cached before reference images existed stay reusable.

Three actions restart a stopped job, and they differ only in what they reuse — keep that distinction intact:

- **Retry** (`failed` or `cancelled`) keeps everything and resumes from the first non-reusable part.
- **Rerun / "Tạo lại video"** (`done`, `failed` or `cancelled`) keeps the cached AI plan but calls `removeJobArtifacts()` first, so every clip is regenerated. Without that deletion `reusableVideoPart()` would hand back the identical parts and "recreate" would produce a byte-identical video.
- **Delete** removes the job plus its source, uploads, outputs and plan.

Part files and manifests are deleted after a successful join, so a rerun of a `done` job has nothing to discard anyway; the deletion matters for `failed`/`cancelled` jobs that still hold partial clips.

### Cancellation (`lib/cancel.js`)

Cancelling is **cooperative** — `runQueue()` is a single async loop and nothing can interrupt an in-flight Playwright call. `POST /api/jobs/:id/cancel` sets `job.cancelRequested`; `throwIfCancelled()` is checked at every part-loop iteration, before the FFmpeg join, and inside the two long poll loops (`waitForNewVideo` in `lib/grok.js`, `waitForChatGPTResponse` in `lib/chatgpt.js`). Every `generateWithGrok` / `*WithChatGPT` call takes an `isCancelled` callback — **add one to any new generation call**, or that stage becomes uncancellable.

A cancel therefore lands within a couple of seconds while waiting on ChatGPT or Grok, but can take until the current `locator.waitFor` timeout when stuck inside one. Grok generations already submitted are still charged.

`runQueue`'s catch treats `job.cancelRequested || isCancellation(error)` as status `cancelled`, not `failed`, so a cancel never writes an `error` or triggers diagnostics capture. `cancelRequested` is cleared on startup, on requeue, and when a job starts running — a stale flag would silently kill the next run.

### ChatGPT layer (`lib/chatgpt.js` + `lib/prompt-plan.js`)

All prompt text and all response parsing/validation live in `lib/prompt-plan.js` — it is pure, provider-neutral (`buildStoryboardPrompt`, `parseStory`, …), and it is where most unit tests point. `lib/chatgpt.js` only handles the browser: attach, submit, wait, and a **repair round-trip** (on parse failure it sends a `build*RepairPrompt` back into the same conversation, so the attached frames are still in context).

**ChatGPT cannot take a video file**; the app used to rely on Gemini watching the upload with its audio. `withSourceFrames()` runs `extractContactSheets()` from `lib/video.js` (up to 36 frames, ~1 per 2 s, tiled 3×3), attaches the sheets, appends `describeContactSheets()` to the prompt (read order, time range per sheet, "no audio"), and deletes the sheets afterwards. **Source audio is lost**: dialogue and narration in the source are not analysed, and the prompts tell the model not to invent them. Sheets are named `<job-id>-ref-sheet-NN.jpg` so `removeJobArtifacts()` sweeps leftovers too.

Modes: describe source video → story → storyboard (upload/YouTube), auto-topic trend research (must return real `sources[]` URLs; a plan without a valid http(s) source is rejected by the parser), topic story + storyboard for Trendflare, and the 16:9 thumbnail (ChatGPT image generation, captured by element screenshot once the stop button is gone, with an HTML poster fallback).

**Signed-in detection differs from Gemini.** chatgpt.com renders a usable composer to signed-out visitors, so `assertChatGPTSignedIn()` treats a visible `Log in` / `Sign up` control as signed out, and a `Just a moment…` title as a bot challenge the user must clear by hand. Never automate past that challenge.

`waitForChatGPTResponse()` is the fragile part. It detects a new `[data-message-author-role="assistant"]` by comparing counts taken before submit, falling back to `article[data-testid^="conversation-turn"]` — but only once **two** new turns exist, because the user's own turn appears first and taking it would return our prompt as the answer. It then requires ≥20 chars unchanged for 3 polls with no stop button or `.result-streaming`, and throws immediately on a rate-limit / "something went wrong" banner instead of handing it to a parser. Raw responses are saved to `data/logs/<job-id>-chatgpt-raw-<attempt>.txt`.

**JSON replies and Markdown.** ChatGPT renders every reply as Markdown, and Markdown turns `\"` into `"` — so JSON that was valid when the model wrote it reaches `innerText` with bare quotes inside string values. Confirmed on a real failure: the whole JSON sat in one `<p>` whose `data-end` was 138 characters longer than the text we read, zero backslashes survived, while `\n` did (Markdown only consumes escapes before punctuation). Three layers handle it — keep all three:

- Every JSON prompt includes `JSON_CODE_BLOCK_RULE` from `prompt-plan.js` (answer inside one ```json block, which keeps backslashes). **Never reintroduce "Do not use Markdown fences"**; `test/json-retry.test.js` checks every builder.
- `requestJson()` reads with `preferCodeBlock: true`, so `waitForChatGPTResponse` returns the `<pre><code>` `textContent`. Free-text stages (video description) must not set it, or a stray code snippet would replace the whole answer.
- Parsers go through `parseLenientJson()`, which retries `JSON.parse` after `escapeStrayQuotes()` for replies that ignore the rule.

On top of that, `requestJson()` retries in the same conversation (attached frames stay in context) up to `CHATGPT_JSON_MAX_ATTEMPTS` (default 3, capped at 6), each retry quoting the exact parse error via `jsonRetryInstruction()`. The loop itself is the pure `runJsonAttempts()` so it is unit-tested without a browser; errors thrown while *sending* (lost page, cancellation) stop it immediately instead of burning attempts.

**Selector provenance:** the composer selectors (`textarea[aria-label="Chat with ChatGPT"]`, `Send message`, `Add files and more`, `Log in`) were read from the live signed-out page in Sept 2026. The signed-in assistant-turn markup could not be inspected without an account and is covered only by fixtures. When a live run fails, read `data/logs/<job-id>-chatgpt-error.html` (or `/api/debug/chatgpt`) and correct the fixtures in `test/chatgpt-response.test.js` before changing selectors.

Jobs saved while the app used Gemini stored `geminiPlan`, `geminiStory`, …; `LEGACY_JOB_FIELDS` in `server.js` renames them to `aiPlan`, `aiStory`, … on startup so their cached work stays reusable.

### Grok layer (`lib/grok.js`)

`ensureVideoSettings()` re-asserts Video mode → 10s → best resolution → aspect ratio, then re-asserts duration and resolution again (changing the aspect ratio resets them). Resolution policy is **prefer 1080p, fall back to 720p**; anything lower is rejected by `validateGrokVideoMetadata()` after download.

Grok has shipped **two different composer UIs**, and both are supported — do not delete either path without checking a fresh diagnostic dump:

- *Menu form (current)*: duration and resolution are dropdown buttons (`aria-label="Video duration"` / `"Video resolution"`) opening `role="menuitemradio"` lists; options carry descriptive suffixes (`16:9 Widescreen`, not `16:9`). Handled by `menuButton()` / `selectPreferredFromMenu()`, matching with `optionPattern()` (leading token + `\b`), never `exactTextPattern()`.
- *Radio form (older)*: duration and resolution are `role="radio"` named `10s` / `1080p`. Still the fallback path in `ensureDuration()` and `selectBestResolution()`.

Only Image/Video/Agent stayed a radiogroup across both.

`ensureDuration()` must hit `job.clipSeconds` exactly — the plan was already divided against it, so a different length is not a graceful degradation. When the menu does not offer it, it throws naming both what Grok did offer and `GROK_CLIP_SECONDS`, rather than silently producing clips `validateGrokVideoMetadata()` would then reject one by one.

New-result detection: `stabilizeKnownVideos()` snapshots existing `video[src*="generated_video.mp4"]` URLs (canonicalized without query/hash) until no new ones appear, then `waitForNewVideo()` treats URLs appearing within `GROK_RESULT_GRACE_MS` as pre-existing lazy loads rather than the fresh result — this prevents downloading a stale clip.

Prompts are built by `buildGrok*PartJob()` in `lib/prompt-plan.js`; each takes an optional `{ references }` and, when present, appends a `REFERENCE IMAGES` block naming each attachment's role in upload order. Downloads try Playwright's request context 3× then cookie-forwarded `fetch` 3×.

### Reference images (`lib/references.js`)

`buildPartReferences()` assembles up to `MAX_REFERENCE_IMAGES` (default 3) attachments per part, in the order Grok receives them: user uploads → a frame cut from the source video's range for that part → the previous clip's last frame. `useReferenceFrames` (a UI checkbox, default on) gates the two automatic frames; user uploads always apply. Frames are cut by `extractFrame()` in `lib/video.js` (`-sseof` for the tail frame, capped at 1280px long edge). Extraction failures log a warning and drop that one reference rather than failing the job.

The chained tail frame is what makes `referenceDigest` load-bearing: it hashes real pixel content, so regenerating part N automatically invalidates parts N+1… — correct for continuity, and retry stays cheap because reused parts have unchanged tails. Derived frames are deleted via `removeReferenceFrames()` right after each part (user uploads are kept for retry/rerun).

**Unverified against the live site**: whether Grok accepts multiple images at once, and whether an image upload locks the aspect-ratio or 1080p controls. `ensureVideoSettings()` re-runs at phase `after_upload` and `validateGrokVideoMetadata()` rejects a wrong-ratio or sub-720p result, so a mismatch fails loudly rather than silently shipping a distorted clip.

`openGrokImaginePage()` waits for `commit` rather than `domcontentloaded` (Grok sometimes never fires it) and then polls for the composer radio or a sign-in control, opening fallback tabs for up to 3 attempts.

### Selector policy

Both automation modules target **ARIA roles and accessible names** with regexes covering English *and* Vietnamese UI text, funnelled through `firstVisible([...])` fallback chains. Do not hardcode CSS classes or generated ids (Grok's are Tailwind soup and its menu ids are `radix-_r_e4_`-style generated). When ChatGPT/Grok change their UI, the fix belongs in `lib/chatgpt.js` / `lib/grok.js`; `/api/debug/grok`, `/api/debug/chatgpt`, and `/api/debug/grok/settings` dump the live accessible tree to help.

**Diagnosing a selector break**: every failed job already saved `data/logs/<job-id>-error.html` (full page HTML) and `-error.png`. Grep that dump for `aria-label="..."`, `role="radio"`, and `role="menuitemradio"` to see the real markup at failure time, then reproduce it as a `page.setContent()` fixture in a test before changing the selector — that is how the menu-form support above was built and is cheaper than re-running a live job.

### Facebook Reels (`lib/facebook.js`)

Auto-posting runs from `publishJobReel()` in [server.js](server.js), **after** the job is already marked `done`. That ordering is deliberate: the video has already cost Grok generations, so a posting failure is recorded on `reelStatus`/`reelError` and never flips the job back to `failed`.

`publishReel()` implements Meta's three-phase Video API — `upload_phase=start` on `/{page-id}/video_reels` returns a `video_id`, the bytes go to `rupload.facebook.com/video-upload/{version}/{video_id}`, then `upload_phase=finish` with `video_state=PUBLISHED`, followed by polling `GET /{video_id}?fields=status` until `publishing_phase.publish_status` settles.

**The Page access token is a credential.** It travels only in an `Authorization` header (`Bearer` for Graph, `OAuth` for rupload) and never in a URL, because URLs end up in error strings and JSON-Lines logs. `redactFacebookSecrets()` is wired into `sanitizeError()` in [lib/logger.js](lib/logger.js) as the backstop — keep that import, and never put the token in a query string.

Reels constraints (`REEL_LIMITS`) are **9:16, 3–90s, ≥540x960**, and they collide with the app's own defaults in two places: topic mode would otherwise default to `16:9`, so `postToReels` forces `9:16` at job creation; and `MAX_VIDEO_PARTS` allows far more than 90 seconds, so an over-long target is rejected in the POST handler. Anything that survives to post time is re-checked by `reelRejectionReason()` against the actual probed output.

Reels publish only to a **Facebook Page** — personal profiles and Groups are not supported by the API, so do not add a "post to profile" path.

The `postToReels` checkbox defaults to **off** and is hidden entirely unless `GET /api/config` reports `facebookConfigured`. Posting is public and irreversible; keep that default.

### FFmpeg join (`lib/video.js`)

`joinParts()` builds one `filter_complex` that normalizes every clip to a fixed canvas from the `aspectCanvas[resolution][aspectRatio]` table, 30 fps CFR, and 48 kHz stereo AAC (synthesizing silence with `anullsrc` for clips without audio) before `concat`. It writes to a temp file, re-probes it, and refuses to publish output whose dimensions, audio presence, or total duration do not match expectations. `getVideoMetadata()` parses FFmpeg stderr (no ffprobe) and swaps width/height for 90°-rotated sources.

## Conventions

- ESM only (`"type": "module"`), Node 24, no build step, no framework on the front end — `public/app.js` is plain DOM with a 3-second `/api/jobs` poll.
- All user-facing strings (UI, job messages, thrown `Error` messages) are **Vietnamese**; prompts sent to ChatGPT/Grok and log event names are **English**. Test names are Vietnamese too.
- Every job writes JSON Lines to `data/logs/<job-id>.log` via `logJob(jobId, event, details)`, with dotted event names (`chatgpt.plan.saved`, `grok.video.ready`). Add a log line for any new decision point — these logs are the primary debugging tool for headed-browser failures. Errors go through `sanitizeError()`, which strips ANSI codes and redacts cookie headers out of Playwright errors.
- On failure, `captureGrokDiagnostics` / `captureChatGPTDiagnostics` write a full-page screenshot and page HTML to `data/logs/`.
- Config is env-var only (see [.env.example](.env.example)); there is no `.env` loader, so setting PowerShell env vars before `npm start` is the intended mechanism.
- Everything under `data/` is gitignored, including the two persistent Chromium profiles that hold the Google and Grok sessions.
- `POST /api/jobs` is `multipart/form-data` through `receiveUpload` (multer `.fields()`, video + referenceImages). Any rejection path must delete every file multer already wrote — `removeUploadedFiles(req)` — or `data/uploads` accumulates orphans.
- `yt-dlp.exe` is pinned by version and SHA-256 in `lib/youtube.js` and downloaded to `data/tools/` on first use; bump both together (Windows-only path).
