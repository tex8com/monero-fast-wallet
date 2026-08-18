# Notification Registration Adapter

This open-source AGPL service is the mobile app-integrity boundary in front of
the Notification Gateway.

- Android uses Firebase App Check backed by Play Integrity.
- iOS uses Firebase App Check backed by App Attest with DeviceCheck fallback.
- App Check JWTs are accepted only with `RS256`, `typ=JWT`, the configured
  Firebase issuer/audience, an allowed Firebase App ID, and valid time claims.
- JWKS is fetched only over HTTPS, never redirected, bounded to 256 KiB and
  cached for at most six hours.
- The adapter receives only SHA-256 bindings. The raw FCM/APNs token and the
  installation authorization secret go directly from native client code to the
  Gateway.
- Grants expire after two minutes, contain a CSPRNG nonce, and are one-time at
  the Gateway.
- Per-attestation and global rate limits are fail-closed.

The Gateway must be configured with the public half of
`NOTIFICATION_REGISTRATION_SIGNING_KEY_FILE`. Debug App Check providers are for
simulator/test builds only and must not be accepted by the production Firebase
App Check project.

Required production environment:

```text
NOTIFICATION_REGISTRATION_ADAPTER_BIND
NOTIFICATION_REGISTRATION_FIREBASE_PROJECT_NUMBER
NOTIFICATION_REGISTRATION_FIREBASE_APP_IDS
NOTIFICATION_REGISTRATION_SIGNING_KEY_FILE
```

The optional `NOTIFICATION_REGISTRATION_FIREBASE_JWKS_URL` exists only for an
isolated local test fixture; production uses Firebase's fixed official JWKS
endpoint.
