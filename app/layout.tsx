import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Offload — sell without the mental load",
  description: "An honest, one-tap resale listing assistant.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
