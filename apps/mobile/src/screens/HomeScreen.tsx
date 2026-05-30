import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Dimensions, ActivityIndicator } from "react-native";
import Svg, { Path, Defs, LinearGradient as SvgGrad, Stop, Circle } from "react-native-svg";
import { colors } from "../theme/colors";
import { WALLET, TRANSACTIONS } from "../data/mock";
import MoneroLogo from "../components/MoneroLogo";
import { useXmrPrice, useXmrChart, xmrToUsd } from "../data/priceService";

const W = Dimensions.get("window").width;
const CHART_W = W - 40;
const CHART_H = 160;
const TIMEFRAMES = ["Today", "24H", "7D", "1M", "1Y", "Max"];

const xmrBalance = parseFloat(WALLET.balance);

/* ── SVG Chart ─────────────────────────────────────────────────────── */
function PriceChart({ points, positive }: { points: number[]; positive: boolean }) {
  if (points.length < 2) return null;
  const min = Math.min(...points) * 0.998;
  const max = Math.max(...points) * 1.002;
  const range = max - min || 1;
  const pad = 2;
  const stepX = (CHART_W - pad * 2) / (points.length - 1);

  let linePath = "";
  let areaPath = "";
  points.forEach((p, i) => {
    const x = pad + i * stepX;
    const y = pad + (CHART_H - pad * 2) - ((p - min) / range) * (CHART_H - pad * 2);
    if (i === 0) {
      linePath += `M${x},${y}`;
      areaPath += `M${x},${CHART_H}L${x},${y}`;
    } else {
      const px = pad + (i - 1) * stepX;
      const py = pad + (CHART_H - pad * 2) - ((points[i - 1] - min) / range) * (CHART_H - pad * 2);
      linePath += `C${px + stepX * 0.4},${py} ${x - stepX * 0.4},${y} ${x},${y}`;
      areaPath += `C${px + stepX * 0.4},${py} ${x - stepX * 0.4},${y} ${x},${y}`;
    }
  });
  areaPath += `L${pad + (points.length - 1) * stepX},${CHART_H}Z`;
  const lc = positive ? "#00D68F" : "#FF4466";
  const gid = positive ? "gG" : "gR";

  return (
    <Svg width={CHART_W} height={CHART_H}>
      <Defs>
        <SvgGrad id={gid} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={lc} stopOpacity="0.2" />
          <Stop offset="1" stopColor={lc} stopOpacity="0" />
        </SvgGrad>
      </Defs>
      <Path d={areaPath} fill={`url(#${gid})`} />
      <Path d={linePath} stroke={lc} strokeWidth={2} fill="none" />
      <Circle cx={pad + (points.length - 1) * stepX} cy={pad + (CHART_H - pad * 2) - ((points[points.length - 1] - min) / range) * (CHART_H - pad * 2)} r={4} fill={lc} />
    </Svg>
  );
}

