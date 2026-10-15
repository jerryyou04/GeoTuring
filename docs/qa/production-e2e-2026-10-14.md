# Production gameplay and page QA report

Date: October 14, 2026 (America/Toronto).

## Environment and scope

- Production frontend: `https://geoturing.com/`, JavaScript asset `index-RsEeI3wr.js`, stylesheet `index-DN-yf6z0.css`.
- Production backend: `https://api.geoturing.com`.
- Repository baseline: `87febc9` (`frontend revamp`). The deployed CSS matched that build.
- Browser: Codex in-app browser. Chrome and Edge automation were unavailable.
- Player A used geoturing.com directly. Player B loaded the same deployed frontend bytes through a loopback-only proxy, giving it independent origin storage. Its API and Socket.IO traffic still went directly to production.
- A third tab, sharing A's origin, tested ownership transfer of A's existing game.
- No mock backend, seeded coordinates, or response stubs were used. Both players completed the real rough-IP-location consent flow.
- Two human-vs-human rounds were scored. An earlier attempt timed out during test setup before messages were sent; both clients recovered correctly and that unscored round was absent from History.
- Tests created real anonymous game records. Temporary display-name changes were restored to their prior blank value.
- Follow-up: two additional rounds used normal production matchmaking, without the hidden AI shortcuts. The reveals identified Gemini and Grok. Both rounds finished and were saved, leaving four scored rounds for player A.

## Findings

### Fractional human scores are rounded to integers on reload

**Reproduced on production.** After round 1, the homepage showed `Human score 0.3/1 · 30%`. After reloading, it showed `0/1 · 0%`. History still correctly showed `0.3/1`.

Cause: `loadPersistentScore()` used the whole-counter `toScoreNumber()` normalizer for the fractional `humanEarned` value.

**Fixed locally:** preserve finite nonnegative human points at the game's one-decimal precision; retain the existing integer-counter handling for other fields. The new tests failed before the fix and pass afterward. This change has not been deployed, so production still has this issue.

### The www hostname did not resolve during the initial pass — resolved on recheck

`https://www.geoturing.com` failed with `ERR_NAME_NOT_RESOLVED`; `https://geoturing.com` worked. DNS/hosting configuration was not changed. This is an additional operational finding, not evidence that the frontend redesign caused it.

On the later October 14 recheck, www worked and redirected to the apex hostname. See the hostname regression checks below; the earlier DNS failure is no longer a current finding.

## Live checks

| Check | Result | Evidence |
| --- | --- | --- |
| Rough-location setup | Pass | Both players completed the normal consent and lookup flow. |
| Independent players match | Pass | Both clients entered the same conversation, with complementary turn ownership; each received the other's uniquely marked messages. |
| Turn enforcement and pretyping | Pass | Out-of-turn Send was disabled; a pretyped draft survived until the sender's turn. |
| Bidirectional messaging | Pass | Four alternating messages arrived once in each client. |
| Refresh during conversation | Pass | A reload restored all four messages without duplication and preserved the active turn/timer. |
| Guess confirmation | Pass | Cancel kept chat open; Lock round moved both players to the final-guess flow. |
| Choice navigation | Pass | AI choice -> Back -> Human retained a usable final-guess flow. |
| Map controls | Pass | Submission required a pin; keyboard Enter and a map click both placed valid pins. |
| Human results | Pass | Both players received a correct identity read and a `0.3/1` location score; both comparison maps appeared. |
| Saved History | Pass | Each player saw all four messages, their own perspective, and both comparison pins. |
| Opponent map perspective | Pass | Switching to Their guess showed the opponent's pin against the player's saved actual location. |
| Name saving and pagination | Pass | Enter saved a unique temporary name; it appeared in the correct production leaderboard row. Previous/Next and the final-page boundary worked. The original name was restored. |
| Same-player tab ownership | Pass | A new tab took over A's existing game with all four messages. The old tab returned to the homepage instead of controlling a second game. |
| Incorrect identity guess | Pass | Choosing AI against the human opponent showed the wrong-read result and correct human answer. |
| Missing final guess | Pass | The other player's unanswered guess scored zero at the deadline. |
| New-game gate | Pass | New game remained disabled while the opponent's answer was pending and became enabled after completion. |
| No duplicate records | Pass | After two scored games, A's History contained exactly two rounds, including the ownership-transfer game. |
| Leaderboard aggregates | Pass | A's uniquely identified row showed 2 games and 50% read accuracy after one correct and one incorrect read. The temporary name was restored. |
| Fractional scoreboard reload | Fail on production; fixed locally | `0.3/1` became `0/1` after reload. |

## Production responsive checks

