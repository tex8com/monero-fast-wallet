use community_query_contribution_core::{
    QueryContributionStore, DEFAULT_MINIMUM_INDEPENDENT_CONTRIBUTORS,
};
use enthusiast_v1::{
    internal_router, parse_hex_32, public_router, AccountStore, ApiState,
    SynapseMatrixAccountLifecycle,
};
use std::{
    env,
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() {
    let account_db = required_env("ENTHUSIAST_V1_ACCOUNT_DB");
    let publication_db = required_env("ENTHUSIAST_V1_PUBLICATION_DB");
    let contact_db = required_env("ENTHUSIAST_V1_CONTACT_DB");
    let chat_report_db = required_env("ENTHUSIAST_V1_CHAT_REPORT_DB");
    let notification_db = required_env("ENTHUSIAST_V1_NOTIFICATION_DB");
    let query_contribution_db = required_env("ENTHUSIAST_V1_QUERY_CONTRIBUTION_DB");
    require_separate_databases(&[
        &account_db,
        &publication_db,
        &contact_db,
        &chat_report_db,
        &notification_db,
        &query_contribution_db,
    ]);
    let storage_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_STORAGE_KEY"));
    let storage_key = parse_hex_32(&storage_key_text, "ENTHUSIAST_V1_STORAGE_KEY")
        .expect("ENTHUSIAST_V1_STORAGE_KEY must be a 32-byte hexadecimal key");
    let contact_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_CONTACT_KEY"));
    let contact_key = parse_hex_32(&contact_key_text, "ENTHUSIAST_V1_CONTACT_KEY")
        .expect("ENTHUSIAST_V1_CONTACT_KEY must be a 32-byte hexadecimal key");
    let notification_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_NOTIFICATION_KEY"));
    let notification_key = parse_hex_32(&notification_key_text, "ENTHUSIAST_V1_NOTIFICATION_KEY")
        .expect("ENTHUSIAST_V1_NOTIFICATION_KEY must be a 32-byte hexadecimal key");
    let chat_report_key_text = Zeroizing::new(required_env("ENTHUSIAST_V1_CHAT_REPORT_KEY"));
    let chat_report_key = parse_hex_32(&chat_report_key_text, "ENTHUSIAST_V1_CHAT_REPORT_KEY")
        .expect("ENTHUSIAST_V1_CHAT_REPORT_KEY must be a 32-byte hexadecimal key");
    let query_privacy_salt_text = Zeroizing::new(required_env("ENTHUSIAST_V1_QUERY_PRIVACY_SALT"));
    let query_privacy_salt =
        parse_hex_32(&query_privacy_salt_text, "ENTHUSIAST_V1_QUERY_PRIVACY_SALT")
            .expect("ENTHUSIAST_V1_QUERY_PRIVACY_SALT must be a 32-byte hexadecimal key");
    let minimum_query_contributors = env::var("ENTHUSIAST_V1_QUERY_MIN_CONTRIBUTORS")
        .ok()
        .map(|value| {
            value
                .parse::<u32>()
                .expect("ENTHUSIAST_V1_QUERY_MIN_CONTRIBUTORS must be an integer")
        })
        .unwrap_or(DEFAULT_MINIMUM_INDEPENDENT_CONTRIBUTORS);
    let internal_token = Zeroizing::new(required_env("ENTHUSIAST_V1_INTERNAL_TOKEN"));
    let public_bind: SocketAddr = env::var("ENTHUSIAST_V1_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8090".to_owned())
        .parse()
        .expect("ENTHUSIAST_V1_BIND must be a socket address");
    let internal_bind: SocketAddr = env::var("ENTHUSIAST_V1_INTERNAL_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8091".to_owned())
        .parse()
        .expect("ENTHUSIAST_V1_INTERNAL_BIND must be a socket address");
    assert_ne!(
        public_bind, internal_bind,
        "public and internal listeners must use separate addresses"
    );
    assert!(
        internal_bind.ip().is_loopback(),
        "the internal moderation listener must remain loopback-only"
    );

    let accounts = Arc::new(AccountStore::open(&account_db).expect("open Community account store"));
    let publication = Arc::new(
        community_publication_core::PublicationStore::open(&publication_db, storage_key)
            .expect("open Community publication store"),
    );
    let contacts = Arc::new(
        community_contact_core::ContactStore::open(&contact_db, contact_key)
            .expect("open Community contact store"),
    );
    let chat_reports = Arc::new(
        community_chat_report_core::ChatReportStore::open(&chat_report_db, chat_report_key)
            .expect("open encrypted Community chat-report store"),
    );
    let notifications = Arc::new(
        community_notification_core::NotificationStore::open(&notification_db, notification_key)
            .expect("open Community notification store"),
    );
    let query_contributions = Arc::new(
        QueryContributionStore::open(
            &query_contribution_db,
            query_privacy_salt,
            minimum_query_contributors,
        )
        .expect("open private Common-Query contribution store"),
    );
    let mut state = ApiState::new(
        accounts,
        publication,
        contacts,
        chat_reports,
        notifications,
        internal_token.as_bytes(),
    )
    .expect("initialize Community API state")
    .with_query_contributions(query_contributions);
    let matrix_admin = match (
        env::var("ENTHUSIAST_SYNAPSE_ADMIN_ORIGIN").ok(),
        env::var("ENTHUSIAST_SYNAPSE_ADMIN_TOKEN_FILE").ok(),
        env::var("ENTHUSIAST_MATRIX_HOMESERVER").ok(),
        env::var("ENTHUSIAST_MATRIX_SERVER_NAME").ok(),
    ) {
        (Some(origin), Some(token_file), Some(homeserver), Some(server_name)) => {
            let lifecycle = SynapseMatrixAccountLifecycle::new(&origin, PathBuf::from(token_file))
                .and_then(|lifecycle| lifecycle.with_provisioning(&homeserver, &server_name))
                .expect("initialize private Synapse account lifecycle");
            Some(Arc::new(lifecycle))
        }
        (None, None, None, None) => None,
        _ => panic!(
            "ENTHUSIAST_SYNAPSE_ADMIN_ORIGIN, \
             ENTHUSIAST_SYNAPSE_ADMIN_TOKEN_FILE, ENTHUSIAST_MATRIX_HOMESERVER \
             and ENTHUSIAST_MATRIX_SERVER_NAME must be configured together"
        ),
    };
    if let Some(matrix_admin) = matrix_admin {
        state = state
            .with_matrix_lifecycle(matrix_admin.clone())
            .with_matrix_provisioner(matrix_admin);
    }
    drop(internal_token);
    drop(storage_key_text);
    drop(contact_key_text);
    drop(chat_report_key_text);
    drop(notification_key_text);
    drop(query_privacy_salt_text);
    let public_listener = tokio::net::TcpListener::bind(public_bind)
        .await
        .expect("bind public Community V1 listener");
    let internal_listener = tokio::net::TcpListener::bind(internal_bind)
        .await
        .expect("bind internal Community V1 listener");
    eprintln!(
        "enthusiast-v1 public listener on {public_bind}; internal listener on {internal_bind}"
    );
    let public_server = axum::serve(public_listener, public_router(state.clone()));
    let internal_server = axum::serve(internal_listener, internal_router(state));
    tokio::select! {
        result = public_server => result.expect("serve public Community V1 API"),
        result = internal_server => result.expect("serve internal Community V1 API"),
        _ = shutdown() => {}
    }
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn require_separate_databases(paths: &[&str]) {
    let paths = paths
        .iter()
        .map(|path| lexical_absolute(Path::new(path)))
        .collect::<Vec<_>>();
    for (index, path) in paths.iter().enumerate() {
        for other in paths.iter().skip(index + 1) {
            assert_ne!(path, other, "Community databases must use separate paths");
        }
    }
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .expect("read current directory")
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
