import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LIE — LinkedIn Intelligence Engine",
  description: "AI-powered intelligence system for strategic LinkedIn presence by Rocket Code",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
