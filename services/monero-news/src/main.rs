use monero_news::{router, NewsState};
use std::{env, net::SocketAddr};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), String> {
    let bind: SocketAddr = env::var("MONERO_NEWS_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8091".to_owned())
        .parse()
        .map_err(|_| "MONERO_NEWS_BIND is invalid".to_owned())?;
    let state = NewsState::new()?;
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|error| format!("monero-news could not bind: {error}"))?;
    eprintln!("monero-news listening on {bind}");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| format!("monero-news stopped unexpectedly: {error}"))
}

async fn shutdown_signal() {
    let ctrl_c = async { let _ = tokio::signal::ctrl_c().await; };
    #[cfg(unix)]
    let terminate = async {
        let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) else { return; };
        signal.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
