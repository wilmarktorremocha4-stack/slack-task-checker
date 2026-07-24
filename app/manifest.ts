import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Slack Tracker",
    short_name: "Slack Tracker",
    description: "Slack task assignment, follow-ups, and review workflow",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#060d24",
    theme_color: "#1565c0",
    orientation: "portrait",
    categories: ["productivity", "business"],
    icons: [
      {
        src: "/icon-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
