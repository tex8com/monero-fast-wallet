// SPDX-License-Identifier: GPL-3.0-only

use std::{io, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};

use crate::config::Backend;

pub trait AsyncStream: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> AsyncStream for T {}
pub type BoxedStream = Box<dyn AsyncStream + Unpin + Send>;

pub async fn connect(backend: &Backend, connect_timeout: Duration) -> Result<BoxedStream> {
    let address = format!("{}:{}", backend.host, backend.port);
    let tcp = timeout(connect_timeout, TcpStream::connect(&address))
        .await
        .with_context(|| format!("connection to {} timed out", backend.name))?
        .with_context(|| format!("failed to connect to {}", backend.name))?;
    tcp.set_nodelay(true)?;

    if !backend.tls {
        return Ok(Box::new(tcp));
    }

    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let server_name = backend
        .tls_server_name
        .as_deref()
        .unwrap_or(&backend.host)
        .to_owned();
    let server_name = ServerName::try_from(server_name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid TLS server name"))?;
    let tls = timeout(connect_timeout, connector.connect(server_name, tcp))
        .await
        .with_context(|| format!("TLS handshake with {} timed out", backend.name))?
        .with_context(|| format!("TLS handshake with {} failed", backend.name))?;

    Ok(Box::new(tls))
}
