// transport-protocol-bench compares reliable transports using identical,
// deterministic application frames. It is intentionally separate from Cuprate.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/anacrolix/utp"
	quic "github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	frameSize            = 64 * 1024
	streamReceiveWindow  = 4 << 20
	maxStreamWindow      = 8 << 20
	connectionWindow     = 32 << 20
	maxConnectionWindow  = 64 << 20
	socketBuffer         = 16 << 20
	maxConcurrentStreams = 128
)

var pad = func() []byte {
	b := make([]byte, frameSize-8)
	for i := range b {
		b[i] = byte((i*31 + 17) % 251)
	}
	return b
}()

type counters struct {
	bytes  atomic.Uint64
	frames atomic.Uint64
	bad    atomic.Uint64
}

type processSample struct {
	userMS       int64
	systemMS     int64
	maxRSSRaw    int64
	totalAlloc   uint64
	heapInuse    uint64
	gcPauseTotal uint64
}

func durationMS(v syscall.Timeval) int64 {
	return int64(v.Sec)*1000 + int64(v.Usec)/1000
}

func sampleProcess() processSample {
	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	return processSample{
		userMS:       durationMS(usage.Utime),
		systemMS:     durationMS(usage.Stime),
		maxRSSRaw:    usage.Maxrss,
		totalAlloc:   mem.TotalAlloc,
		heapInuse:    mem.HeapInuse,
		gcPauseTotal: mem.PauseTotalNs,
	}
}

func measurementFields(before, after processSample) string {
	return fmt.Sprintf(
		"cpu_user_ms=%d cpu_system_ms=%d max_rss_raw=%d heap_alloc_bytes=%d heap_inuse_bytes=%d gc_pause_ms=%.2f",
		after.userMS-before.userMS,
		after.systemMS-before.systemMS,
		after.maxRSSRaw,
		after.totalAlloc-before.totalAlloc,
		after.heapInuse,
		float64(after.gcPauseTotal-before.gcPauseTotal)/float64(time.Millisecond),
	)
}

func runMemoryBandwidth(duration time.Duration, bytes int) error {
	if bytes < frameSize {
		return fmt.Errorf("membw-bytes must be at least %d", frameSize)
	}
	src := make([]byte, bytes)
	dst := make([]byte, bytes)
	for i := range src {
		src[i] = byte(i)
	}
	start := time.Now()
	var copied uint64
	var checksum byte
	for time.Since(start) < duration {
		copy(dst, src)
		checksum ^= dst[(copied/uint64(bytes))%uint64(bytes)]
		copied += uint64(bytes)
	}
	elapsed := time.Since(start)
	fmt.Printf("mode=membw elapsed_ms=%d copied_bytes=%d copy_gib_s=%.2f checksum=%d\n",
		elapsed.Milliseconds(), copied, float64(copied)/elapsed.Seconds()/1024/1024/1024, checksum)
	return nil
}

func frame(seq uint64) []byte {
	b := make([]byte, frameSize)
	binary.BigEndian.PutUint64(b, seq)
	copy(b[8:], pad)
	return b
}
func checkFrame(b []byte, want uint64, c *counters) bool {
	if len(b) != frameSize || binary.BigEndian.Uint64(b) != want || !bytes.Equal(b[8:], pad) {
		c.bad.Add(1)
		return false
	}
	c.bytes.Add(frameSize)
	c.frames.Add(1)
	return true
}

func tunedTCPConn(conn net.Conn) net.Conn {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return conn
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return conn
	}
	_ = raw.Control(func(fd uintptr) {
		// The kernel can clamp these values. The benchmark records application
		// throughput, so a failed hint never turns into a false success.
		_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, socketBuffer)
		_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, socketBuffer)
	})
	return conn
}

type tunedListener struct{ net.Listener }

func (l tunedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return tunedTCPConn(c), nil
}

func dialTCP(ctx context.Context, addr string) (net.Conn, error) {
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	return tunedTCPConn(c), nil
}

