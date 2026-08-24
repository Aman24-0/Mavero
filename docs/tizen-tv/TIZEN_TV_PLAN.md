# Mavero — Samsung Tizen TV / TizenBrew Development Plan

**Document status:** Living project plan  
**Created:** 2026-08-23  
**Repository:** `Aman24-0/Mavero`  
**Goal:** Bring Mavero to Samsung Smart TV/Tizen through a TizenBrew application module while keeping the existing Web/PWA product stable.

## 1. Architecture decisions

### One repository
Keep `Aman24-0/Mavero` as the single source repository. Do not create a permanent `Mavero-Tizen` repository.

### One main branch
Keep `main` as the long-term source of truth. A temporary branch such as `feature/tizen-tv` is fine during development. Do not maintain permanent `web-main` and `tizen-main` branches.

### Shared core + TV-specific layer

```text
                    MAVERO
                      |
          +-----------+-----------+
          |                       |
       Shared core             Platform layer
          |                       |
   +------+-------+          +----+------+
   |              |          |           |
 Data/API      Business     Web/PWA     Tizen TV
 Logic         Logic        UI/Input    UI/Remote
 Player        Models       Touch       Focus
 Auth          Utilities                Tizen
```

Reuse where practical:
- TMDB/AniList data
- Supabase/auth
- content models
- discovery/search
- recommendations
- My List
- watch progress
- provider/source resolution
- player contracts/state
- shared utilities
- design tokens
- platform-independent tests

Keep Tizen-specific:
- remote key handling
- focus management
- TV navigation
- 10-foot layout
- TV search/input
- TV player controls
- TizenBrew packaging/service
- TV-specific performance tuning

## 2. TizenBrew strategy

First target a **TizenBrew application module**, not a completely independent WGT application.

Architecture:

```text
Samsung TV
   |
Tizen OS
   |
TizenBrew
   |
Mavero TizenBrew app module
   |
Mavero TV web application
   |
Shared Mavero backend/core
```

Official references:
- TizenBrew: https://github.com/reisxd/TizenBrew
- TizenBrew modules: https://github.com/reisxd/TizenBrew/blob/main/docs%2FMODULES.md
- TizenTube reference: https://github.com/reisxd/TizenTube

Use TizenTube to study packaging, remote/media keys, service integration, and Samsung TV configuration. Do not blindly copy code or permissions.

## 3. TV UX principles

The TV version must be a real **10-foot, remote-first interface**, not the mobile UI stretched onto a television.

Primary remote model:

```text
          UP
           |
LEFT ---- OK ---- RIGHT
           |
         DOWN

BACK = previous logical state
```

Rules:
- one meaningful focused element at a time
- focus is always clearly visible
- arrows move predictably
- horizontal rails use left/right
- vertical sections use up/down
- OK activates
- Back returns to the previous logical state
- async loading must not randomly destroy focus
- focus restoration should work after details/player
- mouse/touch assumptions must not be required

## 4. Suggested TV abstraction

Introduce a TV/platform layer rather than scattering Samsung checks through the UI.

Possible structure:

```text
src/lib/tv/
  platform.ts
  remote.ts
  focus.ts
  navigation.ts
```

Exact names are up to the audit.

Conceptual abstraction:

```text
TVRemote
  up
  down
  left
  right
  enter
  back
  playPause
  rewind
  fastForward
  next
  previous
```

Samsung/Tizen code should adapt into this abstraction wherever practical.

## 5. Phase roadmap

### Phase 0 — Feasibility + architecture audit

**Goal:** Understand exactly what must change before writing TV code.

Audit:
1. Current SvelteKit architecture.
2. AppShell/navigation.
3. Discover.
4. Search.
5. Detail pages.
6. My List.
7. Player and landscape behavior.
8. Auth/session behavior on TV.
9. Supabase/browser API dependencies.
10. PWA/service-worker behavior on Tizen.
11. Browser APIs that may differ on Samsung Tizen.
12. Image/video compatibility.
13. GPU/animation-heavy effects.
14. Responsive breakpoints.
15. Existing reusable tests.
16. New TV-only tests needed.
17. TizenBrew application-module requirements.
18. Required Tizen permissions/keys only.
19. Whether Netlify-hosted Mavero can be reused directly or needs a TV-specific build/route.

**Phase 0 rule:** no major TV UI rewrite or speculative implementation.