/* ── Action Button Icons ───────────────────────────────────────────── */
function IcoUp({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M12 19V5M5 12l7-7 7 7" stroke={c} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></Svg>);
}
function IcoDown({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M12 5v14M5 12l7 7 7-7" stroke={c} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" /></Svg>);
}
function IcoGrid({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M10 3H3v7h7V3zM21 3h-7v7h7V3zM21 14h-7v7h7v-7zM10 14H3v7h7v-7z" stroke={c} strokeWidth={2} strokeLinejoin="round" /></Svg>);
}

/* ── Home Screen ─────────────────────────────────────────────────────── */
export default function HomeScreen({ navigation }: any) {
  const [tf, setTf] = useState("24H");
  const { price, change24h, loading: priceLoading } = useXmrPrice();
  const { points, loading: chartLoading } = useXmrChart(tf);

  const positive = tf === "24H" || tf === "Today"
    ? change24h >= 0
    : points.length >= 2 ? points[points.length - 1] >= points[0] : true;

  const changePercent = tf === "24H" || tf === "Today"
    ? change24h
    : points.length >= 2
      ? ((points[points.length - 1] - points[0]) / points[0]) * 100
      : 0;

  const changeUsd = price > 0 ? Math.abs(changePercent / 100 * price) : 0;
  const balanceUsd = price > 0 ? xmrToUsd(xmrBalance, price) : "—";

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerL}>
            <MoneroLogo size={26} />
            <Text style={s.headerT}>Monero<Text style={s.headerTOrange}>-Wallet</Text></Text>
          </View>
          <View style={s.syncBadge}>
            <View style={s.syncDot} />
            <Text style={s.syncTxt}>Live</Text>
          </View>
        </View>

        {/* Price */}
        <View style={s.priceSection}>
          {priceLoading ? (
            <ActivityIndicator color={colors.orange} size="large" style={{ marginVertical: 12 }} />
          ) : (
            <>
              <Text style={s.priceBig}>${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
              <View style={s.changeRow}>
                <Text style={[s.changeText, { color: positive ? colors.textGreen : colors.textRed }]}>
                  {positive ? "▲" : "▼"} {Math.abs(changePercent).toFixed(2)}%
                </Text>
                <Text style={[s.changeUsd, { color: positive ? colors.textGreen : colors.textRed }]}>
                  {positive ? "+" : "-"}${changeUsd.toFixed(2)}
                </Text>
              </View>
            </>
          )}
        </View>

        {/* Chart */}
        <View style={s.chartWrap}>
          {chartLoading || points.length < 2 ? (
            <View style={{ height: CHART_H, justifyContent: "center", alignItems: "center" }}>
              <ActivityIndicator color={colors.orange} />
            </View>
          ) : (
            <PriceChart points={points} positive={positive} />
          )}
        </View>

        {/* Timeframe Selector */}
        <View style={s.tfRow}>
          {TIMEFRAMES.map(t => (
            <TouchableOpacity key={t} style={[s.tfBtn, tf === t && s.tfBtnActive]} onPress={() => setTf(t)}>
              <Text style={[s.tfText, tf === t && s.tfTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Action Buttons */}
        <View style={s.actRow}>
          <TouchableOpacity style={s.actBtn} onPress={() => navigation.navigate("Send")} activeOpacity={0.7}>
            <View style={s.actCircle}><IcoUp c="#FFF" /></View>
            <Text style={s.actLabel}>Send</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actBtn} onPress={() => navigation.navigate("Receive")} activeOpacity={0.7}>
            <View style={s.actCircle}><IcoDown c="#FFF" /></View>
            <Text style={s.actLabel}>Receive</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actBtn} onPress={() => navigation.navigate("Marketplace")} activeOpacity={0.7}>
            <View style={[s.actCircle, s.actCircleAlt]}><IcoGrid c={colors.orange} /></View>
            <Text style={s.actLabel}>Services</Text>
          </TouchableOpacity>
        </View>

        {/* Balance Card */}
        <View style={s.balCard}>
          <Text style={s.balLabel}>My Balance</Text>
          <View style={s.balRow}>
            <Text style={s.balXmr}>{WALLET.balance} XMR</Text>
            <Text style={s.balUsd}>${balanceUsd}</Text>
          </View>
          {WALLET.pendingBalance !== "0" && (
            <View style={s.pendRow}>
              <View style={s.pendDot} />
              <Text style={s.pendTxt}>{WALLET.pendingBalance} XMR pending</Text>
            </View>
          )}
        </View>

        {/* Transactions */}
        <View style={s.secRow}>
          <Text style={s.secTitle}>Transactions</Text>
          <TouchableOpacity><Text style={s.secLink}>All</Text></TouchableOpacity>
        </View>

        {TRANSACTIONS.map(tx => {
          const isIn = tx.type === "received";
          const txXmr = parseFloat(tx.xmrAmount);
          const txUsdVal = price > 0 ? `$${Math.abs(txXmr * price).toFixed(2)}` : tx.amount;
          return (
            <View key={tx.id} style={s.txCard}>
              <View style={[s.txDot, { backgroundColor: isIn ? "rgba(0,214,143,0.12)" : "rgba(255,68,102,0.12)" }]}>
                <Text style={{ fontSize: 14, color: isIn ? colors.textGreen : colors.textRed }}>{isIn ? "↓" : "↑"}</Text>
              </View>
              <View style={s.txMid}>
                <Text style={s.txType}>{isIn ? "Received" : "Sent"}</Text>
                <Text style={s.txMeta} numberOfLines={1}>
                  <Text style={{ fontFamily: "monospace" }}>{tx.address.slice(0, -5)}<Text style={{ color: colors.orange }}>{tx.address.slice(-5)}</Text></Text>
                  {" · "}{tx.date}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={[s.txXmr, isIn && { color: colors.textGreen }]}>{tx.xmrAmount}</Text>
                <Text style={s.txFiat}>{isIn ? "+" : "-"}{txUsdVal}</Text>
              </View>
            </View>
          );
        })}
        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingTop: 58, marginBottom: 8 },
  headerL: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerT: { color: "#FFF", fontSize: 18, fontWeight: "700" },
  headerTOrange: { color: "#F26822" },
  syncBadge: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(0,214,143,0.1)", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 50, gap: 6 },
  syncDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  syncTxt: { color: colors.success, fontSize: 12, fontWeight: "600" },

  priceSection: { paddingHorizontal: 20, marginBottom: 8 },
  priceBig: { color: "#FFF", fontSize: 42, fontWeight: "800", letterSpacing: -1 },
  changeRow: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 10 },
  changeText: { fontSize: 16, fontWeight: "700" },
  changeUsd: { fontSize: 15, fontWeight: "500" },

  chartWrap: { paddingHorizontal: 20, marginBottom: 4 },

  tfRow: { flexDirection: "row", paddingHorizontal: 20, marginBottom: 24, gap: 6 },
  tfBtn: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 10, backgroundColor: "rgba(255,255,255,0.04)" },
  tfBtnActive: { backgroundColor: colors.orange },
  tfText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  tfTextActive: { color: "#FFF" },

  actRow: { flexDirection: "row", paddingHorizontal: 20, marginBottom: 24 },
  actBtn: { flex: 1, alignItems: "center" },
  actCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center" },
  actCircleAlt: { backgroundColor: "transparent", borderWidth: 2, borderColor: colors.orange },
  actLabel: { color: "rgba(255,255,255,0.6)", fontSize: 13, fontWeight: "600", marginTop: 10 },

  balCard: { marginHorizontal: 20, backgroundColor: colors.bgCard, borderRadius: 16, padding: 20, marginBottom: 24, borderWidth: 1, borderColor: colors.border },
  balLabel: { color: colors.textMuted, fontSize: 13, fontWeight: "500", marginBottom: 8 },
  balRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  balXmr: { color: "#FFF", fontSize: 26, fontWeight: "800" },
  balUsd: { color: colors.textSecondary, fontSize: 16, fontWeight: "500" },
  pendRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  pendDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.warning, marginRight: 6 },
  pendTxt: { color: colors.warning, fontSize: 12, fontWeight: "500" },

  secRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingHorizontal: 20 },
  secTitle: { color: "#FFF", fontSize: 17, fontWeight: "700" },
  secLink: { color: colors.orange, fontSize: 13, fontWeight: "600" },
  txCard: { flexDirection: "row", alignItems: "center", backgroundColor: colors.bgCard, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 14, marginBottom: 8, marginHorizontal: 20, borderWidth: 1, borderColor: colors.border },
  txDot: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", marginRight: 12 },
  txMid: { flex: 1, marginRight: 8 },
  txType: { color: "#FFF", fontSize: 14, fontWeight: "600" },
  txMeta: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  txXmr: { color: "#FFF", fontSize: 14, fontWeight: "700" },
  txFiat: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
});
