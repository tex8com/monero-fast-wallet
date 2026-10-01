# Roadmap

This roadmap tracks release-relevant work that is not yet complete. It does
not describe finished functionality.

## `.mfw` registration and Ledger transaction flow

### Verified current state (2026-09-28)

- [x] A first-stage name commitment was broadcast, mined and indexed on
  Mainnet.
- [ ] The second-stage claim-and-pay transaction has not been observed in the
  canonical index. Until it is mined and independently resolved, the name is
  not registered.
- [x] A local pending registration now overrides a public `Available` result;
  the app opens the existing two-step flow instead of starting a duplicate.

No wallet address, name, transaction ID or private test evidence is included
in this public roadmap.

### Required fixes

Implementation update (2026-10-01): the new server delivery service is deployed
and its actual onion ingress is verified. Mobile integration passes automated
tests but is not a physical-device or public-release signoff.
See [the delayed claim relay contract](../backend/mfw-claim-relay/README.md).

- [x] Guide the two-transaction journey persistently. After the first approval,
  explain the maturity wait and keep the second approval as the next required
  action; never present the commitment as a completed registration.
- [x] Implement consecutive approvals for the official-node mobile flow when
  independent unlocked inputs exist. Persist locally before handing the signed
  claim to an encrypted, idempotent server queue; distinguish upload uncertainty,
  durable server receipt, transmission, observation and registry finality.
- [x] Keep manual approval/reminder/banner for custom nodes, unavailable relay
  or failed second preparation. Never discard the successfully sent commitment.
- [ ] Preflight the actual independent input availability before the first
  approval, not merely the account balance. Current second preparation can
  still fall back to the manual flow after the commitment has been sent.
- [x] After the commitment reaches protocol maturity, send a privacy-preserving
  local device notification such as `Your second .mfw approval is ready` and
  deep-link directly to the matching claim flow. The notification must not
  expose the name, address, amount or transaction ID.
- [x] Show a permanent two-step progress component throughout registration:
  `1. Commitment` and `2. Claim and payment`, including the current state,
  required maturity height and remaining blocks. Step 1 must never use a
  finished or successfully registered presentation.
- [x] Once Step 2 is ready, insert a prominent full-width banner below the app
  header on Home and the `.mfw` screen. It must move page content down rather
  than cover it, remain visible until resolved and provide one primary action:
  `Complete second approval`.
- [x] If exact background chain verification is unavailable, schedule a local
  fallback reminder and verify maturity when the notification is opened. On
  every later app start, show the claim prompt immediately until it is
  completed or the reveal window expires. Notification permission denial must
  fall back to a persistent in-app banner and badge.
- [x] Show the remaining reveal-window blocks and the authoritative maturity
  and claim-deadline heights. Issue a generic local reminder before the user
  can miss the required second step.
  before expiry. Never describe the registration as complete after only the
  commitment.
- [x] Document the new approved trust model: upload only the signed claim to
  the selected official service, never owner secrets. The relay learns the
  reveal early and is trusted not to release it early. Retain old device-only
  Android jobs without migration or duplicate broadcast scheduling.
- [x] Implement opaque job-status pushes through the existing gateway; payloads
  contain no name, wallet address, amount or transaction ID.
- [x] Deploy the relay and gateway; verify actual onion capabilities, denied
  unauthenticated job access, private notification ingress and service health.
  The service runs under its own unprivileged account; keys stay outside Git.
- [ ] Verify notification registration/permission and delivery on the Pixel
  with the app terminated; a local timed reminder is not proof of maturity.
- [ ] Implement the equivalent desktop native export and server handoff.
- [ ] Device-test the shared mobile integration on Android and iOS.
  Android release 1.0.94 (95), built from `5313dc40`, was installed as a
  data-preserving update on the Pixel 8 Pro on 2026-10-01. APK v2 signature and
  16-KB alignment passed; the installed APK hash matches the build artifact:
  `ee64fd18417bfff9f364008f415282180215aceb6939738d8152dc9511ffe32e`.
  Physical Ledger/claim/push acceptance still requires the user's test.
  Latest automated checks: 92 mobile suites / 601 tests, TypeScript and scoped
  ESLint; 14 relay and 22 notification-gateway tests on the Linux server.
- [x] Reconcile a pending commitment against its transaction ID in the complete
  wallet container history, including Ledger transactions outside the currently
  displayed account.
- [x] Advance a matured commitment from `Commit pending` to `Ready to claim`
  and present the second approval as the primary action.
- [x] Never show `Available` for a name that has a matching local pending
  commitment. Explain that the commitment reserves no public name until the
  claim is mined.
- [x] Recover safely after app restart, Ledger disconnect, timeout or a stale
  wallet session without losing the registration stage or a safely held claim.
- [ ] Mark a registration `Active` only after the claim transaction is mined,
  has the required confirmations and independent resolvers agree.

### Performance and progress reporting

- [ ] Add native phase timings for transaction construction, node requests,
  Ledger APDU processing and user approval.
- [ ] Report live progress from the native signing flow instead of polling
  through the serialized wallet queue.
- [ ] Cache or reuse output-distribution data where protocol safety permits,
  and benchmark Bluetooth against USB.
- [ ] Keep Cancel available throughout long Ledger operations and ensure a
  late completion cannot overwrite the final state.

### Release acceptance

- [ ] Complete a full commit -> maturity -> claim -> confirmation flow on a
  physical Android device with both Ledger Bluetooth and USB.
- [ ] Verify the final record through both configured resolvers and through
  direct canonical-node evidence.
- [ ] Confirm that restart and reconnection during every stage resume to the
  correct action without duplicate payment.
- [ ] Repeat the same state and UI checks in the desktop application.