func quicConfig() *quic.Config {
	return &quic.Config{
		InitialStreamReceiveWindow:     streamReceiveWindow,
		MaxStreamReceiveWindow:         maxStreamWindow,
		InitialConnectionReceiveWindow: connectionWindow,
		MaxConnectionReceiveWindow:     maxConnectionWindow,
		MaxIncomingStreams:             maxConcurrentStreams,
		MaxIdleTimeout:                 90 * time.Second,
	}
}
func writeFrames(ctx context.Context, send func([]byte) error) error {
	for seq := uint64(0); ; seq++ {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		if err := send(frame(seq)); err != nil {
			return err
		}
	}
}

func countedWriter(write func([]byte) (int, error), c *counters) func([]byte) error {
	return func(b []byte) error {
		n, err := write(b)
		if err == nil && n != len(b) {
			err = io.ErrShortWrite
		}
		if err == nil {
			c.bytes.Add(uint64(n))
			c.frames.Add(1)
		}
		return err
	}
}
func readFrames(ctx context.Context, read func([]byte) error, c *counters) error {
	b := make([]byte, frameSize)
	for seq := uint64(0); ; seq++ {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		if err := read(b); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if !checkFrame(b, seq, c) {
			return fmt.Errorf("invalid frame %d", seq)
		}
	}
}

func serveConn(conn net.Conn) {
	defer conn.Close()
	mode := []byte{0}
	if _, err := io.ReadFull(conn, mode); err != nil {
		return
	}
	if mode[0] == 'D' {
		_ = writeFrames(context.Background(), func(b []byte) error { _, err := conn.Write(b); return err })
	} else {
		_ = readFrames(context.Background(), func(b []byte) error { _, err := io.ReadFull(conn, b); return err }, &counters{})
	}
}
func runNetServer(protocol, addr string) error {
	var l net.Listener
	var err error
	if protocol == "tcp" {
		l, err = net.Listen("tcp", addr)
		if err == nil {
			l = tunedListener{l}
		}
	} else {
		l, err = utp.Listen(addr)
	}
	if err != nil {
		return err
	}
	defer l.Close()
	fmt.Printf("ready protocol=%s addr=%s\n", protocol, addr)
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		go serveConn(c)
	}
}
func runNetClient(protocol, addr, direction string, duration time.Duration, streams int, c *counters) error {
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	var wg sync.WaitGroup
	errCh := make(chan error, streams)
	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var conn net.Conn
			var err error
			if protocol == "tcp" {
				conn, err = dialTCP(ctx, addr)
			} else {
				conn, err = utp.Dial(addr)
			}
			if err != nil {
				errCh <- err
				return
			}
			defer conn.Close()
			marker := byte('U')
			if direction == "download" {
				marker = 'D'
			}
			_, _ = conn.Write([]byte{marker})
			if direction == "download" {
				err = readFrames(ctx, func(b []byte) error { _, e := io.ReadFull(conn, b); return e }, c)
			} else {
				err = writeFrames(ctx, countedWriter(conn.Write, c))
			}
			if err != nil && !errors.Is(err, context.DeadlineExceeded) {
				errCh <- err
			}
		}()
	}
	wg.Wait()
	close(errCh)
	if ctx.Err() != nil {
		return nil
	}
	for err := range errCh {
		return err
	}
	return nil
}

func httpHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/stream" {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		seq := uint64(0)
		for {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			if _, err := w.Write(frame(seq)); err != nil {
				return
			}
			seq++
			if seq%32 == 0 {
				_ = http.NewResponseController(w).Flush()
			}
		}
	}
	if r.Method == http.MethodPost {
		var received counters
		err := readFrames(r.Context(), func(b []byte) error { _, e := io.ReadFull(r.Body, b); return e }, &received)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("X-Bench-Bytes", fmt.Sprintf("%d", received.bytes.Load()))
		w.Header().Set("X-Bench-Bad-Frames", fmt.Sprintf("%d", received.bad.Load()))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusMethodNotAllowed)
}
func runHTTP2Server(addr string) error {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s := &http.Server{Handler: h2c.NewHandler(http.HandlerFunc(httpHandler), &http2.Server{
		MaxConcurrentStreams:         maxConcurrentStreams,
		MaxUploadBufferPerConnection: connectionWindow,
		MaxUploadBufferPerStream:     streamReceiveWindow,
	})}
	fmt.Printf("ready protocol=http2 addr=%s\n", addr)
	return s.Serve(tunedListener{l})
}
func selfSigned() (*tls.Config, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tpl := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "transport-bench"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), DNSNames: []string{"localhost"}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, &tpl, &tpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	cert, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}))
	if err != nil {
		return nil, err
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"h3"}}, nil
}
func runHTTP3Server(addr string) error {
	tlsCfg, err := selfSigned()
	if err != nil {
		return err
	}
	udp, err := net.ListenUDP("udp", mustResolveUDPAddr(addr))
	if err != nil {
		return err
	}
	_ = udp.SetReadBuffer(socketBuffer)
	_ = udp.SetWriteBuffer(socketBuffer)
	s := &http3.Server{Handler: http.HandlerFunc(httpHandler), TLSConfig: tlsCfg, QUICConfig: quicConfig()}
	fmt.Printf("ready protocol=http3 addr=%s\n", addr)
	return s.Serve(udp)
}

func mustResolveUDPAddr(addr string) *net.UDPAddr {
	udp, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		panic(err)
	}
	return udp
}
func newHTTPClient(protocol, addr string) (*http.Client, func()) {
	var rt http.RoundTripper
	scheme := "http"
	if protocol == "http2" {
		rt = &http2.Transport{AllowHTTP: true, DisableCompression: true, StrictMaxConcurrentStreams: true, DialTLSContext: func(ctx context.Context, _, _ string, _ *tls.Config) (net.Conn, error) { return dialTCP(ctx, addr) }}
	} else {
		rt = &http3.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, QUICConfig: quicConfig()}
		scheme = "https"
	}
	closeFn := func() {
		if x, ok := rt.(interface{ CloseIdleConnections() }); ok {
			x.CloseIdleConnections()
		}
	}
	return &http.Client{Transport: rt}, func() { _ = scheme; closeFn() }
}

func runHTTPClient(protocol, addr, direction string, duration time.Duration, connections, streams int, c *counters) error {
	rootCtx, rootCancel := context.WithTimeout(context.Background(), duration+30*time.Second)
	defer rootCancel()
	sendCtx, sendCancel := context.WithTimeout(rootCtx, duration)
	defer sendCancel()
	scheme := "http"
	if protocol == "http3" {
		scheme = "https"
	}
	var wg sync.WaitGroup
	errCh := make(chan error, connections*streams)
	for connection := 0; connection < connections; connection++ {
		client, closeClient := newHTTPClient(protocol, addr)
		defer closeClient()
		for i := 0; i < streams; i++ {
			wg.Add(1)
			go func(client *http.Client) {
				defer wg.Done()
				if direction == "download" {
					req, _ := http.NewRequestWithContext(sendCtx, http.MethodGet, scheme+"://"+addr+"/stream", nil)
					resp, err := client.Do(req)
					if err != nil {
						errCh <- err
						return
					}
					defer resp.Body.Close()
					if err = readFrames(sendCtx, func(b []byte) error { _, e := io.ReadFull(resp.Body, b); return e }, c); err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
						errCh <- err
					}
				} else {
					pr, pw := io.Pipe()
					local := &counters{}
					go func() { _ = writeFrames(sendCtx, countedWriter(pw.Write, local)); _ = pw.Close() }()
					req, _ := http.NewRequestWithContext(rootCtx, http.MethodPost, scheme+"://"+addr+"/stream", pr)
					resp, err := client.Do(req)
					if err != nil {
						errCh <- err
						return
					}
					_, _ = io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
					if resp.StatusCode != http.StatusNoContent || resp.Header.Get("X-Bench-Bad-Frames") != "0" || resp.Header.Get("X-Bench-Bytes") != fmt.Sprintf("%d", local.bytes.Load()) {
						errCh <- fmt.Errorf("server upload acknowledgement mismatch: status=%s bytes=%s bad=%s local=%d", resp.Status, resp.Header.Get("X-Bench-Bytes"), resp.Header.Get("X-Bench-Bad-Frames"), local.bytes.Load())
						return
					}
					c.bytes.Add(local.bytes.Load())
					c.frames.Add(local.frames.Load())
				}
			}(client)
		}
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			return err
		}
	}
	return nil
}

