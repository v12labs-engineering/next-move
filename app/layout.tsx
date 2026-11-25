import type { Metadata } from "next"
import "@fontsource-variable/familjen-grotesk"
import "@fontsource-variable/ibm-plex-sans"
import "@fontsource-variable/jetbrains-mono"
import "./globals.css"
import { ThemeProvider } from "@/components/shell/theme-provider"

export const metadata: Metadata = {
  title: { default: "Next Move", template: "%s | Next Move" },
  applicationName: "Next Move",
  description:
    "Find relevant international roles and prepare applications using your own experience.",
  robots: { index: false, follow: false },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className="font-sans antialiased">
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
