import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MSP Ops Agent",
  description: "Self-improving MSP operations agent on MongoDB Atlas",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
