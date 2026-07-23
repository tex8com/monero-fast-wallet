import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LanguageProvider } from './i18n';
import './styles.css';
import '@tex8/customer-desktop/styles.css';
import { moneroWalletPlatformRuntime } from './platformRuntime';

void moneroWalletPlatformRuntime;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider><App /></LanguageProvider>
  </StrictMode>,
);
