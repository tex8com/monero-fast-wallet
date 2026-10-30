//! APNs credentials stay inside the delivery boundary. No tokens or key bytes
//! implement Debug or enter diagnostics.

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const REFRESH_SECONDS: u64 = 30 * 60;
const MAX_KEY_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug)]
pub enum ApnsCredentials {
    /// Compatibility mode: an external service must rotate this JWT file.
    ProviderJwtFile(PathBuf),
    /// The Gateway signs and renews its own provider JWT with an existing key.
    SigningKeyFile {
        team_id: String,
        key_id: String,
        path: PathBuf,
    },
}

struct CachedJwt {
    issued_at: u64,
    token: Zeroizing<String>,
}

#[derive(Default)]
pub(super) struct ApnsBearerCache {
    cached: Mutex<Option<CachedJwt>>,
}

impl ApnsBearerCache {
    pub(super) fn bearer(
        &self,
        credentials: &ApnsCredentials,
    ) -> Result<Zeroizing<String>, String> {
        self.bearer_with_clock(credentials, || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .map_err(|_| "APNs system clock is invalid".to_owned())
        })
    }

    fn bearer_with_clock(
        &self,
        credentials: &ApnsCredentials,
        clock: impl FnOnce() -> Result<u64, String>,
    ) -> Result<Zeroizing<String>, String> {
        let (team_id, key_id, path) = match credentials {
            ApnsCredentials::ProviderJwtFile(path) => return super::load_rotating_bearer(path),
            ApnsCredentials::SigningKeyFile {
                team_id,
                key_id,
                path,
            } => (team_id, key_id, path),
        };
        validate_id(team_id)?;
        validate_id(key_id)?;
        // Read the clock under the lock: a request waiting behind a renewal
        // must observe its token before deciding whether another is needed.
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| "APNs credential cache is unavailable".to_owned())?;
        let now = clock()?;
        if now == 0 {
            return Err("APNs system clock is invalid".to_owned());
        }
        if let Some(previous) = cached.as_ref() {
            // Correct a future cached timestamp after a wall-clock correction.
            // Delivery uses a fresh HTTP client/connection, so this replacement
            // is not a rapid token change on an existing APNs connection.
            if now >= previous.issued_at && now - previous.issued_at < REFRESH_SECONDS {
                return Ok(Zeroizing::new(previous.token.to_string()));
            }
        }
        let key = load_signing_key(path)?;
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(key_id.clone());
        let token = Zeroizing::new(
            encode(
                &header,
                &ApnsClaims {
                    iss: team_id,
                    iat: now,
                },
                &key,
            )
            .map_err(|_| "APNs provider token could not be created".to_owned())?,
        );
        *cached = Some(CachedJwt {
            issued_at: now,
            token: Zeroizing::new(token.to_string()),
        });
        Ok(token)
    }
}

#[derive(Serialize)]
struct ApnsClaims<'a> {
    iss: &'a str,
    iat: u64,
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.len() != 10
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(
            "APNs team ID and key ID must each contain ten uppercase letters or digits".to_owned(),
        );
    }
    Ok(())
}

