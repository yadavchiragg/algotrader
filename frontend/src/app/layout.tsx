import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AlgoTrader — Live SMA Crossover Engine",
  description: "Real-time algorithmic trading dashboard with WebSocket price streaming",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}