# U2 automatic check-in

The established runner opens the question page, loads its image, resolves public
cover references, chooses only a reliable answer and submits once. Completion
still requires the bound account's daily header; a public shoutbox message is
not account evidence. Already-completed days use passive verification only.

Public references use isolated request contexts without the site's cookies,
tokens or Profile. A private `u2ReferenceProxyServer` may pin an existing,
credential-free loopback HTTP proxy. This applies only to approved AniList,
MyAnimeList and image CDN requests; it does not change system networking or site
login routing. Set it in ignored local configuration when unattended processes
cannot rely on inherited proxy variables. Validate the route without proxy
environment variables before relying on it in the scheduler.

U2 failures retain fixed diagnostic codes through the PT result projection:

- `u2_reference_unavailable` or `u2_reference_timeout`: public covers unavailable.
- `u2_visual_ambiguous`: no sufficiently reliable visual match.
- `u2_image_unavailable`: missing or unloaded challenge image.
- `u2_challenge_changed`: the expected form or answer is absent.
- `u2_question_expired`: the remaining validity window is insufficient.
- `u2_solver_failed`: an unexpected solver failure before submission.

These outcomes explicitly record `submissionAttempted:false`. They do not
authorize replay of an earlier uncertain write. Errors after answer submission
retain `submission_outcome_unknown` until an authoritative account/day readback.
The public reference transport closes after every solver run, including errors.
