# History map fixes and frontend E2E verification

Date: October 14, 2026, approximately 9:44–9:51 PM America/Toronto.

## Changes

- A player who incorrectly guessed Human against an AI now retains their saved location pin in History.
- This preview explicitly explains that an AI opponent has no actual location. It never supplies a fake actual pin or incorrectly says those coordinates were lost.
- An opponent's actual location alone no longer enables a misleading “Their guess” map. A Human verdict or valid saved location guess is required. Model-family guesses and failed/missing guesses do not create empty opponent maps.
- Older valid pins without identity metadata still render; missing coordinates retain the existing honest empty state. Human rounds retain their actual-location preview even when the player guessed AI.
- The shared component applies the same fix to the admin archive.
- Synthetic development samples now include both regression cases. Production server, provider behavior, APIs, storage schemas, and CSS were not changed.

## Test environment

- Updated Vite frontend at `http://127.0.0.1:5175`, with a second independent player at `http://localhost:5175`. Different origins give these players separate browser storage.
- Isolated backend at port 3001: the real Express/Socket.IO game server with the existing local storage adapters, six synthetic initial rounds per player, synthetic Leaderboard, and local canned AI. Its data file is `backend/.local/qa-history-data.json`; the regular local and production stores were not used for game data.
- Browser: the available Codex in-app browser. Two independent player sessions, not two distinct browser engines. Chrome/Edge/Safari compatibility is not established by this run.
- Admin authentication used a disposable local-only password configured in the isolated process. Production administrator credentials were not accessed.
- Production provider behavior was not re-tested by this local run. Earlier live Gemini/Grok/ChatGPT checks are documented in the separate production report. The Grok final-guess failure remains outside this change; it was not conclusively attributed to OpenRouter from public UI evidence.

## Completed browser checks

| Scenario | Result and evidence |
| --- | --- |
| Wrong Human guess against AI, existing record | Sydney player pin rendered as one marker. Clear AI/no-actual-location explanation. Switching to Their guess rendered the opponent's Montreal pin against Ottawa, two markers, 166 km. |
| AI model guess with actual coordinates saved | Expanded ChatGPT sample still showed summary/explanation/transcript, with zero map elements. |
| Normal human comparison | Toronto/actual and opponent Montreal/Ottawa perspectives both rendered two markers and their respective saved distance. |
| Responsive History | Actual viewport widths 320, 768, and 1440, including switching perspectives. No horizontal document overflow. |
| Two independent players | Both completed normal consent/IP-location setup and matched one another. Turn ownership was complementary. |
| Turn enforcement | Out-of-turn Send disabled. Pretyped text survived until the player's turn and sent successfully. |
| Bidirectional chat | Four alternating, uniquely marked messages arrived once in each client. |
| Conversation reload | Reload restored all four messages, active ownership, and remaining timer. No duplicate message or scored round. |
| Confirmation and Back | Cancel kept the conversation open. Lock round moved both clients to guessing. AI → Back → Human remained usable. |
| Map submission | Lock human guess disabled without a pin; keyboard Enter placed a valid center pin. Both players submitted. |
| Pending opponent | First player's new-game action and finalizing button remained disabled until the other submitted; both results then finalized normally. |
| Human results and History | Both got correct identity and 0.3 location points. Each History increased from six samples to exactly seven rounds, containing all four messages with correct author perspective and both maps. |
| Fractional score reload | Homepage retained `0.3/1 · 30%` after reload and again after the later AI game. |
| Leaderboard | Unique name saved with Enter, persisted on reload, appeared in the row with seven games/71%. Next reached the final page with Next disabled; Previous returned to page one. Later player A row showed eight games/63%. Both test names restored to blank. Input limit remained 20. |
| Local authenticated admin | Sign in loaded the waiting player and later active AI room. Archive search narrowed to one player (seven records), and expanded AI history used the corrected map component. Session survived refresh; Log out returned to the locked login. |
| Normal AI matchmaking | Used the public queue with no forced-model shortcut. Waited for the opponent and two actual local AI replies before guessing. |
| Mobile AI gameplay | Actual 375×812 viewport. Two messages each; manually locked chat, chose Human, placed a pin, and submitted. Reveal identified Claude and correctly scored zero. Result finalized with the mock AI's unavailable guess. |
| New AI History regression | History increased from seven to exactly eight. Four-message transcript saved. The wrong Human pin appeared in exactly one map with one marker, no perspective switch, and the AI/no-actual-location explanation. The same state survived direct History refresh. |
| Abort handling | Two setup attempts expired before the minimum exchange. Both displayed the early-abort notice and allowed restart. Neither added scored History records or points; the final count was exactly six samples plus one completed human and one completed AI round. These aborted attempts are not counted as successful AI conversations. |
| Other mobile pages | Homepage and Leaderboard inspected at 320px; authenticated admin at 320px; AI chat, decision, result, and History at 375px. No horizontal overflow; controls remained usable. This does not test a physical phone's keyboard/touch behavior. |
| Browser logs | No errors or warnings across the three local QA tabs at the end of the gameplay checks. |

## Automated verification

- Frontend: 12 passing tests (four existing storage tests and eight new History map component tests).
- The new tests render the real HistoryMap component, replacing only the browser-only Leaflet renderer. They check missing/model guesses, wrong Human-vs-AI pin retention, opponent location guesses, both perspective controls, human actual-location previews, legacy pins, missing coordinates, and invalid pins. Actual Leaflet markers and perspective switching were separately checked in the browser.
- Backend: 53 passing existing tests.
- Frontend production build succeeded: `index-BcGrllXc.js`, unchanged stylesheet `index-DN-yf6z0.css`.
- `git diff --check` passed.

These are 65 automated component/storage/backend tests plus the manual E2E scenarios above, not 65 automated browser tests. No new regression was found in the exercised paths. No deployment was performed, so the History fixes still need deployment and a short production verification afterward. The prior production www redirect finding remains passing; this local run does not change hostname configuration.
