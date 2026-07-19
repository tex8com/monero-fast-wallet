import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';

type ScannerState = 'checking' | 'ready' | 'unsupported' | 'denied' | 'failed' | 'invalid';

type BarcodeDetectorLike = {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function extractMoneroAddress(value: string): string | undefined {
  const raw = value.trim();
  const address = raw.replace(/^monero:/i, '').split(/[?#]/, 1)[0]?.trim();
  return address && /^[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address) ? address : undefined;
}

function barcodeDetector(): BarcodeDetectorConstructor | undefined {
  return (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

type Props = {
  open: boolean;
  onClose: () => void;
  onScanned: (address: string) => void;
};

/**
 * Browser/WebView camera scanner used by the desktop renderer. The native
 * wallet still validates the recipient again before it prepares a transfer.
 * A clear paste fallback is deliberately retained for WebViews without the
 * BarcodeDetector API (notably older macOS WebKit builds).
 */
export default function DesktopRecipientQrScanner({ open, onClose, onScanned }: Props) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ScannerState>('checking');

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let stream: MediaStream | undefined;
    let timer: number | undefined;

    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      stream?.getTracks().forEach(track => track.stop());
    };

    const start = async () => {
      setState('checking');
      const Detector = barcodeDetector();
      if (!Detector || !navigator.mediaDevices?.getUserMedia) {
        setState('unsupported');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (disposed) { stop(); return; }
        const video = videoRef.current;
        if (!video) { stop(); return; }
        video.srcObject = stream;
        await video.play();
        const detector = new Detector({ formats: ['qr_code'] });
        setState('ready');
        timer = window.setInterval(() => {
          if (disposed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
          void detector.detect(video).then((codes) => {
            const address = codes.map(code => extractMoneroAddress(code.rawValue ?? '')).find(Boolean);
            if (!address || disposed) {
              if (codes.length) setState('invalid');
              return;
            }
            disposed = true;
            stop();
            onScanned(address);
          }).catch(() => {
            if (!disposed) setState('failed');
          });
        }, 250);
      } catch (error) {
        if (disposed) return;
        const name = error instanceof DOMException ? error.name : '';
        setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
      }
    };

    void start();
    return () => { disposed = true; stop(); };
  }, [onScanned, open]);

  if (!open) return null;
  const message = state === 'unsupported'
    ? t('send.scanCameraUnavailable')
    : state === 'denied'
      ? t('send.scanCameraDenied')
      : state === 'failed'
        ? t('send.scanFailed')
        : state === 'invalid'
          ? t('send.scanInvalid')
          : t('send.scanHint');

  return <div className="camera-scanner-overlay" role="dialog" aria-modal="true" aria-labelledby="scan-address-title">
    <section className="camera-scanner-dialog">
      <header><div><p className="eyebrow">{t('send.recipient')}</p><h2 id="scan-address-title">{t('send.scanAddress')}</h2><p>{message}</p></div><button className="quiet-button" onClick={onClose} type="button">{t('common.close')}</button></header>
      <div className="camera-scanner-view">{state === 'ready' || state === 'checking' ? <video ref={videoRef} autoPlay muted playsInline /> : <span aria-hidden="true">⌁</span>}</div>
      <p className="camera-scanner-fallback">{t('send.scanPasteFallback')}</p>
    </section>
  </div>;
}