type benchService interface{}

var benchDesc = grpc.ServiceDesc{ServiceName: "bench.Transfer", HandlerType: (*benchService)(nil), Streams: []grpc.StreamDesc{{StreamName: "Stream", Handler: grpcStream, ServerStreams: true, ClientStreams: true}}}

func uploadAck(c *counters) []byte {
	b := make([]byte, 24)
	binary.BigEndian.PutUint64(b[0:8], c.bytes.Load())
	binary.BigEndian.PutUint64(b[8:16], c.frames.Load())
	binary.BigEndian.PutUint64(b[16:24], c.bad.Load())
	return b
}

func verifyUploadAck(b []byte, want *counters) error {
	if len(b) != 24 {
		return fmt.Errorf("malformed server upload acknowledgement")
	}
	gotBytes := binary.BigEndian.Uint64(b[0:8])
	gotFrames := binary.BigEndian.Uint64(b[8:16])
	gotBad := binary.BigEndian.Uint64(b[16:24])
	if gotBytes != want.bytes.Load() || gotFrames != want.frames.Load() || gotBad != 0 {
		return fmt.Errorf("server upload acknowledgement mismatch: bytes=%d frames=%d bad=%d local_bytes=%d local_frames=%d", gotBytes, gotFrames, gotBad, want.bytes.Load(), want.frames.Load())
	}
	return nil
}

func grpcStream(_ interface{}, s grpc.ServerStream) error {
	mode := &wrapperspb.BytesValue{}
	if err := s.RecvMsg(mode); err != nil {
		return err
	}
	if string(mode.Value) == "D" {
		return writeFrames(s.Context(), func(b []byte) error { return s.SendMsg(wrapperspb.Bytes(b)) })
	}
	var received counters
	err := readFrames(s.Context(), func(b []byte) error {
		m := &wrapperspb.BytesValue{}
		if e := s.RecvMsg(m); e != nil {
			return e
		}
		copy(b, m.Value)
		return nil
	}, &received)
	if err != nil {
		return err
	}
	return s.SendMsg(wrapperspb.Bytes(uploadAck(&received)))
}
func runGRPCServer(addr string) error {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s := grpc.NewServer(
		grpc.MaxConcurrentStreams(maxConcurrentStreams),
		grpc.InitialWindowSize(streamReceiveWindow),
		grpc.InitialConnWindowSize(connectionWindow),
	)
	s.RegisterService(&benchDesc, struct{}{})
	fmt.Printf("ready protocol=grpc addr=%s\n", addr)
	return s.Serve(l)
}
func runGRPCClient(addr, direction string, duration time.Duration, connections, streams int, c *counters) error {
	rootCtx, rootCancel := context.WithTimeout(context.Background(), duration+30*time.Second)
	defer rootCancel()
	sendCtx, sendCancel := context.WithTimeout(rootCtx, duration)
	defer sendCancel()
	var wg sync.WaitGroup
	errCh := make(chan error, connections*streams)
	for connection := 0; connection < connections; connection++ {
		conn, err := grpc.DialContext(rootCtx, addr,
			grpc.WithTransportCredentials(insecure.NewCredentials()),
			grpc.WithContextDialer(dialTCP),
			grpc.WithInitialWindowSize(streamReceiveWindow),
			grpc.WithInitialConnWindowSize(connectionWindow),
		)
		if err != nil {
			return err
		}
		defer conn.Close()
		for i := 0; i < streams; i++ {
			wg.Add(1)
			go func(conn *grpc.ClientConn) {
				defer wg.Done()
				st, e := conn.NewStream(rootCtx, &benchDesc.Streams[0], "/bench.Transfer/Stream")
				if e != nil {
					errCh <- e
					return
				}
				mode := "U"
				if direction == "download" {
					mode = "D"
				}
				if e = st.SendMsg(wrapperspb.String(mode)); e != nil {
					errCh <- e
					return
				}
				if direction == "download" {
					e = readFrames(sendCtx, func(b []byte) error {
						m := &wrapperspb.BytesValue{}
						if x := st.RecvMsg(m); x != nil {
							return x
						}
						copy(b, m.Value)
						return nil
					}, c)
				} else {
					local := &counters{}
					e = writeFrames(sendCtx, func(b []byte) error {
						e := st.SendMsg(wrapperspb.Bytes(b))
						if e == nil {
							local.bytes.Add(frameSize)
							local.frames.Add(1)
						}
						return e
					})
					_ = st.CloseSend()
					if e == nil {
						ack := &wrapperspb.BytesValue{}
						e = st.RecvMsg(ack)
						if e == nil {
							e = verifyUploadAck(ack.Value, local)
						}
					}
					if e == nil {
						c.bytes.Add(local.bytes.Load())
						c.frames.Add(local.frames.Load())
					}
				}
				if e != nil && !errors.Is(e, context.DeadlineExceeded) && !errors.Is(e, context.Canceled) {
					errCh <- e
				}
			}(conn)
		}
	}
	wg.Wait()
	close(errCh)
	for e := range errCh {
		if !errors.Is(e, context.Canceled) {
			return e
		}
	}
	return nil
}

