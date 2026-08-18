// SPDX-License-Identifier: GPL-3.0-only

use std::{io, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use tracing::{debug, info, warn};

use crate::{
    config::Backend,
    protocol::rewrite_client_message,
    state::{AppState, Selection},
    upstream,
};

pub async fn serve(state: AppState) -> Result<()> {
    let listener = TcpListener::bind(state.config.listen)
        .await
        .with_context(|| format!("failed to bind gateway on {}", state.config.listen))?;
    info!(listen = %state.config.listen, "donation gateway listening");

    loop {
        let (socket, _) = listener.accept().await?;
        socket.set_nodelay(true)?;
        let state = state.clone();
        tokio::spawn(async move {
            state.metrics.connection_opened();
            let result = handle_connection(socket, state.clone()).await;
            state.metrics.connection_closed();
            if let Err(error) = result {
                debug!(%error, "donation connection closed");
            }
        });
    }
}

async fn handle_connection(client: TcpStream, state: AppState) -> Result<()> {
    let mut selection_rx = state.selection_tx.subscribe();
    let selection = selection_rx.borrow_and_update().clone();
    let (backend, upstream) = connect_selected_backend(&state, &selection).await?;
    let (client_read, client_write) = client.into_split();
    let (upstream_read, upstream_write) = tokio::io::split(upstream);
    let client_to_upstream = forward_client_lines(
        client_read,
        upstream_write,
        state.config.max_line_bytes,
        Arc::<str>::from(state.config.donation_address.clone()),
        Arc::<str>::from(backend.password.clone()),
    );
    let upstream_to_client =
        forward_lines(upstream_read, client_write, state.config.max_line_bytes);

    tokio::select! {
        result = client_to_upstream => result.context("client-to-upstream relay failed")?,
        result = upstream_to_client => result.context("upstream-to-client relay failed")?,
        changed = selection_rx.changed() => {
            changed.context("backend selection channel closed")?;
            info!(
                old_backend = %selection.primary,
                new_backend = %selection_rx.borrow().primary,
                "closing client so it reconnects to the selected backend"
            );
        }
    }

    Ok(())
}

async fn connect_selected_backend(
    state: &AppState,
    selection: &Selection,
) -> Result<(Backend, upstream::BoxedStream)> {
    let timeout = Duration::from_secs(state.config.connect_timeout_secs);
    let candidates = state.selected_backends(selection);
    if candidates.is_empty() {
        bail!("no enabled backend candidates");
    }

    let mut last_error = None;
    for backend in candidates {
        match upstream::connect(&backend, timeout).await {
            Ok(stream) => {
                info!(backend = %backend.name, mode = ?backend.mode, "connected donation backend");
                return Ok((backend, stream));
            }
            Err(error) => {
                state.metrics.upstream_failed();
                warn!(backend = %backend.name, %error, "donation backend unavailable");
                last_error = Some(error);
            }
        }
    }

    Err(last_error.expect("at least one candidate was attempted"))
}

async fn forward_client_lines<R, W>(
    reader: R,
    mut writer: W,
    max_line_bytes: usize,
    donation_address: Arc<str>,
    backend_password: Arc<str>,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(reader);
    loop {
        let line = read_line_limited(&mut reader, max_line_bytes).await?;
        if line.is_empty() {
            writer.shutdown().await?;
            return Ok(());
        }

        let rewritten = rewrite_client_message(&line, &donation_address, &backend_password)?;
        writer.write_all(&rewritten).await?;
        writer.flush().await?;
    }
}

async fn forward_lines<R, W>(reader: R, mut writer: W, max_line_bytes: usize) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(reader);
    loop {
        let line = read_line_limited(&mut reader, max_line_bytes).await?;
        if line.is_empty() {
            writer.shutdown().await?;
            return Ok(());
        }
        writer.write_all(&line).await?;
        writer.flush().await?;
    }
}

async fn read_line_limited<R>(reader: &mut BufReader<R>, max_line_bytes: usize) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut line = Vec::new();
    let bytes = reader.read_until(b'\n', &mut line).await?;
    if bytes == 0 {
        return Ok(Vec::new());
    }
    if line.len() > max_line_bytes {
        return Err(
            io::Error::new(io::ErrorKind::InvalidData, "Stratum line exceeds limit").into(),
        );
    }
    if !line.ends_with(b"\n") {
        return Err(
            io::Error::new(io::ErrorKind::UnexpectedEof, "unterminated Stratum line").into(),
        );
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AdminConfig, BackendMode, Config};
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const ADDRESS: &str = "49aaK7WgMCQABhjHt1UyXijKRwbjjbtSq2xbDbB4AgYLGqtXpudonJq58aM4j7fhTWdph4LD7VxjpEwEzBXBdzK2K9vybrL";

    #[tokio::test]
    async fn local_mock_receives_only_mfw_address() {
        let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let gateway_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_address = gateway_listener.local_addr().unwrap();

        let config = Config {
            listen: gateway_address,
            donation_address: ADDRESS.to_owned(),
            active_backend: "mock".to_owned(),
            fallback_backends: Vec::new(),
            max_line_bytes: 64 * 1024,
            connect_timeout_secs: 2,
            admin: AdminConfig::default(),
            backends: vec![Backend {
                name: "mock".to_owned(),
                mode: BackendMode::Pool,
                host: upstream_address.ip().to_string(),
                port: upstream_address.port(),
                tls: false,
                tls_server_name: None,
                password: "mfw~rx/0".to_owned(),
                enabled: true,
            }],
        };
        let state = AppState::new(config, None);

        let state_for_gateway = state.clone();
        let gateway_task = tokio::spawn(async move {
            loop {
                let (socket, _) = gateway_listener.accept().await.unwrap();
                let state = state_for_gateway.clone();
                tokio::spawn(async move { handle_connection(socket, state).await.unwrap() });
            }
        });

        let upstream_task = tokio::spawn(async move {
            let (socket, _) = upstream_listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(value["params"]["login"], ADDRESS);
            assert_eq!(value["params"]["pass"], "mfw~rx/0");
            assert!(value["params"].get("url").is_none());
            write
                .write_all(b"{\"id\":1,\"result\":{\"status\":\"OK\"}}\n")
                .await
                .unwrap();
        });

        let mut client = TcpStream::connect(gateway_address).await.unwrap();
        client
            .write_all(
                b"{\"id\":1,\"method\":\"login\",\"params\":{\"login\":\"attacker\",\"pass\":\"bad\",\"url\":\"evil:3333\"}}\n",
            )
            .await
            .unwrap();
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .await
            .unwrap();
        assert!(response.contains("\"status\":\"OK\""));

        upstream_task.await.unwrap();
        gateway_task.abort();
    }
}
