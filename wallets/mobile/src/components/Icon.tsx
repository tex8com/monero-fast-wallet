import React from 'react';
import Svg, {Path, Circle, Rect, Line, G} from 'react-native-svg';

/**
 * Generic Lucide-style outline icons rendered via react-native-svg.
 * Replaces emoji icons (📷 etc.) which fail to render on iOS 26 simulators.
 *
 * Add a new icon by extending the `RENDERERS` map below.
 */

export type IconName =
  | 'qr-scan'
  | 'camera'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'close'
  | 'check'
  | 'copy'
  | 'paste'
  | 'send'
  | 'wallet'
  | 'settings'
  | 'lock'
  | 'key'
  | 'globe'
  | 'fingerprint'
  | 'clock'
  | 'onion'
  | 'dollar'
  | 'language'
  | 'info'
  | 'file'
  | 'package'
  | 'plus'
  | 'edit'
  | 'trash'
  | 'chevron-right'
  | 'map-pin'
  | 'message-circle'
  | 'users'
  | 'lightbulb';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const stroke = (color: string, sw: number) => ({
  stroke: color,
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
});

const RENDERERS: Record<IconName, (color: string, sw: number) => React.ReactNode> = {
  // QR scan: outer brackets framing a small QR pattern in the center
  'qr-scan': (c, sw) => (
    <G {...stroke(c, sw)}>
      {/* Corner brackets */}
      <Path d="M3 8 V4 H7" />
      <Path d="M21 8 V4 H17" />
      <Path d="M3 16 V20 H7" />
      <Path d="M21 16 V20 H17" />
      {/* QR squares */}
      <Rect x={9} y={9} width={2.5} height={2.5} fill={c} stroke="none" />
      <Rect x={13} y={9} width={2.5} height={2.5} fill={c} stroke="none" />
      <Rect x={9} y={13} width={2.5} height={2.5} fill={c} stroke="none" />
      <Rect x={13} y={13} width={2.5} height={2.5} fill={c} stroke="none" />
    </G>
  ),
  camera: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M3 8 Q3 6 5 6 L8 6 L9.5 4 L14.5 4 L16 6 L19 6 Q21 6 21 8 L21 18 Q21 20 19 20 L5 20 Q3 20 3 18 Z" />
      <Circle cx={12} cy={13} r={3.5} />
    </G>
  ),
  'arrow-up': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={12} y1={20} x2={12} y2={4} />
      <Path d="M6 10 L12 4 L18 10" />
    </G>
  ),
  'arrow-down': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={12} y1={4} x2={12} y2={20} />
      <Path d="M6 14 L12 20 L18 14" />
    </G>
  ),
  'arrow-left': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={20} y1={12} x2={4} y2={12} />
      <Path d="M10 6 L4 12 L10 18" />
    </G>
  ),
  'arrow-right': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={4} y1={12} x2={20} y2={12} />
      <Path d="M14 6 L20 12 L14 18" />
    </G>
  ),
  close: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={6} y1={6} x2={18} y2={18} />
      <Line x1={18} y1={6} x2={6} y2={18} />
    </G>
  ),
  check: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M5 12 L10 17 L19 7" />
    </G>
  ),
  copy: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Rect x={9} y={9} width={11} height={11} rx={2} />
      <Path d="M5 15 L4 15 Q4 4 4 4 L15 4 Q15 5 15 5" />
    </G>
  ),
  paste: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Rect x={5} y={5} width={14} height={16} rx={2} />
      <Rect x={9} y={2} width={6} height={4} rx={1} />
    </G>
  ),
  send: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M3 11 L21 4 L14 21 L11 13 Z" />
    </G>
  ),
  wallet: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M3 7 Q3 5 5 5 L19 5 Q21 5 21 7 L21 18 Q21 20 19 20 L5 20 Q3 20 3 18 Z" />
      <Path d="M3 9 L18 9 Q19 9 19 10 L19 14 Q19 15 18 15 L3 15" />
      <Circle cx={16} cy={12} r={1.2} fill={c} stroke="none" />
    </G>
  ),
  settings: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Circle cx={12} cy={12} r={3} />
      <Path d="M12 2 L12 5 M12 19 L12 22 M4.93 4.93 L7.05 7.05 M16.95 16.95 L19.07 19.07 M2 12 L5 12 M19 12 L22 12 M4.93 19.07 L7.05 16.95 M16.95 7.05 L19.07 4.93" />
    </G>
  ),
  lock: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Rect x={5} y={11} width={14} height={10} rx={2} />
      <Path d="M8 11 V7 Q8 3 12 3 Q16 3 16 7 V11" />
    </G>
  ),
  key: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Circle cx={8} cy={15} r={4} />
      <Path d="M11 12 L21 2 M17 6 L20 9 M14 9 L17 12" />
    </G>
  ),
  globe: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M3 12 H21" />
      <Path d="M12 3 Q16 7.5 16 12 Q16 16.5 12 21 Q8 16.5 8 12 Q8 7.5 12 3" />
    </G>
  ),
  'map-pin': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M20 10 C20 16 12 22 12 22 C12 22 4 16 4 10 C4 5.6 7.6 2 12 2 C16.4 2 20 5.6 20 10 Z" />
      <Circle cx={12} cy={10} r={2.5} />
    </G>
  ),
  'message-circle': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M21 11.5 A8.5 8.5 0 0 1 7.2 18.2 L3 20 L4.8 15.8 A8.5 8.5 0 1 1 21 11.5 Z" />
    </G>
  ),
  users: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Circle cx={9} cy={8} r={3} />
      <Path d="M3.5 20 C3.5 16.5 5.5 14 9 14 C12.5 14 14.5 16.5 14.5 20" />
      <Path d="M15 5.5 C17.2 5.5 18.5 6.8 18.5 8.5 C18.5 10.2 17.2 11.5 15 11.5" />
      <Path d="M16 14 C19 14 21 16 21 19" />
    </G>
  ),
  fingerprint: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M6 11 Q6 6 12 6 Q18 6 18 11 Q18 16 16 20" />
      <Path d="M9 11 Q9 9 12 9 Q15 9 15 11 Q15 14 13 18" />
      <Path d="M12 11 V14 Q12 17 11 19" />
      <Path d="M5 14 Q5 18 7 21" />
    </G>
  ),
  clock: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Circle cx={12} cy={12} r={9} />
      <Path d="M12 7 V12 L16 14" />
    </G>
  ),
  onion: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M12 3 Q12 6 14 8 Q19 11 19 16 Q19 21 12 21 Q5 21 5 16 Q5 11 10 8 Q12 6 12 3 Z" />
      <Path d="M9 13 Q9 17 12 20" />
      <Path d="M15 13 Q15 17 12 20" />
    </G>
  ),
  dollar: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={12} y1={3} x2={12} y2={21} />
      <Path d="M17 7 H10 Q7 7 7 10 Q7 12.5 10 12.5 H14 Q17 12.5 17 15 Q17 18 14 18 H6" />
    </G>
  ),
  language: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M3 7 H13" />
      <Path d="M8 4 V7 Q8 13 3 17" />
      <Path d="M5 11 Q9 16 14 17" />
      <Path d="M12 21 L17 10 L22 21" />
      <Path d="M14 17 H20" />
    </G>
  ),
  info: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Circle cx={12} cy={12} r={9} />
      <Line x1={12} y1={11} x2={12} y2={17} />
      <Circle cx={12} cy={7.5} r={0.6} fill={c} stroke="none" />
    </G>
  ),
  file: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M6 3 H14 L19 8 V20 Q19 21 18 21 H6 Q5 21 5 20 V4 Q5 3 6 3 Z" />
      <Path d="M14 3 V8 H19" />
      <Line x1={8} y1={13} x2={16} y2={13} />
      <Line x1={8} y1={17} x2={14} y2={17} />
    </G>
  ),
  package: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M3 7 L12 3 L21 7 V17 L12 21 L3 17 Z" />
      <Path d="M3 7 L12 11 L21 7" />
      <Line x1={12} y1={11} x2={12} y2={21} />
      <Path d="M7.5 5 L16.5 9" />
    </G>
  ),
  plus: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Line x1={12} y1={5} x2={12} y2={19} />
      <Line x1={5} y1={12} x2={19} y2={12} />
    </G>
  ),
  edit: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M4 20 H8 L19 9 L15 5 L4 16 Z" />
      <Path d="M13.5 6.5 L17.5 10.5" />
      <Path d="M15 5 L16.5 3.5 Q18 2 19.5 3.5 L20.5 4.5 Q22 6 20.5 7.5 L19 9" />
    </G>
  ),
  trash: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M4 7 H20" />
      <Path d="M10 11 V17" />
      <Path d="M14 11 V17" />
      <Path d="M6 7 L7 21 H17 L18 7" />
      <Path d="M9 7 V4 H15 V7" />
    </G>
  ),
  'chevron-right': (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M9 6 L15 12 L9 18" />
    </G>
  ),
  lightbulb: (c, sw) => (
    <G {...stroke(c, sw)}>
      <Path d="M9 18 H15" />
      <Path d="M10 21 H14" />
      <Path d="M12 3 Q6 3 6 9 Q6 12 9 14 Q9.5 15 9.5 17 H14.5 Q14.5 15 15 14 Q18 12 18 9 Q18 3 12 3 Z" />
    </G>
  ),
};

export const Icon: React.FC<IconProps> = ({name, size = 24, color = '#FFFFFF', strokeWidth = 1.8}) => {
  const renderer = RENDERERS[name];
  if (!renderer) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {renderer(color, strokeWidth)}
    </Svg>
  );
};

export default Icon;
