#!/usr/bin/env python3
"""Exercise the production Java SOCKS/HTTP probe using loopback sockets only."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = root / 'wallets/mobile/android/app/src/main/java/com/monerowallet/TorRouteProbe.java'
jdk = Path('/Users/rolandkohlhuber/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin')
javac = str(jdk / 'javac') if (jdk / 'javac').exists() else shutil.which('javac')
java = str(jdk / 'java') if (jdk / 'java').exists() else shutil.which('java')
assert javac and java, 'A local JDK is required; no Gradle or dependency download is needed'
harness = r'''
package com.monerowallet;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;

public final class TorRouteProbeTest {
  interface Handler { void run(Socket socket) throws Exception; }
  interface Case { void run() throws Exception; }
  private static int passed;
  private static final String BODY = "{\"height\":7,\"status\":\"OK\"}";
  private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  private static void test(String name, Case body) throws Exception { body.run(); passed++; System.out.println("PASS " + name); }
  static final class ProxyServer implements AutoCloseable {
    final ServerSocket listener = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
    final AtomicReference<Throwable> error = new AtomicReference<>();
    final Thread thread;
    ProxyServer(Handler handler) throws IOException {
      thread = new Thread(() -> {
        try (Socket socket = listener.accept()) { socket.setSoTimeout(2000); handler.run(socket); }
        catch (IOException expectedClientAbort) { }
        catch (Throwable failure) { error.set(failure); }
      });
      thread.setDaemon(true); thread.start();
    }
    int port() { return listener.getLocalPort(); }
    public void close() throws Exception { listener.close(); thread.join(2000); if (error.get() != null) throw new AssertionError(error.get()); }
  }
  static byte[] exact(InputStream in, int count) throws IOException { byte[] data = new byte[count]; new DataInputStream(in).readFully(data); return data; }
  static void write(Socket socket, String data) throws IOException { socket.getOutputStream().write(data.getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush(); }
  static void hello(Socket socket) throws Exception {
    check(Arrays.equals(exact(socket.getInputStream(), 3), new byte[] {5, 1, 0}), "SOCKS greeting");
    socket.getOutputStream().write(new byte[] {5, 0}); socket.getOutputStream().flush();
    check(Arrays.equals(exact(socket.getInputStream(), 4), new byte[] {5, 1, 0, 3}), "SOCKS remote domain request");
    int length = socket.getInputStream().read();
    check(new String(exact(socket.getInputStream(), length), StandardCharsets.US_ASCII).equals("probe.invalid"), "destination must travel unresolved through SOCKS");
    check(Arrays.equals(exact(socket.getInputStream(), 2), new byte[] {70, (byte) 169}), "destination port");
  }
  static void success(Socket socket, int delay, int perByte) throws Exception {
    hello(socket); if (delay > 0) Thread.sleep(delay);
    for (byte value : new byte[] {5, 0, 0, 1, 0, 0, 0, 0, 0, 0}) {
      socket.getOutputStream().write(value); socket.getOutputStream().flush(); if (perByte > 0) Thread.sleep(perByte);
    }
  }
  static void request(Socket socket) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    while (bytes.size() < 2048) { int value = socket.getInputStream().read(); if (value < 0) throw new EOFException(); bytes.write(value); if (bytes.toString("US-ASCII").endsWith("\r\n\r\n")) break; }
    check(bytes.toString("US-ASCII").startsWith("GET /get_height HTTP/1.1\r\nHost: probe.invalid\r\n"), "health request");
  }
  static byte[] probe(ProxyServer proxy, int socksMs, int httpMs, int limit) throws IOException {
    return TorRouteProbe.probe("127.0.0.1", proxy.port(), "probe.invalid", 18089, phase -> {}, 250, socksMs, httpMs, limit);
  }
  static void failure(Handler server, int socksMs, int httpMs, int limit, String phase, boolean timeout) throws Exception {
    long started = System.nanoTime();
    try (ProxyServer proxy = new ProxyServer(server)) {
      try { probe(proxy, socksMs, httpMs, limit); throw new AssertionError("unexpected healthy result"); }
      catch (TorRouteProbe.Failure error) {
        check(error.phase.equals(phase), "wrong failed phase " + error.phase);
        if (timeout) check(error.getCause() instanceof SocketTimeoutException, "expected real timeout");
        check((System.nanoTime() - started) / 1_000_000 < 1200, "deadline was reset by fragments");
      }
    }
  }
  public static void main(String[] args) throws Exception {
    test("production budgets separate TCP, SOCKS and HTTP", () -> {
      check(TorRouteProbe.PROXY_CONNECT_TIMEOUT_MS == 8000, "local TCP budget");
      check(TorRouteProbe.SOCKS_HANDSHAKE_TIMEOUT_MS == 60000, "onion handshake budget");
      check(TorRouteProbe.HTTP_RESPONSE_TIMEOUT_MS == 15000, "HTTP budget");
    });
    test("delayed fragmented SOCKS succeeds and destination DNS stays remote", () -> {
      try (ProxyServer proxy = new ProxyServer(socket -> { success(socket, 150, 4); request(socket); write(socket, "HTTP/1.1 200 OK\r\nContent-Length: " + BODY.length() + "\r\n\r\n" + BODY); })) {
        check(new String(probe(proxy, 600, 500, 32768), StandardCharsets.UTF_8).equals(BODY), "content length body");
      }
    });
    test("SOCKS fragments share one absolute handshake deadline", () -> failure(socket -> { success(socket, 0, 40); }, 130, 500, 32768, "socks_connect", true));
    test("SOCKS failure never reaches HTTP or reports connected", () -> failure(socket -> { hello(socket); socket.getOutputStream().write(new byte[] {5, 5, 0, 1}); socket.getOutputStream().flush(); }, 500, 500, 32768, "socks_connect", false));
    test("invalid SOCKS reserved byte is rejected", () -> failure(socket -> { hello(socket); socket.getOutputStream().write(new byte[] {5, 0, 1, 1}); socket.getOutputStream().flush(); }, 500, 500, 32768, "socks_connect", false));
    test("chunked body is completely decoded", () -> {
      try (ProxyServer proxy = new ProxyServer(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + Integer.toHexString(BODY.length()) + ";ok=yes\r\n" + BODY + "\r\n0\r\nX-Test: ok\r\n\r\n"); })) {
        check(new String(probe(proxy, 500, 500, 32768), StandardCharsets.UTF_8).equals(BODY), "chunked body");
      }
    });
    test("connection-close body is accepted only after complete EOF", () -> {
      try (ProxyServer proxy = new ProxyServer(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.0 200 OK\r\n\r\n" + BODY); })) {
        check(new String(probe(proxy, 500, 500, 32768), StandardCharsets.UTF_8).equals(BODY), "close-delimited body");
      }
    });
    test("non-200 daemon status stays a failure", () -> failure(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.1 503 Offline\r\nContent-Length: 0\r\n\r\n"); }, 500, 500, 32768, "http_response", false));
    test("premature content-length EOF stays a failure", () -> failure(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.1 200 OK\r\nContent-Length: 80\r\n\r\n{}"); }, 500, 500, 32768, "http_response", false));
    test("oversized response is rejected before collecting its body", () -> failure(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n"); }, 500, 500, 128, "http_response", false));
    test("slow HTTP body cannot restart the total response deadline", () -> failure(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.1 200 OK\r\nContent-Length: " + BODY.length() + "\r\n\r\n"); for (char value : BODY.toCharArray()) { write(socket, String.valueOf(value)); Thread.sleep(40); } }, 500, 130, 32768, "http_response", true));
    test("slow HTTP headers cannot bypass the total response deadline", () -> failure(socket -> { success(socket, 0, 0); request(socket); for (char value : "HTTP/1.1 200 OK\r\n".toCharArray()) { write(socket, String.valueOf(value)); Thread.sleep(40); } }, 500, 130, 32768, "http_response", true));
    test("ambiguous HTTP framing stays a failure", () -> failure(socket -> { success(socket, 0, 0); request(socket); write(socket, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n"); }, 500, 500, 32768, "http_response", false));
    System.out.println("passed=" + passed);
  }
}
'''
with tempfile.TemporaryDirectory(prefix='mfw-android-tor-probe-') as work:
    folder = Path(work)
    test = folder / 'TorRouteProbeTest.java'
    test.write_text(harness)
    subprocess.run([javac, '-d', work, str(source), str(test)], check=True)
    subprocess.run([java, '-cp', work, 'com.monerowallet.TorRouteProbeTest'], check=True)
