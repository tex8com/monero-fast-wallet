export type DesktopIconName =
  | 'home'
  | 'send'
  | 'receive'
  | 'community-tab'
  | 'menu'
  | 'wallet'
  | 'key'
  | 'community-menu'
  | 'settings'
  | 'sparkles'
  | 'globe'
  | 'chevron-right';

type DesktopIconProps = {
  name: DesktopIconName;
  size?: number;
  className?: string;
};

/**
 * The desktop shell deliberately shares the mobile navigation icon geometry.
 * Keeping these small, dependency-free SVGs here avoids platform font glyphs,
 * which render differently across macOS, Windows, and Linux.
 */
export default function DesktopIcon({ name, size = 22, className }: DesktopIconProps) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  let content;
  switch (name) {
    case 'home':
      content = <><path {...common} d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5Z" /><path {...common} d="M9 21v-8h6v8" /></>;
      break;
    case 'send':
      content = <path {...common} d="M12 19V5M5 12l7-7 7 7" />;
      break;
    case 'receive':
      content = <path {...common} d="M12 5v14M5 12l7 7 7-7" />;
      break;
    case 'community-tab':
      content = <><path {...common} d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" /><path {...common} d="M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 20v-1.5a4 4 0 0 0-3-3.87M16.5 3.63a3.5 3.5 0 0 1 0 6.74" /></>;
      break;
    case 'menu':
      content = <><path {...common} d="M4 6h16M4 12h16M4 18h16" /></>;
      break;
    case 'wallet':
      content = <><path {...common} d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 1 4 17.5v-11Z" /><path {...common} d="M4 8h16M15 12h5v4h-5a2 2 0 0 1 0-4Z" /></>;
      break;
    case 'key':
      content = <><circle {...common} cx="8" cy="15" r="4" /><path {...common} d="m11 12 8-8m-3 3 2 2m-5 1 2 2" /></>;
      break;
    case 'community-menu':
      content = <><circle {...common} cx="7" cy="8" r="3" /><circle {...common} cx="17" cy="8" r="3" /><path {...common} d="M4 19c0-3 2-5 5-5h6c3 0 5 2 5 5" /></>;
      break;
    case 'settings':
      content = <><circle {...common} cx="12" cy="12" r="3" /><path {...common} strokeWidth="1.5" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.18V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 7.2 19.73l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.17 14H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.27 7.2l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9.92 3.2V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.18l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.75 10H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" /></>;
      break;
    case 'sparkles':
      content = <path {...common} strokeWidth="1.6" d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 13 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16ZM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15Z" />;
      break;
    case 'globe':
      content = <><circle {...common} cx="12" cy="12" r="9" /><path {...common} d="M3 12h18M12 3c2.5 3 4 6 4 9s-1.5 6-4 9c-2.5-3-4-6-4-9s1.5-6 4-9Z" /></>;
      break;
    case 'chevron-right':
      content = <path {...common} d="m9 5 7 7-7 7" />;
      break;
  }

  return <svg aria-hidden="true" className={className} height={size} viewBox="0 0 24 24" width={size}>{content}</svg>;
}