Homepage, expanded History, and Leaderboard were tested at actual viewport widths of 320, 768, and 1440 pixels. Each page's document width matched its available viewport width, with no horizontal overflow. Temporary viewport overrides were reset afterward.

No browser console errors or warnings were recorded for either player or the ownership-transfer tab. The proxy was stopped and temporary player tabs were closed after verification; the direct production History tab was retained for review.

## Repeating the paired-browser test

Prefer two isolated browser profiles pointed directly at geoturing.com. Two ordinary tabs on the same origin share a player ID and test ownership transfer instead of independent players.

When only one browser profile is available:

1. Run `npm run test:production-proxy` from `frontend`.
2. Open geoturing.com for A and the printed loopback URL for B. The proxy chooses a fresh port to avoid existing player storage.
3. Complete location setup on both clients before joining matchmaking.
4. Join both queues together. Exchange uniquely marked messages promptly: turns expire after 25 seconds. Confirm that each client receives the other's text.
5. Exchange at least two messages each, refresh one participant, then complete both final guesses within the shared final-guess timer.
6. Verify results, saved transcripts/maps, scoreboard persistence, and leaderboard aggregates.
7. Repeat with a same-origin duplicate tab and with one final guess deliberately unanswered.
8. Restore any display-name changes, close the proxy player tab, and stop the proxy.

This procedure writes real production game records; it is a deliberate manual check, not an unattended CI test.

## Limits

- This run establishes two-player behavior in the available browser engine, not Chrome/Edge/Safari compatibility.
- Authenticated administrator screens were not exercised; only the public login, its invalid-password response, and return navigation were checked. No administrator credentials were supplied or used.
- Three revealed AI families were exercised after the hostname follow-up: Gemini, Grok, and ChatGPT. Claude, provider failover, and the full 135-second conversation deadline were not verified. Public UI observations cannot establish which provider generated each response or diagnose provider-side errors.
- The score fix requires deployment before it can be verified on the live site.

## Expanded live QA after the initial pass

The first pass was too narrow to establish AI behavior. This follow-up waited for normal matchmaking, real chat replies, and final guesses, and visited each public page. These were manual live browser checks, not new automated E2E tests.

### Gemini round — October 14, approximately 9:01–9:03 PM

- Joined the normal queue alone; matchmaking took roughly half a minute. No forced-model shortcut was used.
- Sent three messages and waited through three typing delays (approximately 20 seconds per reply). Replies followed the discussion of rainy weekends, pizza, and Blade Runner. There were six transcript messages total.
- Used Make a guess → Lock round → AI → Gemini. The reveal identified Gemini, awarding identity `1/1` and model `1/1`.
- The AI's own completed guess was AI / ChatGPT, with the explanation: “The responses are perfectly structured, polite, and lack any idiosyncratic or regional markers that would suggest a real human.” There was no unresolved pending state when the player's result appeared.
- Play again and New game became available. History contained the six messages, model result, and the same opponent guess/explanation after navigation and a direct refresh.
- Leaderboard updated to three games and 67% read accuracy. Returning home preserved AI score `1/1` and reads `2/3`.

### Grok round — October 14, approximately 9:04–9:06 PM

- Repeated normal matchmaking at an actual viewport width of 375px. This opponent opened first with “sup”. Two player messages and three opponent messages arrived; the opponent's final reply was “nah depends on the vibe”.
- Pretyping worked while Send was disabled. Chat content and controls fit the mobile viewport.
- Deliberately left the player's next turn unanswered after the minimum message exchange. The 25-second turn expiry automatically locked chat and opened the final guess screen, with the explicit turn-expiry notice.
- Chose Human, used keyboard Enter on the map to pin its center, and submitted the pin (resolved as Kidal, Mali). The reveal identified Grok and correctly awarded zero for identity and model. The result displayed the misplaced pin with an explanation that AI has no correct location.
- **Failure:** the AI's final guess remained pending, including the visible “8s left before their guess locks” state. After waiting another ten seconds, it resolved to `Read: Not available` and “The AI's guess couldn't be fetched this round.” Play again and New game then became available, so the UI did not remain stuck.
- History saved exactly one new Grok round with all five messages, zero score, and no opponent read/explanation. The board subsequently showed four games and 50% read accuracy. There were no browser console errors or warnings in these gameplay checks.

The missing Grok guess is an observed production reliability failure, not proof that CSS changes caused it. The public UI does not reveal whether the request failed, returned invalid output, or missed the deadline. Source inspection confirms that the server closes unresolved AI guesses at the final-guess deadline and persists a failed guess; server/provider logs are needed to identify this occurrence's cause. Backend behavior was not changed during this follow-up.

### History map presentation issues found

**Update:** Both issues below were fixed locally and verified in the [subsequent History map E2E pass](history-map-fixes-e2e-2026-10-14.md). The descriptions below preserve the observed production behavior before that fix. The fix has not been deployed by this task.

