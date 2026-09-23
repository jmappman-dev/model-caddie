# Contributing

Thanks for helping. This project stays small on purpose: zero dependencies, no network calls, no model calls.

## Ground rules

1. **Test first.** Every behavior change starts with a failing test in `test/`. Run `npm test` and confirm it fails, then change the code until it passes.
2. **Misroutes are bugs, and the fix is a test case.** If the router sends a task to the wrong lane, open an issue with the exact task text, the output of `node bin/model-caddie.js --json "<task>"`, and what you expected.
3. **Keep matchers bounded.** No open-ended word windows in the regexes. Earlier rules must stay narrow enough that later rules remain reachable. Past false positives are pinned in `test/routing.test.js`; do not loosen a matcher without checking them.
4. **No secrets anywhere.** Configs name env vars, never hold their values. Never paste a real key into a test, issue, or config example.
5. **No em dashes in docs.** House style.

## Adding a provider profile

Copy a file in `profiles/`, change the models and `provider` labels, and add its name to `listProfiles()` in `src/config.js`. Check every model ID against the provider's own model docs and note the date you checked in `_about`. `npm test` validates every bundled profile.
