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

- [x] Guide the two-transaction journey persistently. After the first approval,
  explain the maturity wait and keep the second approval as the next required
  action; never present the commitment as a completed registration.
- [x] On Android, where the wallet can safely construct the claim from
  independent unlocked inputs, collect both explicit approvals consecutively,
  keep the signed claim
  encrypted with Android Keystore on the device and broadcast it only after
  15 commitment confirmations. Re-arm the local relay after reboot, force-stop
  and the next app start.
- [x] If safe pre-signing is not possible, for example because the claim needs
  change from the commitment, show this before the first approval and retain a
  prominent `Step 1 of 2 complete - second approval required` state.
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
- [x] Never upload the Android held signed claim or owner secret to a server.
  Delayed broadcast is device-controlled and retries through the selected
  official, HTTPS or Tor v3 node route.
- [ ] Add equivalent encrypted delayed-broadcast handling for iOS and desktop.
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
