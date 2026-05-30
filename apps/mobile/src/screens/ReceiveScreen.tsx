import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from "react-native";
import Svg, { Rect } from "react-native-svg";
import { colors, spacing, radius } from "../theme/colors";
import { WALLET } from "../data/mock";
import MoneroLogo from "../components/MoneroLogo";
import { Icon } from "../components/Icon";

/* Generate a deterministic QR-like bit matrix from a string seed */
function generateQrMatrix(seed: string, size: number): boolean[][] {
  // Simple seeded hash to create a deterministic pattern
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const next = () => {
    hash = (hash * 1103515245 + 12345) | 0;
    return (hash >>> 16) & 0x7fff;
  };

  const matrix: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );

  // Finder patterns (3 corners)
  const drawFinder = (r: number, c: number) => {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const border = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        matrix[r + dr][c + dc] = border || inner;
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 7; i < size - 7; i++) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // Fill data area with seeded pseudo-random bits
  const centerMin = Math.floor(size / 2) - 3;
  const centerMax = Math.floor(size / 2) + 3;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // Skip finder pattern zones
      if (r < 8 && c < 8) continue;
      if (r < 8 && c >= size - 8) continue;
      if (r >= size - 8 && c < 8) continue;
      if (r === 6 || c === 6) continue;
      // Skip center area for logo
      if (r >= centerMin && r <= centerMax && c >= centerMin && c <= centerMax) continue;
      matrix[r][c] = next() % 3 !== 0; // ~67% fill for realistic density
    }
  }

  return matrix;
}

function QrCode({ value, size }: { value: string; size: number }) {
  const modules = 33; // QR version 4-ish module count
  const cellSize = size / modules;

  const matrix = useMemo(() => generateQrMatrix(value, modules), [value]);

  return (
    <View style={{ width: size, height: size, backgroundColor: "#FFF", borderRadius: radius.lg, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {matrix.map((row, r) =>
          row.map((cell, c) =>
            cell ? (
              <Rect
                key={`${r}-${c}`}
                x={c * cellSize}
                y={r * cellSize}
                width={cellSize}
                height={cellSize}
                fill="#1A1A2E"
              />
            ) : null,
          ),
        )}
      </Svg>
      {/* Monero logo in center */}
      <View style={{ position: "absolute", backgroundColor: "#FFF", borderRadius: 8, padding: 4 }}>
        <MoneroLogo size={28} />
      </View>
    </View>
  );
}

export default function ReceiveScreen() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // In production: Clipboard.setString(WALLET.address)
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>Receive</Text>
        <Text style={s.subtitle}>Share your address to receive XMR</Text>

        <View style={s.card}>
          {/* QR Code */}
          <View style={s.qrBox}>
            <QrCode value={WALLET.address} size={200} />
          </View>

          {/* Address */}
          <View style={s.addrBox}>
            <Text style={s.addrLabel}>YOUR MONERO ADDRESS</Text>
            <Text style={s.addrText} selectable>
              {WALLET.address.slice(0, -5)}
              <Text style={{ color: colors.orange }}>{WALLET.address.slice(-5)}</Text>
            </Text>
          </View>

          <View style={s.btnRow}>
            <TouchableOpacity style={[s.copyBtn, copied && { backgroundColor: colors.success }]} onPress={handleCopy}>
              {copied ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Icon name="check" size={16} color="#FFF" strokeWidth={2.5} />
                  <Text style={s.copyBtnText}>Copied</Text>
                </View>
              ) : (
                <Text style={s.copyBtnText}>Copy address</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={s.shareBtn}>
              <Text style={s.shareBtnText}>Share</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={s.infoCard}>
          <View style={s.infoTitleRow}>
            <Icon name="lock" size={16} color={colors.textPrimary} />
            <Text style={s.infoTitle}>Privacy by Default</Text>
          </View>
          <Text style={s.infoText}>Every transaction is automatically private. Sender, recipient, and amount are never visible.</Text>
        </View>
        <View style={s.infoCard}>
          <View style={s.infoTitleRow}>
            <Icon name="lightbulb" size={16} color={colors.textPrimary} />
            <Text style={s.infoTitle}>Stealth Addresses</Text>
          </View>
          <Text style={s.infoText}>You can reuse the same address multiple times. Monero automatically generates one-time stealth addresses.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 60, paddingBottom: 100 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginTop: 4, marginBottom: 32 },
  card: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg, alignItems: "center", marginBottom: 24, borderWidth: 1, borderColor: colors.border },
  qrBox: { width: 200, height: 200, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", marginBottom: 24, overflow: "hidden" },
  addrBox: { width: "100%", backgroundColor: colors.bgInput, borderRadius: radius.md, padding: spacing.md, marginBottom: 20, borderWidth: 1, borderColor: colors.border },
  addrLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600", letterSpacing: 0.5, marginBottom: 8 },
  addrText: { color: colors.textPrimary, fontSize: 13, fontFamily: "monospace", lineHeight: 20 },
  btnRow: { flexDirection: "row", gap: 12, width: "100%" },
  copyBtn: { flex: 2, paddingVertical: 16, alignItems: "center", backgroundColor: colors.orange, borderRadius: radius.md },
  copyBtnText: { color: "#FFF", fontSize: 15, fontWeight: "700" },
  shareBtn: { flex: 1, paddingVertical: 16, alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight },
  shareBtnText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
  infoCard: { backgroundColor: colors.bgCard, borderRadius: radius.md, padding: spacing.lg, marginBottom: 12, borderWidth: 1, borderColor: colors.border },
  infoTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  infoTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  infoText: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
});
