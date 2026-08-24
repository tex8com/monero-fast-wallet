use std::{env, net::SocketAddr};

#[tokio::main]
async fn main() {
    let bind: SocketAddr = env::var("MFW_VANITY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8098".to_owned())
        .parse()
        .expect("MFW_VANITY_BIND must be a socket address");
    assert!(
        bind.ip().is_loopback(),
        "mfw-vanity-service must remain loopback-only; expose it through Tor"
    );

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .expect("bind mfw-vanity-service");
    eprintln!(
        "MFW Vanity Studio on http://localhost:{}/ (loopback only)",
        bind.port()
    );
    let app = mfw_vanity_service::configured_router()
        .await
        .expect("configure mfw-vanity-service");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .expect("serve mfw-vanity-service");
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