- The Gemini round guessed AI / ChatGPT, but expanded History nevertheless displayed “Their guess on the map”, a “no saved pin” legend, and the player's actual location marker. Grok's missing final guess produced the same map. `HistoryMap` enables this perspective from `opponentActualLocation` alone, even when no location guess was made. This is misleading rather than a failed map load.
- The Grok result displayed the player's wrong Human-location pin, but expanded History omitted that pin. `HistoryMap` only enables the player's perspective when the actual opponent type is Human, discarding the preview for a Human guess against an AI.
- These presentation issues remain open; no speculative backend or frontend behavior change was made as part of this additional QA pass.

### Additional public-page checks

| Page / path | Observed result |
| --- | --- |
| Homepage | Navigation back from History and admin worked; consent and rough location remained saved; updated AI/read scores appeared. |
| History | Both AI entries expanded with complete transcripts; direct refresh reloaded the records. Existing human records remained present. See the map presentation findings above. |
| Leaderboard | Loaded all 42 players across two pages; Next reached the final page with Next disabled; Previous returned to page one. Refreshed route loaded again. Updated four-game, 50% row appeared. |
| Public admin login | Direct route rendered; empty Sign in was disabled. One deliberately invalid password produced “Invalid admin login.” Back to game returned to the homepage. Authenticated monitoring was not tested. |
| Mobile layouts | Actual 375×812 viewport: inspected matchmaking, live chat, identity/location guessing, result, expanded AI History, Leaderboard, and admin login. No horizontal document overflow; table columns and controls remained usable. The result/guess panel scrolled into view. This desktop viewport emulation does not verify a mobile OS keyboard or touch device. |

Temporary viewport overrides were reset after these checks. Both AI rounds were completed; no game was left active. The production History tab was retained for review. No application code was changed during the follow-up; only this report was expanded.

## www hostname regression check — approximately 9:34–9:36 PM

- `https://www.geoturing.com/` redirected to `https://geoturing.com/`. The existing location consent, Quebec location, reads `2/4`, and AI score `1/2` appeared without setting up a new player.
- Direct www `/history` and `/leaderboard` visits preserved the path and redirected to the corresponding apex pages. History showed the same four previous rounds, including the full Gemini transcript. Leaderboard loaded successfully with the existing player-name hint.
- Frontend identity, scores, consent, and location are stored in localStorage. Different hosts would normally have separate stores if both served the app directly. The observed redirect makes both entry URLs run on the same apex origin, so they currently use the same browser store and player identity. API/socket configuration points to `https://api.geoturing.com`; no separate www database is configured in the frontend. Physical database topology was not inspected.
- Joined normal matchmaking and exchanged a message. During the active conversation, deliberately navigated to the www root. It redirected back, reconnected, and restored both messages, turn ownership, and the remaining timer. Received another opponent reply and sent another message successfully; no duplicate messages appeared.
- Completed the round: reveal identified ChatGPT; identity/model scores were both `1/1`. The AI returned Human plus a London location guess and explanation. Result finalized normally.
- Opening www History afterward showed exactly five rounds, retaining all previous four and one new ChatGPT record. Expanded details contained all five messages, explanation, London guess versus Quebec actual location, and a 4,989 km comparison. No browser console errors or warnings were recorded.
- Observed deployed assets on this check: `index-4aU6fszg.js` and `index-DN-yf6z0.css`. The JavaScript asset differs from the initial run; the earlier fractional-score defect's local fix must be checked against the current deployed bundle before declaring it either deployed or still failing. Existing zeroed browser totals alone cannot establish that.
- No regression attributable to the www addition was found in these checks. This is scoped browser evidence, not exhaustive browser/device compatibility certification. No app/deployment changes were made. The earlier Grok final-guess failure and two History map presentation issues remain open and were observed before this hostname check.
- Command-line header retrieval could not connect from the shell environment; the browser navigations above verified the actual working redirect. The HTTP redirect status code was not established.

The current test suite does not contain an automated browser E2E runner: the frontend tests cover storage, and `test:production-proxy` is a manual-test helper. Add repeatable browser assertions for canonical-host/path redirects, active-session restoration, exactly-once History persistence, successful/failed AI final guesses, and both map perspectives. These are coverage gaps rather than passing automated E2E tests.

## Local verification commands

- `cd frontend; npm test` — four storage regression tests, including actual save/load round trips and fractional accumulation.
- `cd frontend; npm run build` — production bundle check.
- `cd backend; npm test` — existing backend regression suite.

Final result: all four frontend tests and all 53 backend tests passed; the production frontend build succeeded. `git diff --check` passed. These local results verify the score fix but do not deploy it.