func main() {
	mode := flag.String("mode", "", "server, client, or membw")
	protocol := flag.String("protocol", "", "tcp|grpc|http2|http3|utp")
	addr := flag.String("addr", "", "bind address (server) or host:port (client)")
	direction := flag.String("direction", "download", "download or upload")
	streams := flag.Int("streams", 1, "parallel transfers")
	connections := flag.Int("connections", 1, "physical connections; streams are opened on each connection")
	duration := flag.Duration("duration", 20*time.Second, "client duration")
	memoryBandwidthBytes := flag.Int("membw-bytes", 64<<20, "bytes copied by -mode membw")
	flag.Parse()
	if *mode == "membw" {
		if err := runMemoryBandwidth(*duration, *memoryBandwidthBytes); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *mode == "" || *protocol == "" || *addr == "" || (*direction != "download" && *direction != "upload") || *streams < 1 || *connections < 1 {
		fmt.Fprintln(os.Stderr, "usage: -mode server|client|membw -protocol tcp|grpc|http2|http3|utp -addr host:port [-direction download|upload] [-connections N] [-streams N]")
		os.Exit(2)
	}
	if *mode == "server" {
		var err error
		switch *protocol {
		case "tcp", "utp":
			err = runNetServer(*protocol, *addr)
		case "http2":
			err = runHTTP2Server(*addr)
		case "http3":
			err = runHTTP3Server(*addr)
		case "grpc":
			err = runGRPCServer(*addr)
		default:
			err = fmt.Errorf("unknown protocol")
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	c := &counters{}
	processBefore := sampleProcess()
	start := time.Now()
	var err error
	switch *protocol {
	case "tcp", "utp":
		err = runNetClient(*protocol, *addr, *direction, *duration, *streams, c)
	case "http2", "http3":
		err = runHTTPClient(*protocol, *addr, *direction, *duration, *connections, *streams, c)
	case "grpc":
		err = runGRPCClient(*addr, *direction, *duration, *connections, *streams, c)
	default:
		err = fmt.Errorf("unknown protocol")
	}
	elapsed := time.Since(start)
	processAfter := sampleProcess()
	b := c.bytes.Load()
	fmt.Printf("protocol=%s direction=%s connections=%d streams_per_connection=%d total_streams=%d elapsed_ms=%d payload_bytes=%d payload_mib_s=%.2f bad_frames=%d %s\n", *protocol, *direction, *connections, *streams, *connections**streams, elapsed.Milliseconds(), b, float64(b)/elapsed.Seconds()/1024/1024, c.bad.Load(), measurementFields(processBefore, processAfter))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
