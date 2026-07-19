use notification_gateway::{router, GatewayState, WnsConfig};
use std::{env, net::SocketAddr};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), String> {
    let bind: SocketAddr = env::var("NOTIFICATION_GATEWAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8090".to_owned())
        .parse()
        .map_err(|_| "NOTIFICATION_GATEWAY_BIND is invalid".to_owned())?;
    let token = env::var("NOTIFICATION_GATEWAY_SCANNER_TOKEN")
        .map_err(|_| "NOTIFICATION_GATEWAY_SCANNER_TOKEN is required".to_owned())?;
    let storage = env::var("NOTIFICATION_GATEWAY_EVENT_STORE")
        .unwrap_or_else(|_| "./notification-events.json".to_owned());
    let wns = WnsConfig::from_environment()?;
    let state = GatewayState::open_with_wns(token, storage, wns)?;
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|_| "notification gateway could not bind".to_owned())?;
    eprintln!("notification-gateway listening on {bind}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| "notification gateway stopped unexpectedly".to_owned())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return;
        };
        signal.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