fn load_signing_key(path: &Path) -> Result<EncodingKey, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let mut file = options
        .open(path)
        .map_err(|_| "APNs signing key could not be opened securely".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "APNs signing key metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_KEY_BYTES {
        return Err("APNs signing key file is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("APNs signing key permissions are unsafe".to_owned());
    }
    let mut contents = Zeroizing::new(Vec::new());
    file.by_ref()
        .take(MAX_KEY_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|_| "APNs signing key could not be read".to_owned())?;
    if contents.len() > MAX_KEY_BYTES as usize {
        return Err("APNs signing key file is invalid".to_owned());
    }
    EncodingKey::from_ec_pem(&contents).map_err(|_| "APNs signing key is invalid".to_owned())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Barrier,
        },
        thread,
    };
    use tempfile::{tempdir, TempDir};

    const NOW: u64 = 1_800_000_000;
    const TEAM: &str = "TESTTEAM01";
    const KEY: &str = "TESTKEY001";
    // Deliberately public test vector: private scalar 1 and the standard P-256
    // generator. It is not a real APNs credential and must never be used as one.
    const PUBLIC_POINT: &str = concat!(
        "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
        "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
    );

    fn test_key_pem() -> Vec<u8> {
        let der = hex::decode(format!(
            "308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420{}01a144034200{}",
            "00".repeat(31), PUBLIC_POINT
        )).unwrap();
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut base64 = String::new();
        for part in der.chunks(3) {
            let a = part[0];
            let b = part.get(1).copied().unwrap_or(0);
            let c = part.get(2).copied().unwrap_or(0);
            base64.push(ALPHABET[(a >> 2) as usize] as char);
            base64.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
            base64.push(if part.len() > 1 {
                ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
            } else {
                '='
            });
            base64.push(if part.len() > 2 {
                ALPHABET[(c & 63) as usize] as char
            } else {
                '='
            });
        }
        format!("-----BEGIN PRIVATE KEY-----\n{base64}\n-----END PRIVATE KEY-----\n").into_bytes()
    }

    fn fixture() -> (TempDir, ApnsCredentials) {
        let temporary = tempdir().unwrap();
        let path = temporary.path().join("synthetic-test-key.p8");
        fs::write(&path, test_key_pem()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        (
            temporary,
            ApnsCredentials::SigningKeyFile {
                team_id: TEAM.to_owned(),
                key_id: KEY.to_owned(),
                path,
            },
        )
    }

    fn claims(token: &str) -> serde_json::Value {
        let header = decode_header(token).unwrap();
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some(KEY));
        let mut validation = Validation::new(Algorithm::ES256);
        validation.validate_exp = false;
        validation.required_spec_claims.clear();
        validation.set_issuer(&[TEAM]);
        decode::<serde_json::Value>(
            token,
            &DecodingKey::from_ec_der(&hex::decode(PUBLIC_POINT).unwrap()),
            &validation,
        )
        .unwrap()
        .claims
    }

    #[test]
    fn jwt_reuses_signature_then_renews_at_thirty_minutes_and_after_long_pause() {
        let (_temporary, credentials) = fixture();
        let cache = ApnsBearerCache::default();
        let first = cache.bearer_with_clock(&credentials, || Ok(NOW)).unwrap();
        assert_eq!(claims(&first), serde_json::json!({"iss": TEAM, "iat": NOW}));
        let reused = cache
            .bearer_with_clock(&credentials, || Ok(NOW + REFRESH_SECONDS - 1))
            .unwrap();
        assert!(first.as_str() == reused.as_str());
        let renewed = cache
            .bearer_with_clock(&credentials, || Ok(NOW + REFRESH_SECONDS))
            .unwrap();
        assert_eq!(claims(&renewed)["iat"], NOW + REFRESH_SECONDS);
        assert!(first.as_str() != renewed.as_str());
        let after_pause = cache
            .bearer_with_clock(&credentials, || Ok(NOW + 7 * 86400))
            .unwrap();
        assert_eq!(claims(&after_pause)["iat"], NOW + 7 * 86400);
    }

    #[test]
    fn concurrent_startup_and_renewal_share_one_token_with_clock_read_under_lock() {
        let (_temporary, credentials) = fixture();
        let credentials = Arc::new(credentials);
        let cache = Arc::new(ApnsBearerCache::default());
        for start in [NOW, NOW + REFRESH_SECONDS] {
            let clock = Arc::new(AtomicU64::new(start));
            let barrier = Arc::new(Barrier::new(24));
            let workers: Vec<_> = (0..24)
                .map(|_| {
                    let (cache, credentials, clock, barrier) = (
                        cache.clone(),
                        credentials.clone(),
                        clock.clone(),
                        barrier.clone(),
                    );
                    thread::spawn(move || {
                        barrier.wait();
                        cache
                            .bearer_with_clock(&credentials, || {
                                Ok(clock.fetch_add(1, Ordering::SeqCst))
                            })
                            .unwrap()
                    })
                })
                .collect();
            let tokens: Vec<_> = workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect();
            assert_eq!(clock.load(Ordering::SeqCst), start + 24);
            assert_eq!(claims(&tokens[0])["iat"], start);
            assert!(tokens
                .iter()
                .all(|token| token.as_str() == tokens[0].as_str()));
        }
    }

    #[test]
    fn corrected_backwards_time_replaces_future_token_then_reuses_it() {
        let (_temporary, credentials) = fixture();
        let cache = ApnsBearerCache::default();
        assert!(cache.bearer_with_clock(&credentials, || Ok(0)).is_err());
        let first = cache
            .bearer_with_clock(&credentials, || Ok(NOW + 86400))
            .unwrap();
        let corrected = cache.bearer_with_clock(&credentials, || Ok(NOW)).unwrap();
        assert_eq!(claims(&corrected)["iat"], NOW);
        assert!(first.as_str() != corrected.as_str());
        assert!(cache
            .bearer_with_clock(&credentials, || Err("clock unavailable".to_owned()))
            .is_err());
        let later = cache
            .bearer_with_clock(&credentials, || Ok(NOW + 1))
            .unwrap();
        assert!(corrected.as_str() == later.as_str());
    }

    #[test]
    fn failed_refresh_never_falls_back_to_an_expired_cached_token() {
        let (_temporary, credentials) = fixture();
        let cache = ApnsBearerCache::default();
        cache.bearer_with_clock(&credentials, || Ok(NOW)).unwrap();
        let ApnsCredentials::SigningKeyFile { path, .. } = &credentials else {
            unreachable!()
        };
        fs::remove_file(path).unwrap();
        assert!(cache
            .bearer_with_clock(&credentials, || Ok(NOW + 3601))
            .is_err());
        fs::write(path, test_key_pem()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        let recovered = cache
            .bearer_with_clock(&credentials, || Ok(NOW + 3602))
            .unwrap();
        assert_eq!(claims(&recovered)["iat"], NOW + 3602);
    }

    #[test]
    fn signing_key_rejects_missing_symlink_nonregular_oversized_and_malformed_files() {
        let (temporary, credentials) = fixture();
        let ApnsCredentials::SigningKeyFile { path, .. } = credentials else {
            unreachable!()
        };
        assert!(load_signing_key(&temporary.path().join("missing")).is_err());
        assert!(load_signing_key(temporary.path()).is_err());
        let link = temporary.path().join("key-link");
        symlink(&path, &link).unwrap();
        assert!(load_signing_key(&link).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_signing_key(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&path, vec![0_u8; MAX_KEY_BYTES as usize + 1]).unwrap();
        assert!(load_signing_key(&path).is_err());
        fs::write(&path, b"synthetic-invalid-key-do-not-log").unwrap();
        let error = load_signing_key(&path).err().unwrap();
        assert!(!error.contains("synthetic-invalid-key-do-not-log"));
        assert!(!error.contains(path.to_str().unwrap()));
        let fifo = temporary.path().join("fifo");
        let fifo_c = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(load_signing_key(&fifo).is_err());
    }

    #[test]
    fn signing_ids_reject_invalid_values_without_echoing_them() {
        for value in [
            "",
            "bad-id-secret",
            "abcdef1234",
            "ABCDEFGHIJK",
            "A B C D E ",
        ] {
            let error = validate_id(value).unwrap_err();
            if !value.is_empty() {
                assert!(!error.contains(value));
            }
        }
        assert!(validate_id(TEAM).is_ok());
        assert!(validate_id(KEY).is_ok());
    }

    #[test]
    fn legacy_jwt_file_is_reread_after_atomic_rotation_and_checks_permissions() {
        let temporary = tempdir().unwrap();
        let path = temporary.path().join("jwt");
        let write = |path: &Path, token: &str| {
            fs::write(path, token).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        };
        write(&path, "synthetic.jwt.first-token");
        let credentials = ApnsCredentials::ProviderJwtFile(path.clone());
        let cache = ApnsBearerCache::default();
        assert!(cache.bearer(&credentials).unwrap().as_str() == "synthetic.jwt.first-token");
        let replacement = temporary.path().join("replacement");
        write(&replacement, "synthetic.jwt.second-token");
        fs::rename(replacement, &path).unwrap();
        assert!(cache.bearer(&credentials).unwrap().as_str() == "synthetic.jwt.second-token");
        fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(cache.bearer(&credentials).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn signing_credentials_traverse_startup_validation_and_real_delivery_adapter() {
        use super::super::{
            ApnsDeliveryConfig, DirectProviderDelivery, ProviderDelivery, ProviderDeliveryResult,
            ProviderKind,
        };
        use axum::{
            body::Bytes,
            extract::State,
            http::{HeaderMap, StatusCode},
            routing::post,
            Router,
        };
        use tokio::net::TcpListener;

        type Captured = Arc<Mutex<Option<(String, String, Vec<u8>)>>>;
        async fn receive(
            State(capture): State<Captured>,
            headers: HeaderMap,
            body: Bytes,
        ) -> StatusCode {
            *capture.lock().unwrap() = Some((
                headers["authorization"].to_str().unwrap().to_owned(),
                headers["apns-topic"].to_str().unwrap().to_owned(),
                body.to_vec(),
            ));
            assert_eq!(headers["apns-push-type"], "alert");
            StatusCode::OK
        }
        let capture = Captured::default();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn({
            let capture = capture.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/3/device/{token}", post(receive))
                        .with_state(capture),
                )
                .await
                .unwrap();
            }
        });
        let (_temporary, credentials) = fixture();
        let notification = crate::OpaqueNotificationEvent {
            id: format!("evt_{}", "cd".repeat(32)),
            category: crate::TEST_EVENT_CATEGORY.to_owned(),
            deep_link: "mfw://notifications".to_owned(),
            received_at: NOW.to_string(),
            opened: false,
        };
        let result = tokio::task::spawn_blocking(move || {
            let adapter = DirectProviderDelivery::with_test_endpoints(
                None,
                Some((
                    ApnsDeliveryConfig {
                        topic: "com.tex8.monerowallet.desktop".to_owned(),
                        credentials,
                        sandbox: false,
                    },
                    endpoint,
                )),
            )
            .unwrap();
            adapter.validate_credentials().unwrap();
            adapter
                .deliver(ProviderKind::Apns, &"ab".repeat(32), &notification)
                .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(result, ProviderDeliveryResult::Delivered);
        let captured = capture.lock().unwrap();
        let (authorization, topic, body) = captured.as_ref().unwrap();
        let token = authorization.strip_prefix("bearer ").unwrap();
        let issued = claims(token)["iat"].as_u64().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(issued <= now && now - issued < 30);
        assert_eq!(topic, "com.tex8.monerowallet.desktop");
        let payload: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(payload["type"], crate::TEST_EVENT_CATEGORY);
        assert_eq!(payload["contractVersion"], crate::CONTRACT_VERSION);
        assert!(!std::str::from_utf8(body).unwrap().contains(token));
        for forbidden in [
            "amountAtomic",
            "transactionId",
            "walletAddress",
            "privateViewKey",
        ] {
            assert!(!std::str::from_utf8(body).unwrap().contains(forbidden));
        }
        server.abort();
    }
}
