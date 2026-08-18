import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';

type ScannerState = 'checking' | 'ready' | 'unavailable' | 'denied' | 'failed';

function extractMoneroAddress(value: string): string | undefined {
  const raw = value.trim();
  const address = raw.replace(/^monero:/i, '').split(/[?#]/, 1)[0]?.trim();
  return address && /^[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address) ? address : undefined;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onScanned: (address: string) => void;
};

/**
 * Full-screen desktop counterpart of the React Native recipient scanner.
 *
 * macOS WKWebView does not consistently expose the browser BarcodeDetector
 * API, even when the webcam itself is available. Decode video frames with
 * jsQR instead, then let the native wallet validate the address again before
 * a transaction can be prepared.
 */
export default function DesktopRecipientQrScanner({ open, onClose, onScanned }: Props) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<ScannerState>('checking');
  const [invalidCode, setInvalidCode] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let completed = false;
    let stream: MediaStream | undefined;
    let animationFrame: number | undefined;
    let lastScanAt = 0;

    const stop = () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      stream?.getTracks().forEach(track => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    const scanFrame = (timestamp: number) => {
      if (disposed || completed) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && timestamp - lastScanAt >= 160) {
        lastScanAt = timestamp;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width > 0 && height > 0) {
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(video, 0, 0, width, height);
            const pixels = context.getImageData(0, 0, width, height);
            const result = jsQR(pixels.data, width, height, { inversionAttempts: 'attemptBoth' });
            if (result?.data) {
              const address = extractMoneroAddress(result.data);
              if (address) {
                completed = true;
                stop();
                onScanned(address);
                return;
              }
              setInvalidCode(true);
            }
          }
        }
      }
      animationFrame = window.requestAnimationFrame(scanFrame);
    };

    const start = async () => {
      setState('checking');
      setInvalidCode(false);
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'user' } },
          audio: false,
        });
        if (disposed) { stop(); return; }
        const video = videoRef.current;
        if (!video) { stop(); setState('failed'); return; }
        video.srcObject = stream;
        await video.play();
        if (disposed) { stop(); return; }
        setState('ready');
        animationFrame = window.requestAnimationFrame(scanFrame);
      } catch (error) {
        if (disposed) return;
        const name = error instanceof DOMException ? error.name : '';
        setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'failed');
      }
    };

    void start();
    return () => { disposed = true; stop(); };
  }, [onScanned, open, retry]);

  if (!open) return null;
  const message = state === 'unavailable'
    ? t('send.scanCameraUnavailable')
    : state === 'denied'
      ? t('send.scanCameraDenied')
      : state === 'failed'
        ? t('send.scanFailed')
        : t('send.scanHint');

  return <div className="camera-scanner-overlay" role="dialog" aria-modal="true" aria-labelledby="scan-address-title">
    <section className="camera-scanner-dialog">
      <header>
        <div><h2 id="scan-address-title">{t('send.scanAddress')}</h2><p>{t('send.scanHint')}</p></div>
        <button className="camera-scanner-close" aria-label={t('common.close')} onClick={onClose} type="button">×</button>
      </header>
      <div className={`camera-scanner-view ${state}`}>
        <video ref={videoRef} autoPlay muted playsInline />
        <canvas ref={canvasRef} aria-hidden="true" />
        {state === 'ready' && <div className="camera-scanner-frame" aria-hidden="true"><i /><i /><i /><i /></div>}
        {state === 'checking' && <div className="camera-scanner-state"><span className="camera-scanner-spinner" /><strong>{t('common.loading')}</strong></div>}
        {(state === 'unavailable' || state === 'denied' || state === 'failed') && <div className="camera-scanner-state"><span className="camera-scanner-icon" aria-hidden="true">⌁</span><strong>{message}</strong><button className="secondary" onClick={() => setRetry(value => value + 1)} type="button">{t('common.retry')}</button></div>}
        {invalidCode && state === 'ready' && <p className="camera-scanner-invalid" role="alert">{t('send.scanInvalid')}</p>}
      </div>
      <p className="camera-scanner-fallback">{t('send.scanPasteFallback')}</p>
    </section>
  </div>;
}
