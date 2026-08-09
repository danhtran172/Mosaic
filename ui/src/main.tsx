import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AllsightProvider } from "./lib/allsight/store";
import { AppShell } from "./components/allsight/AppShell";
import { Toaster } from "./components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AllsightProvider>
      <AppShell />
      <Toaster richColors closeButton />
    </AllsightProvider>
  </StrictMode>,
);
