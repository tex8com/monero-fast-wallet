use enthusiast_moderation_console::{router, ConsoleState};
use std::{env, net::SocketAddr};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() {
    let bind: SocketAddr = env::var("ENTHUSIAST_MODERATION_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8092".to_owned())
        .parse()
        .expect("ENTHUSIAST_MODERATION_BIND must be a socket address");
    assert!(
        bind.ip().is_loopback(),
        "the moderation console must remain loopback-only"
    );
    let internal_token = Zeroizing::new(required_env("ENTHUSIAST_V1_INTERNAL_TOKEN"));
    let password_hash = Zeroizing::new(required_env("ENTHUSIAST_MODERATOR_PASSWORD_HASH"));
    let state = ConsoleState::new(
        &env::var("ENTHUSIAST_V1_INTERNAL_ORIGIN")
            .unwrap_or_else(|_| "http://127.0.0.1:8091/".to_owned()),
        internal_token.to_string(),
        password_hash.to_string(),
        env::var("ENTHUSIAST_MODERATOR_ID").unwrap_or_else(|_| "primary-moderator".to_owned()),
    )
    .expect("initialize moderation console");
    drop(internal_token);
    drop(password_hash);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .expect("bind moderation console");
    eprintln!(
        "enthusiast moderation console on {bind}; open http://localhost:{}/",
        bind.port()
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve moderation console");
}

fn required_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
