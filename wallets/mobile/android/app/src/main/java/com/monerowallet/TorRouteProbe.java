package com.monerowallet;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Bounded SOCKS5 + HTTP health probe. Destination DNS stays inside Tor. */
final class TorRouteProbe {
  static final int PROXY_CONNECT_TIMEOUT_MS = 8_000;
  static final int SOCKS_HANDSHAKE_TIMEOUT_MS = 60_000;
  static final int HTTP_RESPONSE_TIMEOUT_MS = 15_000;
  static final int MAX_RESPONSE_BYTES = 32 * 1024;

  interface PhaseListener { void onPhase(String phase); }
  static final class Failure extends IOException {
    final String phase;
    Failure(String phase, IOException cause) { super("Tor health probe failed during " + phase, cause); this.phase = phase; }
  }
  static byte[] probe(String proxyHost, int proxyPort, String host, int port, PhaseListener listener) throws IOException {
    return probe(proxyHost, proxyPort, host, port, listener, PROXY_CONNECT_TIMEOUT_MS,
        SOCKS_HANDSHAKE_TIMEOUT_MS, HTTP_RESPONSE_TIMEOUT_MS, MAX_RESPONSE_BYTES);
  }
  // The same production code runs with shorter budgets in loopback-only tests.
  static byte[] probe(String proxyHost, int proxyPort, String host, int port, PhaseListener listener,
      int tcpMs, int socksMs, int httpMs, int limit) throws IOException {
    if (!"127.0.0.1".equals(proxyHost) || proxyPort < 1 || proxyPort > 65535 || port < 1 || port > 65535
        || !host.matches("[a-zA-Z0-9.-]{1,253}") || tcpMs <= 0 || socksMs <= 0 || httpMs <= 0 || limit <= 0)
      throw new IOException("Invalid Tor health probe configuration");
    String phase = "proxy_connect";
    try (Socket socket = new Socket()) {
      listener.onPhase(phase);
      socket.connect(new InetSocketAddress(proxyHost, proxyPort), tcpMs);
      final long socksDeadline = deadline(socksMs);
      phase = "socks_greeting"; listener.onPhase(phase);
      socket.getOutputStream().write(new byte[] {5, 1, 0});
      socket.getOutputStream().flush();
      Reader socks = new Reader(socket, socksDeadline, 1024);
      byte[] greeting = socks.exact(2);
      if (greeting[0] != 5 || greeting[1] != 0) throw new IOException("SOCKS authentication rejected");
      phase = "socks_connect"; listener.onPhase(phase);
      byte[] domain = host.getBytes(StandardCharsets.US_ASCII);
      ByteArrayOutputStream request = new ByteArrayOutputStream();
      request.write(new byte[] {5, 1, 0, 3}); request.write(domain.length); request.write(domain);
      request.write((port >>> 8) & 255); request.write(port & 255);
      socket.getOutputStream().write(request.toByteArray()); socket.getOutputStream().flush();
      byte[] reply = socks.exact(4);
      if (reply[0] != 5 || reply[2] != 0 || reply[1] != 0) throw new IOException("SOCKS destination connection rejected");
      int type = reply[3] & 255;
      if (type == 1) socks.exact(4);
      else if (type == 4) socks.exact(16);
      else if (type == 3) { int size = socks.one(); if (size == 0) throw new IOException("Invalid SOCKS address"); socks.exact(size); }
      else throw new IOException("Invalid SOCKS reply address type");
      socks.exact(2);
      phase = "http_response"; listener.onPhase(phase);
      final long httpDeadline = deadline(httpMs);
      String httpRequest = "GET /get_height HTTP/1.1\r\nHost: " + host + "\r\nAccept: application/json\r\nConnection: close\r\n\r\n";
      socket.getOutputStream().write(httpRequest.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
      return readHttp(new Reader(socket, httpDeadline, limit));
    } catch (IOException error) { throw new Failure(phase, error); }
  }

  private static long deadline(int timeoutMs) { return System.nanoTime() + timeoutMs * 1_000_000L; }
  private static byte[] readHttp(Reader input) throws IOException {
    if (!input.line().matches("HTTP/1\\.[01] 200(?: .*)?")) throw new IOException("Daemon health HTTP status is not 200");
    Map<String, String> headers = new HashMap<>();
    for (String line = input.line(); !line.isEmpty(); line = input.line()) {
      int separator = line.indexOf(':');
      if (separator <= 0) throw new IOException("Invalid health HTTP header");
      String name = line.substring(0, separator).trim().toLowerCase(Locale.ROOT);
      String value = line.substring(separator + 1).trim();
      String previous = headers.put(name, value);
      if (previous != null && (!previous.equals(value) || name.equals("transfer-encoding")))
        throw new IOException("Ambiguous health HTTP header");
    }
    String length = headers.get("content-length"), transfer = headers.get("transfer-encoding");
    if (length != null && transfer != null) throw new IOException("Ambiguous health HTTP framing");
    if (transfer != null) {
      if (!transfer.equalsIgnoreCase("chunked")) throw new IOException("Unsupported health transfer encoding");
      ByteArrayOutputStream body = new ByteArrayOutputStream();
      while (true) {
        String sizeText = input.line().split(";", 2)[0].trim();
        if (!sizeText.matches("[0-9a-fA-F]{1,8}")) throw new IOException("Invalid health HTTP chunk");
        long size = Long.parseLong(sizeText, 16);
        if (size > input.remaining()) throw new IOException("Health response exceeds limit");
        if (size == 0) { while (!input.line().isEmpty()) {} return body.toByteArray(); }
        body.write(input.exact((int) size));
        if (input.one() != '\r' || input.one() != '\n') throw new IOException("Invalid health chunk terminator");
      }
    }
    if (length != null) {
      if (!length.matches("[0-9]{1,10}")) throw new IOException("Invalid health content length");
      long size = Long.parseLong(length);
      if (size > input.remaining()) throw new IOException("Health response exceeds limit");
      return input.exact((int) size);
    }
    ByteArrayOutputStream body = new ByteArrayOutputStream();
    int value;
    while ((value = input.optional()) != -1) body.write(value);
    return body.toByteArray();
  }

  private static final class Reader {
    private final Socket socket;
    private final InputStream input;
    private final long deadline;
    private final int limit;
    private int consumed;
    Reader(Socket socket, long deadline, int limit) throws IOException {
      this.socket = socket; this.input = socket.getInputStream(); this.deadline = deadline; this.limit = limit;
    }
    int remaining() { return limit - consumed; }
    int optional() throws IOException {
      if (consumed >= limit) throw new IOException("Health response exceeds limit");
      long remainingNs = deadline - System.nanoTime();
      if (remainingNs <= 0) throw new SocketTimeoutException("Tor health phase deadline exceeded");
      socket.setSoTimeout((int) Math.max(1L, (remainingNs + 999_999L) / 1_000_000L));
      int value = input.read(); if (value != -1) consumed++; return value;
    }
    int one() throws IOException { int value = optional(); if (value == -1) throw new EOFException("Incomplete Tor health response"); return value; }
    byte[] exact(int size) throws IOException {
      if (size < 0 || size > remaining()) throw new IOException("Health response exceeds limit");
      byte[] bytes = new byte[size];
      for (int i = 0; i < size; i++) bytes[i] = (byte) one();
      return bytes;
    }
    String line() throws IOException {
      ByteArrayOutputStream line = new ByteArrayOutputStream();
      while (true) {
        int value = one();
        if (value == '\r') { if (one() != '\n') throw new IOException("Invalid health HTTP line"); return new String(line.toByteArray(), StandardCharsets.US_ASCII); }
        if (value == '\n' || value == 0) throw new IOException("Invalid health HTTP line");
        line.write(value);
      }
    }
  }
}