Completion:
- architecture audit
- TizenBrew constraints
- TizenTube relevant patterns
- compatibility risks
- player risks
- recommended folder/build architecture
- deployment strategy
- Phase 1 scope
- no Web/PWA regressions

### Phase 1 — TizenBrew skeleton

Create the minimum TizenBrew application module.

Target concept:

```text
tizen/
  package.json
  app/
  service/   # only if required
```

Goal:

```text
TizenBrew -> Mavero -> application opens on TV
```

Completion:
- module installs/loads
- app opens
- safe Back/exit
- basic remote keys
- only required permissions
- Web/PWA unaffected

### Phase 2 — TV shell + remote navigation

Build:
- TV header/navigation
- 10-foot spacing
- large typography
- focus ring
- remote navigation
- OK/Enter
- Back
- focus restoration
- loading/error focus behavior

Completion: primary shell is usable entirely from a Samsung remote.

### Phase 3 — Discover TV experience

Build:
- cinematic hero
- movie/series/anime rails
- focused cards
- horizontal remote scrolling
- details/actions
- TV-appropriate lazy loading
- reduced expensive effects

Do not simply enlarge the mobile layout.

### Phase 4 — Search TV experience

Build:
- TV-friendly search input/keyboard approach
- query submission
- result focus
- filters
- Movies / Shows / Anime
- predictable Back behavior

Avoid making users operate a desktop text field through a TV remote.

### Phase 5 — TV Search Polish + Native IME Investigation — COMPLETE

Preserve all Phase 1–4 behavior while improving the isolated `/tv` Search experience:

- fix deterministic vertical focus movement across Search sections without replacing the reusable coordinator
- keep horizontal rail navigation and startup/Back focus restoration unchanged
- improve TV-only typography for category, keyboard, and utility controls without changing Web/PWA fonts
- investigate Samsung native system IME using an opt-in real HTML input inside the TizenBrew-hosted module
- verify input/change synchronization, Enter/OK, Back, focus restoration, and SmartThings typing where available
- retain the custom TV keyboard as the default fallback unless native IME is verified on the target hardware
- record native IME compatibility or limitation truthfully; do not add undocumented APIs, privileges, bridges, or host changes

**Final Samsung QA:** Native IME **FAIL** inside the TizenBrew-hosted module; no undocumented workaround was added. The custom UI keyboard is the final default. Vertical focus **PASS**. General Search flow/navigation **PASS**. Typography/clarity **NEEDS FIX** because the current white text is not sufficiently clear from a normal 10-foot viewing distance.

### Phase 6 — Detail + My List — STARTED

Adapt:
- movie detail
- series detail
- anime detail
- recommendations
- Watch Now
- My List add/remove
- series seasons/episodes
- remotely reachable actions
- **TV-only typography/clarity fix: larger fonts, heavier font weight, stronger contrast, and readable focus treatment for the 10-foot interface**

### Phase 7 — TV player

High-risk phase. Test:
- Play/Pause
- seek
- rewind/fast-forward
- Back
- resume
- fullscreen
- loading/error
- source/provider selection
- episode navigation
- autoplay
- progress persistence
- network recovery

Do not assume desktop Chromium player behavior equals Samsung Tizen behavior.

### Phase 7 — TV performance

Measure and improve:
- initial JS
- DOM size
- image sizes/count
- animation cost
- blur/backdrop-filter
- shadows/gradients
- rerenders
- memory growth
- long-session stability
- player overhead

Prefer measured optimization, lazy images, appropriate assets, minimal animation, and efficient focus updates.

### Phase 8 — Real Samsung TV QA

Actual hardware testing is mandatory.

Test:
- cold launch/reload
- Discover/Search/Movies/Series/Anime
- Details/My List/Profile where exposed
- Back and focus restoration
- poster/backdrop loading
- broken images
- empty/error/slow-network states
- movie/series/anime playback
- multiple episodes
- resume/seek/back/source fallback
- 30+ minute session
- repeated navigation/search/playback
- memory/CPU behavior where observable

If hardware is unavailable, explicitly record:
`Samsung TV QA: NOT RUN — hardware unavailable`

## 6. Web/PWA regression rule

Every Tizen phase must verify that these still work:
- Android PWA
- desktop browser
- mobile browser
- Netlify production
- authentication
- My List
- watch progress
- existing player

Tizen changes must not silently become Web/PWA regressions.

## 7. Deployment/update management

### Web/PWA

