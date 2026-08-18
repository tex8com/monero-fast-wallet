export interface Transaction {
  id: string;
  type: "sent" | "received";
  amount: string;
  xmrAmount: string;
  address: string;
  date: string;
  status: "confirmed" | "pending";
}

export interface MarketplaceService {
  id: string;
  title: string;
  provider: string;
  category: string;
  price: string;
  rating: number;
  reviews: number;
  deliveryTime: string;
  avatar: string;
  featured?: boolean;
}

export const WALLET = {
  balance: "4.8521",
  balanceUsd: "782.40",
  pendingBalance: "0.1200",
  address:
    "48aBcD3fGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGh",
};

export const TRANSACTIONS: Transaction[] = [
  { id: "1", type: "received", amount: "+$128.50", xmrAmount: "+0.7960", address: "4A1BcD...xYz9", date: "Today, 14:32", status: "confirmed" },
  { id: "2", type: "sent",     amount: "-$45.00",  xmrAmount: "-0.2788", address: "8B2eF3...mN7k", date: "Today, 10:15", status: "confirmed" },
  { id: "3", type: "received", amount: "+$320.00", xmrAmount: "+1.9830", address: "4C3gH1...pQ8r", date: "Yesterday, 22:08", status: "confirmed" },
  { id: "4", type: "sent",     amount: "-$15.00",  xmrAmount: "-0.0930", address: "8D4iJ2...sT6u", date: "Yesterday, 18:45", status: "pending" },
  { id: "5", type: "received", amount: "+$200.00", xmrAmount: "+1.2400", address: "4E5kL3...vW4x", date: "Apr 12, 09:22", status: "confirmed" },
  { id: "6", type: "sent",     amount: "-$82.30",  xmrAmount: "-0.5100", address: "8F6mN4...yZ2a", date: "Apr 11, 16:10", status: "confirmed" },
];

export const MARKETPLACE_CATEGORIES = [
  "All", "Design", "Development", "Marketing", "Writing", "Video", "Security", "Consulting",
];

export const MARKETPLACE_SERVICES: MarketplaceService[] = [
  { id: "1", title: "Logo & Brand Design",  provider: "PixelAnon",  category: "Design",      price: "0.25 XMR", rating: 4.9, reviews: 127, deliveryTime: "3 days", avatar: "PA", featured: true },
  { id: "2", title: "React Native App",     provider: "CodeGhost",  category: "Development", price: "2.50 XMR", rating: 5.0, reviews: 43,  deliveryTime: "14 days", avatar: "CG", featured: true },
  { id: "3", title: "SEO Audit & Report",   provider: "ShadowSEO",  category: "Marketing",   price: "0.15 XMR", rating: 4.7, reviews: 89,  deliveryTime: "2 days", avatar: "SS" },
  { id: "4", title: "Whitepaper Writing",   provider: "CryptoQuill", category: "Writing",     price: "0.80 XMR", rating: 4.8, reviews: 56,  deliveryTime: "7 days", avatar: "CQ" },
  { id: "5", title: "Promo Video (60s)",    provider: "DarkCut",     category: "Video",       price: "0.40 XMR", rating: 4.6, reviews: 31,  deliveryTime: "5 days", avatar: "DC" },
  { id: "6", title: "Smart Contract Audit", provider: "ZeroTrace",   category: "Security",    price: "5.00 XMR", rating: 5.0, reviews: 18,  deliveryTime: "10 days", avatar: "ZT", featured: true },
  { id: "7", title: "Privacy Consulting",   provider: "VaultMind",   category: "Consulting",  price: "0.30/h",   rating: 4.9, reviews: 72,  deliveryTime: "Instant", avatar: "VM" },
  { id: "8", title: "UI/UX Redesign",       provider: "NeonAnon",    category: "Design",      price: "1.20 XMR", rating: 4.8, reviews: 64,  deliveryTime: "7 days", avatar: "NA" },
];
