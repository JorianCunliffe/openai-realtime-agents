import type { Metadata } from "next";
import "./globals.css";
import "./lib/envSetup";

import { geistSans } from "./fonts/geist-sans";
import { geistMono } from "./fonts/geist-mono";

export const metadata: Metadata = {
  title: "Realtime API Agents",
  description: "A demo app from OpenAI.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Suppress OpenTelemetry browser warnings
  if (typeof window !== 'undefined') {
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (args[0]?.includes?.('BatchTraceProcessor is not supported in the browser')) {
        return;
      }
      originalWarn.apply(console, args);
    };
  }

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}