```text
GitHub main -> Netlify -> Mavero Web/PWA
```

### Tizen

```text
GitHub -> Tizen build/module -> TizenBrew -> Samsung TV
```

They are separate deployment outputs but share the same repository/core.

A shared codebase does not require a Tizen package update for every harmless Web-only change. For breaking shared-core changes, update the TV module/build in a controlled way.

## 8. Git strategy

Recommended development flow:

```text
main
 |
 +-- feature/tizen-tv
```

For each phase:
1. start from current stable `main`
2. work on temporary Tizen branch
3. implement one phase
4. validate
5. update worklog
6. commit
7. push
8. review
9. merge into `main`

No permanent web/tizen branches.

## 9. Mandatory TV worklog

Maintain:

```text
TIZEN_TV_WORKLOG.md
```

throughout the project.

Every meaningful phase entry must contain:
- date
- phase
- objective
- files/components changed
- architecture decisions
- implementation completed
- tests executed/results
- browser QA
- Samsung TV QA
- known limitations
- unresolved issues
- next step
- branch
- commit SHA
- merge/deployment status

### Mandatory commit rule

Whenever Manus commits/pushes Tizen work, it must update the worklog **in the same change/commit**.

Never push Tizen implementation while leaving the worklog stale.

Before starting any new phase, Manus must read:
1. `TIZEN_TV_PLAN.md`
2. `TIZEN_TV_WORKLOG.md`
3. relevant Mavero documentation
4. previous phase report

It must continue from the recorded state rather than assuming the phase is untouched.

## 10. Manus reporting standard

At the end of every phase:

```text
Phase:
Status:
Branch:
Commit:
Files changed:
What changed:
Tests:
Build:
Browser QA:
Samsung TV QA:
Known limitations:
Next phase:
```

## 11. Release baseline

Before Tizen implementation, create a stable GitHub baseline release from the known-good current Web/PWA state.

Recommended:

```text
Tag: v0.1.0
Title: Mavero v0.1.0 — Web/PWA Baseline
```

This is a development baseline/rollback point, not a claim that the product is production-final.

## 12. README

The repository should have a root `README.md` covering:
- what Mavero is
- current platforms
- major features
- tech stack
- local development
- environment setup
- validation commands
- deployment
- documentation
- Tizen TV roadmap
- architecture philosophy

Keep detailed history in reports/worklogs, not the README.

## 13. Definition of success

Tizen work is complete when:
1. Mavero launches through TizenBrew on supported Samsung TV.
2. UI works at a 10-foot viewing distance.
3. Core navigation works entirely by remote.
4. Discover works.
5. Search works.
6. Details work.
7. My List works.
8. Playback is reliable.
9. Resume/progress works.
10. Back/navigation is predictable.
11. TV performance is acceptable.
12. Web/PWA has no regressions.
13. TizenBrew packaging/update process is documented.
14. Worklog is current.
15. Architecture remains maintainable from the same repository.

## 14. Constraints

- Do not duplicate the entire Mavero application for Tizen.
- Do not create a permanent separate Tizen repository.
- Do not create permanent web/tizen branches.
- Do not copy TizenTube code without checking license/applicability.
- Do not add unnecessary Tizen permissions.
- Do not assume desktop browser behavior equals Tizen behavior.
- Do not claim TV support without real-device testing.
- Do not sacrifice Web/PWA stability for TV-only changes.
- Do not let the worklog become stale.
- Do not make major Phase 0 architecture changes before the audit identifies a reason.

## 15. Current position

```text
Web/PWA       READY / actively maintained
Android PWA   READY
Desktop       READY
Player        EXISTING + tested architecture
Backend       EXISTING
Auth          EXISTING
Admin         EXISTING
Tizen         Phase 5 complete; Phase 6 started
Phase 0       COMPLETE
Phase 1       COMPLETE
Phase 2       COMPLETE
Phase 3       COMPLETE
Phase 4       COMPLETE
Phase 5       COMPLETE — Samsung QA: IME FAIL, vertical focus PASS, typography NEEDS FIX, Search flow/navigation PASS
Phase 6       STARTED — Detail + My List plus TV typography/clarity fix
```

**Immediate next task: Continue Phase 6 — isolated TV Detail + My List implementation with the typography/clarity fix.**

Keep all work under the TV layer and do not modify player/AVPlay, auth/Supabase, PWA, normal Web/PWA routes, providers/resolver, production configuration, or `main`.
