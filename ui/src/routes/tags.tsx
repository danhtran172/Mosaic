import { createFileRoute } from "@tanstack/react-router";
import { AllsightProvider } from "@/lib/allsight/store";
import { TagManager } from "@/components/allsight/TagManager";

export const Route = createFileRoute("/tags")({
  head: () => ({
    meta: [
      { title: "Tag Manager — Allsight" },
      {
        name: "description",
        content: "Manage reusable Theme and Character property values used across your Allsight media library.",
      },
      { property: "og:title", content: "Tag Manager — Allsight" },
      {
        property: "og:description",
        content: "Create, rename and delete reusable tag properties for your visual library.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TagsPage,
});

function TagsPage() {
  return (
    <AllsightProvider>
      <TagManager />
    </AllsightProvider>
  );
}
