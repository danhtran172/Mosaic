import { createFileRoute } from "@tanstack/react-router";
import { AllsightProvider } from "@/lib/allsight/store";
import { AppShell } from "@/components/allsight/AppShell";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Allsight — Private Visual Media Library" },
      {
        name: "description",
        content:
          "Allsight is a private, local-first visual library for organizing images and videos with themes, characters, collections and groups.",
      },
      { property: "og:title", content: "Allsight — Private Visual Media Library" },
      {
        property: "og:description",
        content: "Organize local images and videos in a premium, private visual catalog.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <AllsightProvider>
      <AppShell />
    </AllsightProvider>
  );
}
